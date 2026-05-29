# humanish

For the times your AI needs to act humanish.

A two-tier credential broker that lets you hand a Claude chat a single-use, scoped bearer to perform exactly one action against one of your logged-in services — without ever giving Claude a long-lived secret. The broker is a Cloudflare Worker on the public edge; the action runner sits behind it on a Fly.io machine that also hosts a [neko](https://github.com/m1k1o/neko) browser jail for the (rare) human login flows.

**Status:** MVP. Single-tenant by design — see the security model below.

The MVP plan lives in [`plans/2026-05-17-humanish-server.md`](plans/2026-05-17-humanish-server.md). The architecture rationale lives in [`reports/2026-05-14-humanish-server.md`](reports/2026-05-14-humanish-server.md).

---

## Security model

The whole point of humanish is to keep a secret (a logged-in cookie jar) out of the LLM context while still letting the LLM trigger an action that needs it. Five mechanisms work together.

### Two-tier architecture (broker + box)

The **broker** is a Cloudflare Worker (`packages/broker/`). It is the only thing on the public internet. It does session auth, mints bearers, hosts the dashboard, and proxies a tightly-restricted subset of operations to the box.

The **box** is a single Fly.io VM (`packages/box/`) that runs the [neko](https://github.com/m1k1o/neko) browser (for human login) and an action runner (Node + Fastify + Playwright). The action runner is exposed on a TLS-terminated public port (`8443` → internal `7654`) because Cloudflare Workers cannot reach Fly's private `*.flycast` hostnames. The actual defense is a shared 32-byte secret (`BOX_SHARED_SECRET`) carried as a bearer on every non-`/healthz` request, compared in constant time. TLS terminates at fly-proxy; the packet between fly-proxy and the runner stays inside the machine namespace.

### The human is the courier

When you click *Mint* in the dashboard, the broker generates a two-word EFF slug like `loving-quartz` and stashes a one-time skill markdown payload behind it. The slug page is rendered by the browser with a CSP that locks down all outbound network (`default-src 'none'; connect-src 'none'`).

**You — a human — must paste the slug URL into the Claude chat.** Claude must visit the URL itself through its own browsing tool. If Claude `WebFetch`-es the URL programmatically, the security model collapses: the response would just become token-burning context, and the slug burns immediately. The whole point is that the markdown is rendered exactly once, into the conversation, by the recipient.

**Operator rule: do NOT have Claude `WebFetch` the slug URL.**

### Single-use slugs (Durable Object atomic get-then-delete)

Each slug is backed by a `SlugBox` Durable Object. The `/consume` handler does `get` → `delete` in a single transaction with no intervening `await`, so concurrent reads see exactly one winner. A second visit gets a 410 "dead slug" page. CI greps `slug-box.ts` for any intervening `await` between the get and the delete and fails the build if one shows up.

### Bearer scoping

Every bearer issued by `/api/mint` is scoped to `(profile, action_id, payload_shape_hash, ttl)` with `max_calls=1`. The `payload_shape_hash` is the SHA-256 of the recursive type skeleton of the expected payload (keys + value types, no values). An attacker who steals the bearer cannot repurpose it for a different action, a different profile, a different field-set, or a second call. The bearer KV entry is deleted on first successful call.

### AES-GCM encrypted profiles, AAD = profile name

Profiles (Playwright `storageState` blobs containing cookies + localStorage) are written to disk encrypted with AES-256-GCM. The Additional Authenticated Data (AAD) is the profile name. If the encrypted blob is copied to a different filename, decryption fails — so a leaked blob cannot impersonate another profile without also stealing the encryption key.

The 32-byte master key (`HUMANISH_MASTER_KEY`) is set as a Worker secret on the broker and as a Fly secret on the box. The plaintext key never appears in logs, KV, or git.

---

## Repo structure

```
packages/
  broker/                      # Cloudflare Worker (TypeScript)
    src/
      worker.ts                # routes, /api/mint, /api/actions/*, slug redeem
      bearer.ts                # mint/verify bearer, rate limiting
      actions.ts               # ACTION_ALLOWLIST (must match box ACTION_REGISTRY)
      slug-box.ts              # SlugBox DO — atomic single-use storage
      session.ts, auth.ts      # magic-link auth + session cookies
      pages/                   # landing, dashboard, slug, dead-slug HTML
      skill-templates/         # per-action markdown blobs served at slug burn
  box/
    action-runner/src/
      server.ts                # Fastify HTTP server on ::1:7654
      audit.ts                 # /data/audit.log + daily rotation
      profile-store.ts         # AES-GCM encrypted profile read/write
      neko-bridge.ts           # CDP into the neko-driven Chromium
      actions/                 # one file per action; register in index.ts
    Dockerfile, fly.toml       # neko + action runner on a single Fly machine

scripts/
  check-action-allowlist.mjs   # CI guard: broker/box action sets must match
```

See [`packages/broker/`](packages/broker) and [`packages/box/`](packages/box) for the full source.

---

## Setup runbook

You need: a Cloudflare account, a Fly account, and a [Resend](https://resend.com) account (for magic-link auth).

### 0. Bootstrap secrets

Generate the two long-lived secrets once. Save them somewhere safe — losing the master key means losing every profile (see "Master-key-loss recovery" below).

```bash
openssl rand -base64 32   # → HUMANISH_MASTER_KEY (32 bytes base64)
openssl rand -hex 32      # → BOX_SHARED_SECRET (64 hex chars)
```

### 1. Cloudflare Worker (broker)

```bash
cd packages/broker
pnpm install

# Create the KV namespace. Paste the printed `id` into wrangler.toml under
# [[kv_namespaces]] binding = "KV".
wrangler kv namespace create KV

# Set secrets (non-interactive via STDIN).
echo -n "<resend-api-key>"     | wrangler secret put RESEND_API_KEY
echo -n "<humanish-master-key>" | wrangler secret put HUMANISH_MASTER_KEY
echo -n "<box-shared-secret>"   | wrangler secret put BOX_SHARED_SECRET
echo -n "humanish@yourdomain.com" | wrangler secret put FROM_EMAIL
echo -n "your-email@example.com" | wrangler secret put ALLOWED_EMAILS

# wrangler.toml [vars] (non-secret):
#   BOX_ORIGIN     = "https://humanish-box.fly.dev:8443"  (public TLS endpoint;
#                    Cloudflare Workers can't reach *.flycast hosts)
#   COOKIE_DOMAIN  = "<your-broker-subdomain>.workers.dev" (the workers.dev URL
#                    that wrangler deploy prints — it's not always "humanish-broker"
#                    if there's a collision)

wrangler deploy
```

> **Note on `RESEND_API_KEY`.** Until you set a real key, the broker logs the
> magic link to the Worker tail (visible via `wrangler tail`) instead of
> trying to send mail. This lets first sign-in work before you finish
> wiring Resend. Set a real key as soon as you have one.

### 2. Fly machine (box)

```bash
cd ../..   # back to repo root — fly deploy needs the repo root as build context

fly apps create humanish-box --org personal
fly volumes create humanish_data --size 3 --region sjc --app humanish-box

# Allocate IPs (workers.dev needs to reach over the public internet).
fly ips allocate-v4 --shared --app humanish-box
fly ips allocate-v6 --app humanish-box

# Secrets — HUMANISH_MASTER_KEY + BOX_SHARED_SECRET MUST match the broker's.
# Set both v2 (NEKO_PASSWORD, needed by the action runner's env schema) AND
# v3 (NEKO_MEMBER_MULTIUSER_*) neko vars. (Neko's upstream image bakes v2
# defaults that re-enable legacy mode; this is the known caveat below.)
fly secrets set \
  HUMANISH_MASTER_KEY="<paste>" \
  BOX_SHARED_SECRET="<paste>" \
  NEKO_PASSWORD="<choose a strong one>" \
  NEKO_MEMBER_PROVIDER="multiuser" \
  NEKO_MEMBER_MULTIUSER_USER_PASSWORD="<same neko password>" \
  NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD="<same neko password>" \
  NEKO_SESSION_API_TOKEN="<same as BOX_SHARED_SECRET>" \
  --app humanish-box --stage

fly deploy --config packages/box/fly.toml --dockerfile packages/box/Dockerfile --remote-only
```

Confirm the action runner is healthy:

```bash
curl -s https://humanish-box.fly.dev:8443/healthz
# → {"ok":true,"ts":"..."}
```

Confirm the bearer gate works:

```bash
curl -s https://humanish-box.fly.dev:8443/profiles
# → {"error":"unauthorized"}
curl -s -H "Authorization: Bearer <BOX_SHARED_SECRET>" \
       https://humanish-box.fly.dev:8443/profiles
# → {"profiles":[]}
```

### 3. First profile

Visit `https://<your-broker>.workers.dev/`, request a magic link, click through to the dashboard, click *Add profile*, give it a name (e.g. `google-personal`), and complete the login inside the embedded neko tab. Click *Save* — the dashboard tells the box to capture `storageState`, encrypt it, and write it under that name.

### 4. First mint

Click *Mint*, pick the profile, pick `google.whoami`, set a TTL (default 600s), and copy the slug URL. Paste it into a Claude chat and ask Claude to follow the instructions on the page. Claude visits the page, gets a one-time skill markdown payload with a single-call bearer, and calls `POST /api/actions/google-personal/google.whoami`. The broker forwards to the box, the box decrypts the profile, Playwright loads `myaccount.google.com`, and returns the signed-in email.

---

## Operating notes

### Do NOT have Claude `WebFetch` the slug URL

The slug burns on first visit. If Claude programmatically fetches the URL, the markdown ends up as token-consuming context that Claude has to re-interpret, and the slug is dead. The security model relies on the slug page rendering exactly once, in Claude's own browsing tool, into the conversation. If you find Claude trying to `WebFetch` the URL, paste it again with explicit instructions to open it in the browser tool.

### Adding a new action

1. Create `packages/box/action-runner/src/actions/<id>.ts`. Export a value with `id: "namespace.verb"` matching the filename. Implement `run({ storageStateJson, payload, requestId })`.
2. Register it in `packages/box/action-runner/src/actions/index.ts` (`ACTION_REGISTRY`).
3. Add the same `"namespace.verb"` string to `ACTION_ALLOWLIST` in `packages/broker/src/actions.ts`.
4. Add a skill markdown template under `packages/broker/src/skill-templates/<id>.md.template` and wire it in `worker.ts` `renderSkillMarkdown`.
5. Run `pnpm check:allowlist` — it will fail loudly if the broker and box sets diverge.
6. Run `pnpm -r typecheck`. Deploy both broker and box.

### Master-key-loss recovery

`HUMANISH_MASTER_KEY` is the only thing that can decrypt the profile blobs on the Fly volume. **If you lose it, the profiles are unrecoverable** — there is no backdoor, no escrow, no recovery code. The recovery story is straightforward but tedious:

1. Generate a fresh `HUMANISH_MASTER_KEY` and set it on both the Worker and the Fly machine.
2. Delete `/data/profiles/*.bin` on the Fly volume (`fly ssh console -C "rm /data/profiles/*.bin"`).
3. For each profile, repeat the *Add profile* dashboard flow — log into each service inside neko one more time.

Audit logs (`/data/audit*.log`) are unencrypted, so they survive a key rotation.

### Rate limits

- `/api/mint` is limited to 30 mints per hour per session cookie. Sliding window; the 31st call returns 429 with a `retry_after_seconds` field.
- Each minted bearer has `max_calls=1` and is consumed on first successful action call. There is no per-bearer RPS floor in MVP — see the note at the top of `bearer.ts` for the rationale.

### Audit log

Every action call appends a line to `/data/audit.log` on the Fly volume (tab-separated `iso\trequest_id\tprofile\taction_id\tstatus\tbytes`). Logs rotate daily (`audit-YYYY-MM-DD.log`) with 30-day retention; the active log is always `audit.log`. Payload contents are never written — only the status and the response byte count.

### Expired-cookie UX

When an action returns 503 `auth_expired` (the box noticed Playwright bounced to a login page), the broker writes `expired:<profile>` to KV for 30 days. The dashboard's profile list shows that profile as `status: "expired"` and surfaces a yellow banner with a *Reauth* button that runs the *Add profile* login flow again.

---

## Known caveats

### Neko v2 legacy mode is active

The upstream `ghcr.io/m1k1o/neko/chromium:latest` image bakes `NEKO_MEMBER_MULTIUSER_USER_PASS` (no `_WORD`, v2 syntax) into the image at build time. Setting it via Fly secrets — even with the v3 name — does not unset the image-level default, and the v2 env var is enough to trigger neko's "legacy configuration is enabled" mode, which silently ignores `plugins.config.chat.enabled: false` and `plugins.config.filetransfer.enabled: false` in `neko.yaml`. Chat and file-transfer plugins therefore start in spite of the YAML.

For a single-user MVP this is not a security defect: the dashboard embeds neko in an `allow-same-origin allow-scripts allow-forms` iframe (no `allow-top-navigation`, no `allow-popups`), so a malicious page inside neko cannot pop the iframe. The chat plugin needs a second user (there isn't one). The file-transfer plugin would only let the operator move files to/from the box — they already control the box.

The fix is to fork the upstream image with `ENV NEKO_MEMBER_MULTIUSER_USER_PASS=` (empty) baked at build time, or to pin a future neko release where this is configurable. Tracked as a follow-up.

### Resend placeholder bypass

When `RESEND_API_KEY` starts with `re_PLACEHOLDER_`, `auth.ts` skips the Resend API call and logs the magic URL via `wrangler tail`. This is intentional: it lets first sign-in work on a fresh deploy before the operator has finished wiring Resend. Replace the secret with a real key before sharing the broker URL with anyone else.

### IPv6 bind dropped

The action runner originally bound `[::1]:7654` per the plan's "Flycast-only" model. Workers cannot reach `*.flycast`, so it now binds `0.0.0.0:7654` and is exposed as a public TLS port — gated by `BOX_SHARED_SECRET`. The bearer + TLS combo is the actual defense; the bind change does not weaken the threat model for the documented scope (single operator behind a sole shared secret).

---

## Single-tenant constraint

MVP is operator-only. Auth is a single allowlist (`ALLOWED_EMAILS`), the master key is shared across every profile on the box, and there is no per-tenant isolation in the action runner. **Multi-tenant is explicitly out of scope** — when humanish needs to host anyone but the operator, that is a separate plan.

---

## License

Apache 2.0. See [`LICENSE`](LICENSE).
