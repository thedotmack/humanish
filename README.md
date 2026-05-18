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

The **box** is a single Fly.io VM (`packages/box/`) that runs the [neko](https://github.com/m1k1o/neko) browser (for human login) and an action runner (Node + Fastify + Playwright). The action runner binds to IPv6 loopback (`::1`) and is reachable only by the broker over Fly's private network (Flycast). The internet cannot route packets to it at all. Auth between broker and box is a shared 32-byte secret compared in constant time.

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
wrangler kv:namespace create KV

# Set secrets.
wrangler secret put RESEND_API_KEY        # from resend.com
wrangler secret put HUMANISH_MASTER_KEY   # generated above
wrangler secret put BOX_SHARED_SECRET     # generated above

# Set vars in wrangler.toml [vars]:
#   BOX_ORIGIN      = "https://humanish-box.flycast:7654"
#   COOKIE_DOMAIN   = "humanish-broker.workers.dev" (or your apex)
#   FROM_EMAIL      = "humanish@yourdomain.com"
#   ALLOWED_EMAILS  = "your-email@example.com" (comma-separated, case-insensitive)

wrangler deploy
```

### 2. Fly machine (box)

```bash
cd ../box
fly launch -c fly.toml --no-deploy   # accept name 'humanish-box' or pick your own
fly volumes create humanish_data --size 1 --region sjc

# Same two secrets, plus neko's own password.
fly secrets set HUMANISH_MASTER_KEY="<paste>" \
                BOX_SHARED_SECRET="<paste>" \
                NEKO_PASSWORD="<choose a strong one>"

fly deploy
```

Confirm the action runner is healthy:

```bash
fly ssh console -C "curl -s http://[::1]:7654/healthz"
# → {"ok":true,"ts":"..."}
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

## Single-tenant constraint

MVP is operator-only. Auth is a single allowlist (`ALLOWED_EMAILS`), the master key is shared across every profile on the box, and there is no per-tenant isolation in the action runner. **Multi-tenant is explicitly out of scope** — when humanish needs to host anyone but the operator, that is a separate plan.

---

## License

Apache 2.0. See [`LICENSE`](LICENSE).
