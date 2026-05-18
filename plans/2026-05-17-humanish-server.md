# Plan: humanish server — single-user MVP that demos the security model end-to-end

**Date:** 2026-05-17
**Repo:** `/Users/alexnewman/.superset/projects/humanish/` (github.com/thedotmack/humanish)
**Status entering this plan:** Repo contains README, LICENSE, `.gitignore`, prior design notes in `reports/`, and a `.scratch/byoky/` clone used only as a code reference. No source code yet.

---

## Cold-read context (one paragraph)

humanish is a two-tier credential broker. **Tier 1** is a Cloudflare Worker on the public edge that issues two-word EFF Long slugs, renders single-use HTML pages containing skill markdown, and proxies bearer-scoped action calls into the private network. **Tier 2** is a single Fly.io VM that hosts (a) [neko](https://github.com/m1k1o/neko) — a WebRTC-streamed Chromium for human-driven logins — and (b) a Node action-runner that decrypts AES-GCM-encrypted browser-session blobs and runs Playwright actions against ephemeral contexts. The load-bearing security idea: **the human is the courier**. Claude's web chat will not (and structurally cannot) fetch a slug URL and execute its contents — Claude Code routes non-allowlisted `WebFetch` calls through a Haiku pre-summarizer that strips instructions. So the user opens the slug URL in their own tab, copies the rendered skill markdown, pastes it into the chat. The paste *is* the authorization. Each slug is single-use (Durable Object atomic get-then-delete), each bearer is `max_calls=1` and scoped to `(profile, action_id, payload_shape_hash, ttl)`.

## What this plan ships

The minimum surface needed to demo the security model end-to-end:

1. A working Cloudflare Worker broker with magic-link auth, slug mint, single-use redemption, bearer issuance, and action proxy.
2. A working Fly.io box with neko, encrypted profile storage, and a Node action runner.
3. A dashboard SPA that ties browser-jail login → profile save → slug mint into one flow.
4. **One trivial action** — `google.whoami` — which fetches `https://myaccount.google.com/` using a saved profile's `storageState`, extracts the logged-in email, and returns it. This is the proof-of-life: it exercises every part of the security loop in under 10 seconds, with no PDF generation, no third-party API uploads, and no NotebookLM dependency.

Richer actions (NotebookLM slide-deck generation, X post, Slack send) are deliberately out of scope. They are application-level work on top of a working broker; lump them into a later "actions catalog" plan after the security model has been proven.

## What this plan does NOT cover

- Multi-tenant hosting, per-user containers, per-user key derivation.
- A public action catalog or app marketplace.
- Residential proxy support.
- NotebookLM, X, Slack, or any cookie-based service beyond `google.whoami`.
- Cloudflare DNS + custom domain (`*.workers.dev` is fine through Phase 7).
- Anything outside the humanish repository.

---

## Phase 0 — Documentation discovery (read before touching code)

### Allowed APIs and patterns

**Cloudflare Workers + Durable Objects + KV.**
- `env.SLUG_NS.idFromName(slug)` + `env.SLUG_NS.get(id).fetch(...)` — routes one slug to one DO instance, serializing concurrent requests. https://developers.cloudflare.com/durable-objects/
- Inside the DO, atomic single-use: `await storage.get(key)` followed by `await storage.delete(key)` **with no other intervening `await`** is automatically atomic per Cloudflare docs ("Any series of write operations with no intervening `await` will automatically be submitted atomically"). https://developers.cloudflare.com/durable-objects/api/storage-api/
- `env.KV.put(key, value, { expirationTtl: <seconds> })` for short-lived bearers and magic-link tokens. KV is eventually consistent — never use it for single-use guarantees, only for time-bounded lookups.

**Node WebCrypto AES-GCM** (`globalThis.crypto.subtle`, stable since Node 15, zero deps).
- Reference implementation pattern in `.scratch/byoky/packages/core/src/crypto.ts` — specifically the `encryptWithKey` / `decryptWithKey` functions, which use a pre-derived key plus a per-encryption 12-byte IV with blob layout `[12B IV][ciphertext+tag]`.
- humanish difference: we add **AAD = profile name** to bind the ciphertext to its filename, so an attacker who swaps `google-personal.bin` for `google-attacker.bin` gets an authentication failure on decrypt instead of a successful key swap.
- Final blob layout: `[12B IV][AES-GCM ciphertext+tag]`. Key is a 32-byte secret (`HUMANISH_MASTER_KEY`, Fly secret, base64).
- Constraint: byoky's `crypto.ts` is MIT-licensed; humanish is Apache 2.0. Copying the file requires preserving the MIT copyright header alongside the Apache header. Cleaner option: re-implement in ~30 lines based on the Web Crypto API directly. Pick re-implementation.

**neko (m1k1o/neko).**
- Repo: https://github.com/m1k1o/neko (~20k stars, v3.1.0 April 2026).
- Prebuilt image: `ghcr.io/m1k1o/neko/chromium:latest`.
- Single-user config: https://neko.m1k1o.net/docs/v3/getting-started
- Embedding via iframe: https://neko.m1k1o.net/docs/v3/installation/embed
- Chromium debug port: bind to `127.0.0.1:9223` only. Playwright connects via `chromium.connectOverCDP("http://127.0.0.1:9223")`. https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp

**Playwright `storageState`.**
- Capture: `await context.storageState({ indexedDB: true })`. The `indexedDB: true` opt-in is required for any service that stores tokens in IndexedDB (Firebase Auth, some Google flows). Playwright v1.51+.
- Restore: `await browser.newContext({ storageState })`.
- Shape: `{ cookies: [{name, value, domain, path, expires, httpOnly, secure, sameSite, partitionKey?}], origins: [{origin, localStorage: [{name, value}]}] }`.
- `sessionStorage` is NOT captured. Acceptable for humanish — actions tolerate session-storage being absent.
- Reference: https://playwright.dev/docs/api/class-browsercontext#browser-context-storage-state

**EFF Long wordlist.**
- 7,776 words, CC-BY 3.0, from EFF Diceware (https://www.eff.org/dice). Two words give ~60M combinations.
- Bundle as a TypeScript array at Worker build time (not in KV — wordlist is constant). One file: `packages/broker/src/wordlist.ts` exporting `EFF_LONG: readonly string[]`.
- Retry on slug collision in `/api/mint` (max 3 retries against the Durable Object's `/claim`).

**Magic-link auth (Resend).**
- Resend transactional email API: `POST https://api.resend.com/emails` with `Authorization: Bearer ${RESEND_API_KEY}`, body `{from, to, subject, html}`. https://resend.com/docs/api-reference/emails/send-email
- humanish writes its own implementation (~150 lines) rather than depending on any external code. Pattern: mint a 32-hex-char token → KV `magic:<token>` with 15-min TTL → email a link `https://humanish.example/api/auth/verify?token=<token>` → on visit, consume the token (`KV.delete`), create a 30-day session, set HttpOnly Secure SameSite=Lax cookie `humanish_session`.
- Session storage: `session:<sha256(token)>` in KV with 30-day TTL, value = `{email, created_at}`. The cookie carries the raw token; the lookup hashes it. This prevents a KV dump from yielding usable cookies.

**Byoky reference files (cherry-pick only — humanish is Apache 2.0, byoky is MIT, copyright headers must be preserved if copying).**
- `.scratch/byoky/packages/core/src/crypto.ts` — AES-GCM reference (re-implement, do not copy).
- `.scratch/byoky/packages/core/src/proxy-utils.ts` — `FORWARDABLE_HEADERS` allow-list and `validateProxyUrl` boundary-enforcement pattern. Lift the **idea** (allow-list rather than deny-list for proxied headers), re-implement in humanish style.
- `.scratch/byoky/packages/core/src/gift.ts` — bearer envelope and budget/expiry validation. Reference for shape only; humanish's bearer lives in KV, not in a base64url URL envelope.

**Fly.io.**
- Single VM with one volume. https://fly.io/docs/volumes/overview/
- Private networking via Flycast: from the Worker, the box is reachable at `humanish-box.flycast:7654` (or `humanish-box.internal:7654` from another Fly app). The Worker reaches Fly via the `fetch()` binding plus a Fly Machines proxy origin. https://fly.io/docs/networking/flycast/
- Secrets are app-scoped (shared across all machines in the app). For single-user MVP this is fine — there's only one machine.
- Machine type: `shared-cpu-2x` with 2 GB RAM minimum (neko's Chromium is memory-hungry).
- Two ports: internal `7654` for the action runner (NOT public, served via Flycast), public `8080` for neko WebRTC.

### Anti-patterns to avoid (will be grep-checked in the verification phase)

- **Do NOT** have Claude `WebFetch` the slug URL. Document this in the README. The user must visit the slug URL in their own browser and paste the markdown.
- **Do NOT** put `HUMANISH_MASTER_KEY`, `BOX_SHARED_SECRET`, or `RESEND_API_KEY` into served HTML, skill markdown templates, or client-side JS.
- **Do NOT** use KV alone for slug single-use. Use a Durable Object.
- **Do NOT** persist decrypted `storage_state.json` to the action runner's disk. Decrypt in-memory, hand to Playwright, drop the buffer.
- **Do NOT** bind the action-runner HTTP port to `0.0.0.0`. Bind to `[::1]:7654` only; only the broker reaches it over Flycast.
- **Do NOT** include `allow-top-navigation` in the dashboard's neko iframe sandbox.
- **Do NOT** support arbitrary upstream services. Hardcoded `ACTION_ALLOWLIST` of one (`google.whoami`) in MVP.
- **Do NOT** colocate browser sessions across users. Single-tenant MVP only.

---

## Phase 1 — Repo scaffold

### What to implement

**1.1 Workspace.** Add pnpm workspace at the repo root.

```
humanish/
  package.json                       # workspaces declaration, top-level scripts
  pnpm-workspace.yaml
  tsconfig.base.json
  README.md                          # already exists
  LICENSE                            # already exists (Apache 2.0)
  .gitignore                         # already exists
  packages/
    broker/                          # Cloudflare Worker (Tier 1)
      package.json
      tsconfig.json
      wrangler.toml
      src/
        worker.ts                    # entrypoint
        slug-box.ts                  # Durable Object
        wordlist.ts                  # EFF Long bundled as TS array
        auth.ts                      # magic-link auth (Resend)
        session.ts                   # cookie + session KV helpers
        crypto-util.ts               # sha256, randomToken, hex helpers
        bearer.ts                    # bearer issuance + verification
        actions.ts                   # ACTION_ALLOWLIST + payload shape hash
        skill-templates/
          google.whoami.md.template  # skill markdown for the one MVP action
        pages/
          landing.html
          dashboard.html             # vanilla JS, no framework
          slug.html.template
          dead-slug.html
        env.d.ts                     # types for env bindings
    box/                             # Fly.io container (Tier 2)
      Dockerfile
      fly.toml
      .dockerignore
      action-runner/
        package.json
        tsconfig.json
        src/
          server.ts                  # Fastify on [::1]:7654
          crypto.ts                  # AES-GCM encrypt/decrypt (~30 LOC)
          profile-store.ts           # read/write /data/profiles/*.bin
          neko-bridge.ts             # CDP attach, storageState capture
          actions/
            google.whoami.ts         # the one MVP action
            index.ts                 # action registry + dispatcher
          audit.ts                   # append-only /data/audit.log writer
          env.ts                     # parse + validate process.env
```

**1.2 Top-level scripts** in root `package.json`:

```json
{
  "name": "humanish",
  "private": true,
  "scripts": {
    "broker:dev": "pnpm --filter broker dev",
    "broker:deploy": "pnpm --filter broker deploy",
    "box:dev": "pnpm --filter @humanish/action-runner dev",
    "box:build": "docker build -f packages/box/Dockerfile -t humanish-box:dev .",
    "box:deploy": "fly deploy -c packages/box/fly.toml",
    "typecheck": "pnpm -r typecheck",
    "lint": "pnpm -r lint"
  }
}
```

**1.3 `wrangler.toml` skeleton** (no real IDs yet — fill during Phase 2 deploy):

```toml
name = "humanish-broker"
main = "src/worker.ts"
compatibility_date = "2026-04-01"
compatibility_flags = ["nodejs_compat"]

[[durable_objects.bindings]]
name = "SLUG_NS"
class_name = "SlugBox"

[[migrations]]
tag = "v1"
new_classes = ["SlugBox"]

[[kv_namespaces]]
binding = "KV"
id = "PLACEHOLDER"   # filled by `wrangler kv:namespace create KV`

[vars]
BOX_ORIGIN = "https://humanish-box.flycast:7654"
COOKIE_DOMAIN = "humanish-broker.workers.dev"  # change when custom domain wired
```

### Verification

- `pnpm install` succeeds at repo root.
- `pnpm typecheck` passes against empty/stub files.
- `git status` shows the new scaffold; nothing in `data/`, `*.bin`, or `storage_state*.json` (covered by existing `.gitignore`).

### Anti-pattern guards

- No source files outside `packages/broker/` or `packages/box/`.
- No `node_modules` committed (covered by `.gitignore`).

---

## Phase 2 — Broker: auth, slug mechanics, bearer issuance (the security core)

### What to implement

**2.1 Magic-link auth in `packages/broker/src/auth.ts` + `session.ts`.** Five public functions, all typed.

- `sendMagicLinkEmail(env, email, magicUrl): Promise<void>` — POST to `https://api.resend.com/emails` with `Authorization: Bearer ${env.RESEND_API_KEY}`, `from: env.FROM_EMAIL`, plaintext body containing `magicUrl`.
- `mintMagicToken(env, email): Promise<string>` — 32-char hex via `crypto.getRandomValues(new Uint8Array(16))`, `KV.put("magic:" + token, email, { expirationTtl: 900 })`, returns token.
- `consumeMagicToken(env, token): Promise<string | null>` — `KV.get("magic:" + token)` then `KV.delete(...)` (KV is eventually consistent, but a one-shot magic token replay window of seconds is acceptable; the corresponding session creation is atomic enough for MVP).
- `createSession(env, email): Promise<string>` — 32-char hex token, store under `session:<sha256(token)>` with 30-day TTL, value `{email, created_at}`. Returns the raw token.
- `readSessionUser(req, env): Promise<{email: string} | null>` — parses `Cookie` header, extracts `humanish_session=<token>`, computes sha256, looks up.
- `buildSessionCookie(token, domain): string` — formats `humanish_session=<token>; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax; Domain=<domain>`.

Configurable allowlist: `env.ALLOWED_EMAILS` (comma-separated). `POST /api/auth/request` rejects emails not in the list (single-user MVP — operator only).

**2.2 SlugBox Durable Object** in `packages/broker/src/slug-box.ts`.

```ts
export class SlugBox {
  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/claim") {
      const existing = await this.state.storage.get("v");
      if (existing) return new Response(null, { status: 409 });
      const payload = await req.json();
      await this.state.storage.put("v", payload);
      return new Response(null, { status: 201 });
    }
    if (req.method === "GET" && url.pathname === "/consume") {
      const v = await this.state.storage.get("v");
      if (!v) return new Response(null, { status: 410 });
      await this.state.storage.delete("v");                  // <-- no intervening await
      return Response.json(v);
    }
    return new Response(null, { status: 404 });
  }
}
```

The `/consume` get-then-delete pair must be uninterrupted by any other `await`. The plan requires a CI grep guard in Phase 7 to enforce this.

**2.3 Bearer issuance** in `packages/broker/src/bearer.ts`.

- `payloadShapeHash(payload: unknown): string` — recursively walks `payload`, replaces all leaf values with their type name (`"string"`, `"number"`, `"boolean"`, `"null"`), sorts object keys, JSON-stringifies, sha256-hexes. Two payloads with the same fields + same types but different *values* produce the same hash. Two payloads with a different shape produce different hashes.
- `mintBearer(env, scope: {profile, action_id, payload_shape_hash, ttl_seconds}): Promise<string>` — 32-char hex, `KV.put("bearer:" + token, JSON.stringify({...scope, max_calls_remaining: 1}), { expirationTtl: ttl_seconds })`, returns token.
- `verifyBearer(env, token, profile, action_id, payload): Promise<{ok: true} | {ok: false, code, status}>` — KV lookup; check scope match; check `payloadShapeHash(payload)` matches stored hash; check `max_calls_remaining > 0`; decrement (atomically by `KV.put` with the new count, then `KV.delete` if now 0). On any mismatch return a typed error.

KV is eventually consistent — the bearer can in theory be replayed in the consistency-window after decrement. For MVP this is acceptable (1-second window, max_calls=1, single-user). Document it. Phase 7 hardening replaces KV-based bearer state with a Durable Object if consistency proves a problem.

**2.4 Routes** in `packages/broker/src/worker.ts`:

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET /` | landing page | none | Static HTML from `pages/landing.html` |
| `GET /dashboard` | dashboard SPA | session cookie | Static HTML from `pages/dashboard.html`; redirects to `/` if no session |
| `POST /api/auth/request` | send magic link | none | Body `{email}`. Rejects emails not in `ALLOWED_EMAILS` |
| `GET /api/auth/verify` | redeem magic link | token in URL | Sets `humanish_session` cookie, 302s to `/dashboard` |
| `GET /api/me` | session info | session cookie | Returns `{email}` |
| `GET /api/profiles` | list profiles | session cookie | Proxies `GET ${BOX_ORIGIN}/profiles` with `Authorization: Bearer ${BOX_SHARED_SECRET}` |
| `POST /api/profiles/:name/start-login` | open browser jail | session cookie | Proxies to box; returns `{neko_url}` |
| `POST /api/profiles/:name/save` | finalize profile | session cookie | Proxies to box; box captures `storageState`, encrypts, writes atomically |
| `DELETE /api/profiles/:name` | delete profile | session cookie | Proxies to box |
| `POST /api/mint` | mint slug | session cookie | Body `{profile, action_id, payload_shape, ttl_seconds}`. Returns `{slug, url}` |
| `GET /:slug` | redeem slug (browser visit) | none | DO `/consume` — 200 renders HTML; 410 renders dead-slug page |
| `POST /api/actions/:profile/:action_id` | action call | Bearer (slug-bound) | Verify bearer; proxy to box `/run`; stream response |

**2.5 `/api/mint` flow** — the security choreography in one place:

1. Validate session cookie; resolve user email.
2. Body: `{profile, action_id, payload_shape, ttl_seconds}`. Validate `action_id` is in `ACTION_ALLOWLIST`. Validate `ttl_seconds` is in `[60, 86400]`.
3. Compute `payload_shape_hash = payloadShapeHash(payload_shape)`.
4. Mint bearer: `bearer = await mintBearer(env, {profile, action_id, payload_shape_hash, ttl_seconds})`.
5. Roll a slug from `EFF_LONG` (two words joined by `-`). Render skill markdown via template substitution (Phase 5). POST it to `env.SLUG_NS.get(idFromName(slug)).fetch("/claim", { method: "POST", body: JSON.stringify({markdown, bearer, profile, action_id, payload_shape_hash, ttl_expires_at, max_calls: 1}) })`. Retry up to 3 times on 409.
6. Return `{slug, url}`. Dashboard puts the URL in clipboard.

**2.6 `GET /:slug` flow:**

1. Validate slug shape: `/^[a-z]+-[a-z]+$/` AND both words in `EFF_LONG` (Set lookup at module init).
2. DO `/consume` — 200 → render slug HTML; 410 → render dead-slug page.
3. `Cache-Control: no-store` on the response. Critical — caching a slug-burn response would expose the markdown after the slug is dead.

**2.7 `POST /api/actions/:profile/:action_id` flow:**

1. Extract bearer from `Authorization: Bearer <token>`.
2. `verifyBearer` against the URL params and the request body.
3. On success, forward to box: `POST ${BOX_ORIGIN}/run` with `Authorization: Bearer ${BOX_SHARED_SECRET}`, body `{profile, action_id, payload, request_id}`. Stream the response back unchanged. `request_id` is a fresh ULID.
4. Log only `{request_id, profile, action_id, status, ms}` — never payload contents.

### Documentation references

- Cloudflare Workers: https://developers.cloudflare.com/workers/
- DO atomic single-use: https://developers.cloudflare.com/durable-objects/api/storage-api/
- Resend send API: https://resend.com/docs/api-reference/emails/send-email
- Cookie spec: https://datatracker.ietf.org/doc/html/rfc6265

### Verification

- `wrangler dev` locally. `POST /api/auth/request` with an allowlisted email sends a real email (or logs the magic link in dev).
- `GET /api/auth/verify?token=<>` sets the cookie and 302s.
- `POST /api/mint` (with cookie) against a stub box returns `{slug, url}`.
- `GET /<slug>` twice — first returns 200 with HTML, second returns 410.
- 100 parallel `GET /<slug>` curls — exactly one returns 200, 99 return 410. (Smoke-tests DO atomicity.)
- `POST /api/actions/.../...` with a fresh bearer succeeds; replay with the same bearer returns 401.
- `POST /api/actions/...` with a payload whose *shape* differs from the bearer's scope returns 400 `payload_shape_mismatch`.

### Anti-pattern guards

```bash
# SlugBox /consume must have no intervening await between get and delete
git grep -nE 'await' packages/broker/src/slug-box.ts
# (read each match; the get/delete pair must be back-to-back)

# Secrets must never appear in pages or templates
git grep -nE '(RESEND_API_KEY|HUMANISH_MASTER_KEY|BOX_SHARED_SECRET)' \
  packages/broker/src/pages/ packages/broker/src/skill-templates/
# (zero matches)

# Action proxy must not log payload
git grep -nE 'console\.(log|info|warn|error).*payload' packages/broker/src/
# (zero matches)
```

---

## Phase 3 — Box: container, encrypted profile storage, action runner

### What to implement

**3.1 `packages/box/Dockerfile`** — base on neko's chromium image, layer Node 20 and the action runner.

```dockerfile
FROM ghcr.io/m1k1o/neko/chromium:latest

# Node 20 via NodeSource
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

# Action runner
WORKDIR /opt/action-runner
COPY packages/box/action-runner/package.json packages/box/action-runner/package-lock.json* ./
RUN npm ci --omit=dev
COPY packages/box/action-runner/dist ./dist
COPY packages/box/action-runner/src ./src

# Entrypoint: start neko in background, exec action runner in foreground
COPY packages/box/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 7654 8080
ENTRYPOINT ["/entrypoint.sh"]
```

`entrypoint.sh`:
```sh
#!/usr/bin/env sh
set -e
/usr/bin/neko --config /etc/neko.yaml &
NEKO_PID=$!
exec node /opt/action-runner/dist/server.js
```

**3.2 neko config** at `/etc/neko.yaml` (copied in via Dockerfile):
- Single-user mode (one password, set via env at startup — operator-only access).
- CDP debug port bound to `127.0.0.1:9223`. NOT exposed publicly.
- Disable file uploads / downloads through the neko UI (the user must not be able to exfiltrate via the jail).
- Screen size 1280×720.

**3.3 `fly.toml`** at `packages/box/fly.toml`:

```toml
app = "humanish-box"
primary_region = "sjc"

[build]
  dockerfile = "packages/box/Dockerfile"

[[mounts]]
  source = "humanish_data"
  destination = "/data"

[[services]]
  internal_port = 7654
  protocol = "tcp"
  # Action runner — Flycast only, NO http_service block, NO public ports
  [[services.ports]]
    handlers = []
    port = 7654

[[services]]
  internal_port = 8080
  protocol = "tcp"
  # neko WebRTC — public
  [[services.ports]]
    handlers = ["http", "tls"]
    port = 443

[[vm]]
  size = "shared-cpu-2x"
  memory = "2gb"
```

Fly secrets to set (`fly secrets set ...`):
- `HUMANISH_MASTER_KEY` — 32-byte base64.
- `BOX_SHARED_SECRET` — 32-byte hex (must equal the Worker's `BOX_SHARED_SECRET`).
- `NEKO_PASSWORD` — random; only the operator knows it (the dashboard never asks for it because neko is only ever embedded in an authed iframe — the password is plumbed in via the embed URL hash).

**3.4 AES-GCM crypto** in `packages/box/action-runner/src/crypto.ts` (~30 LOC, self-contained, no dependencies):

```ts
const KEY_PROMISE = (async () => {
  const raw = Buffer.from(process.env.HUMANISH_MASTER_KEY!, "base64");
  if (raw.length !== 32) throw new Error("HUMANISH_MASTER_KEY must be 32 bytes base64");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
})();

export async function encryptProfile(profileName: string, plaintext: string): Promise<Buffer> {
  const key = await KEY_PROMISE;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode(profileName);
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad },
    key,
    new TextEncoder().encode(plaintext),
  ));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv, 0);
  out.set(ct, 12);
  return Buffer.from(out);
}

export async function decryptProfile(profileName: string, blob: Buffer): Promise<string> {
  const key = await KEY_PROMISE;
  const iv = blob.subarray(0, 12);
  const ct = blob.subarray(12);
  const aad = new TextEncoder().encode(profileName);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: aad },
    key,
    ct,
  );
  return new TextDecoder().decode(pt);
}
```

**3.5 Profile storage** in `packages/box/action-runner/src/profile-store.ts`:

- `listProfiles(): Promise<string[]>` — `readdir("/data/profiles")`, filter `*.bin`, return basenames stripped.
- `readProfile(name): Promise<string>` — read file → `decryptProfile(name, blob)` → return plaintext JSON.
- `writeProfileAtomic(name, plaintextJson): Promise<{bytes: number}>` — `encryptProfile(name, plaintextJson)` → write to `/data/profiles/<name>.bin.tmp` → `rename` to `.bin` (atomic on Linux). Return ciphertext byte count.
- `deleteProfile(name): Promise<void>` — `unlink`.

**3.6 Action runner HTTP server** in `packages/box/action-runner/src/server.ts`. Use Fastify (small, well-typed). Bind to `[::1]:7654`.

Routes:

| Method | Path | Auth | Returns |
|---|---|---|---|
| `GET /healthz` | none | `{ok, ts}` |
| `GET /profiles` | shared-secret bearer | `{profiles: [{name, has_blob, mtime}]}` |
| `POST /profiles/:name/start-login` | shared-secret bearer | `{neko_url, neko_password_hint}` |
| `POST /profiles/:name/save` | shared-secret bearer | `{ok, profile, bytes}` — CDP-attaches to neko, captures `storageState`, encrypts, writes atomically |
| `DELETE /profiles/:name` | shared-secret bearer | `{ok}` |
| `POST /run` | shared-secret bearer | streamed result of action handler |

Auth middleware: every route except `/healthz` requires `Authorization: Bearer ${BOX_SHARED_SECRET}` (constant-time compare).

**3.7 `/run` dispatcher.** Body `{profile, action_id, payload, request_id}`.

1. Look up `action_id` in the registry (`packages/box/action-runner/src/actions/index.ts`). 404 if unknown.
2. Read + decrypt the profile.
3. Hand `{payload, storageStateJson, env, requestId}` to the action handler.
4. Stream the JSON result back.
5. Append one audit line to `/data/audit.log`: `<iso>\t<request_id>\t<profile>\t<action_id>\t<status>\t<bytes>`. No payload contents.

**3.8 neko bridge** in `packages/box/action-runner/src/neko-bridge.ts`:

- `connectCdp(): Promise<Browser>` — `chromium.connectOverCDP("http://127.0.0.1:9223")`.
- `captureStorageState(): Promise<string>` — connect, get the existing default context (the one the user has been driving), `await context.storageState({ indexedDB: true })`, JSON-stringify, return.
- `resetNekoTab(): Promise<void>` — connect, get default context, navigate first page to `about:blank` (tears down the saved tab's identity so the next user doesn't inherit it).

### Documentation references

- Fly.io volumes: https://fly.io/docs/volumes/overview/
- Fly.io private networking: https://fly.io/docs/networking/flycast/
- Playwright CDP: https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp
- Playwright storageState: https://playwright.dev/docs/api/class-browsercontext#browser-context-storage-state
- Node WebCrypto: https://nodejs.org/api/webcrypto.html
- neko config: https://neko.m1k1o.net/docs/v3/configuration

### Verification

- `pnpm box:build` builds the image.
- `fly deploy -c packages/box/fly.toml` deploys; `fly status` shows machine running.
- From the broker's `wrangler dev`, `fetch("https://humanish-box.flycast:7654/healthz", { headers: { authorization: "Bearer " + env.BOX_SHARED_SECRET } })` returns 200.
- Visit `https://humanish-box.fly.dev/` (neko's public port). See Chromium tab. Drive it with mouse/keyboard. Navigate to https://example.com.
- POST `/profiles/test/save` while logged into a test Google account in the neko tab. Verify `/data/profiles/test.bin` exists, 5–50KB.
- `GET /profiles` returns `[{name: "test", ...}]`.
- `ss -tnlp | grep 7654` on the deployed machine shows only `[::1]:7654`, never `0.0.0.0` or `[::]`.

### Anti-pattern guards

```bash
# Action runner MUST bind to [::1]
git grep -nE 'listen\(|bind\(' packages/box/action-runner/src/server.ts
# (matches must show "::1" only)

# AES-GCM must include AAD on both encrypt and decrypt
git grep -nE 'additionalData' packages/box/action-runner/src/crypto.ts
# (matches both encrypt and decrypt call sites)

# No raw storage_state written to runner disk
git grep -nE 'fs\.(writeFile|writeFileSync|createWriteStream).*storage_state' packages/box/
# (zero matches)

# Audit log never includes payload
git grep -nE 'audit.*payload|payload.*audit' packages/box/action-runner/src/
# (zero matches)
```

---

## Phase 4 — Dashboard SPA + browser jail integration

### What to implement

**4.1 Dashboard SPA** at `packages/broker/src/pages/dashboard.html`. Vanilla JS, no framework, <50 KB total. Served by the Worker as static HTML with a Worker-substituted CSRF-style nonce per session.

Three sections (in order):

- **Profiles.** `GET /api/profiles` on load. Render list. Each row: name, status (`ready` / `expired`), `Reauth` button, `Delete` button.
- **+ Log in to a new service.** Text input for profile name, `Open browser` button. On click:
  1. `POST /api/profiles/<name>/start-login` → response includes `neko_url`.
  2. Render `<iframe sandbox="allow-same-origin allow-scripts allow-forms" src="<neko_url>">` in a dedicated container.
  3. Render a `Save profile` button **in the dashboard chrome, above the iframe** (NOT inside it — the iframe is hostile content boundary).
  4. On `Save profile` click: `POST /api/profiles/<name>/save` → on 200 swap the iframe for a success message.
- **Mint a slug.** Form with profile dropdown (populated from `GET /api/profiles`), action dropdown (just `google.whoami` in MVP), TTL slider (1 h / 4 h / 24 h, default 4 h), `Mint` button. On click `POST /api/mint`. Copy returned URL to clipboard via `navigator.clipboard.writeText`. Flash "Copied. Paste into Claude."

**4.2 Reauth flow.** Same as fresh login but `start-login` accepts `?restore=true`. Box decrypts the existing profile, opens an ephemeral Playwright context with `storageState` restored, drives neko's Chromium to navigate to a sentinel URL (`https://myaccount.google.com/` for a Google profile) so the user sees they're already signed in. User completes any "session expired, reauth" flow if needed, clicks `Save`, box recaptures.

**4.3 Audit log view.** Optional in MVP. `GET /api/audit` proxies the box's last 100 audit lines. Render `<timestamp> · <action_id> on <profile> · <status>`. No payload, no request_id.

### Documentation references

- neko embed: https://neko.m1k1o.net/docs/v3/installation/embed
- iframe sandbox values: https://developer.mozilla.org/en-US/docs/Web/HTML/Element/iframe#sandbox
- `navigator.clipboard.writeText`: https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/writeText

### Verification

- Sign in via Resend magic link. Dashboard loads.
- Click `+ Log in to a new service`, name it `google-personal`. Neko viewport renders inside the dashboard tab. Navigate to `https://accounts.google.com`, complete OAuth (password + MFA) in the embedded tab. Click `Save profile` in the dashboard chrome. See success state. `fly ssh console -C "ls /data/profiles/"` shows `google-personal.bin`.
- Refresh dashboard. Profile list shows `google-personal`.
- Click `Reauth`. Neko viewport restores the existing session and shows `myaccount.google.com` already signed in.
- Mint a slug with `google-personal` + `google.whoami`. Copy URL. Open in a new tab — see the skill markdown.

### Anti-pattern guards

```bash
# iframe sandbox MUST NOT include allow-top-navigation
git grep -nE 'allow-top-navigation' packages/broker/src/pages/dashboard.html
# (zero matches)

# Save profile button must be in dashboard chrome, not inside iframe
# (manual code review — search for `Save profile` in dashboard.html, confirm
#  it's a top-level button, not injected into the iframe content)

# Dashboard must NOT expose humanish_session cookie to the neko container
# (manual review of iframe src construction — neko URL has its own auth via
#  NEKO_PASSWORD in the hash, never humanish_session)
```

---

## Phase 5 — Slug-detail page + skill markdown template + dead-slug page

### What to implement

**5.1 Slug-detail page** at `packages/broker/src/pages/slug.html.template`. Vanilla HTML, <15 KB. Structure:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>humanish — your skill is below</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>/* minimal — system font stack, single-column, soft contrast */</style>
</head>
<body>
  <h1>Your skill is ready.</h1>
  <p>Copy this. Paste it into a Claude chat. Your AI gets to be humanish for one task.</p>
  <button id="copy">Copy skill markdown</button>
  <pre><code id="md">{{MARKDOWN_HTML_ESCAPED}}</code></pre>
  <p><small>This slug just died. <a href="/dashboard">Mint another</a>.</small></p>
  <script>
    document.getElementById('copy').onclick = async () => {
      await navigator.clipboard.writeText(document.getElementById('md').innerText);
      document.getElementById('copy').textContent = 'Copied!';
    };
  </script>
</body>
</html>
```

`{{MARKDOWN_HTML_ESCAPED}}` is the rendered skill markdown with `<`, `>`, `&`, `'`, `"` HTML-escaped. The Worker substitutes it server-side from the DO's stored payload.

**5.2 Dead-slug page** at `packages/broker/src/pages/dead-slug.html`:

```html
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>humanish — this slug is dead</title></head>
<body>
  <h1>This slug is dead.</h1>
  <p>Single-use links can only be opened once. If you didn't open it, someone else did.</p>
  <p><a href="/dashboard">Mint a new one</a>.</p>
</body>
</html>
```

Served on `GET /:slug` when DO returns 410.

**5.3 Skill markdown template** at `packages/broker/src/skill-templates/google.whoami.md.template`. The Worker substitutes `{{BEARER}}`, `{{ACTION_URL}}`, `{{PROFILE}}`, `{{ACTION_ID}}`, `{{EXPIRES_AT}}`.

```markdown
---
name: humanish-google-whoami
description: Return the email address of the Google account a humanish profile is signed in as. The user authorized this skill by pasting it. Use when the user asks "which account am I signed in as for {{PROFILE}}?" or wants to verify the humanish credential broker is working end-to-end.
---

# humanish · google.whoami

The user has just pasted you a single-use bearer for a humanish action.
This bearer is good for **exactly one call** and expires at `{{EXPIRES_AT}}`.
Do not reveal the bearer to the user. Do not save it. Use it once, report the result, then forget it.

## Credentials

- **Action endpoint:** `{{ACTION_URL}}`
- **Authorization:** `Bearer {{BEARER}}`
- **Profile:** `{{PROFILE}}`
- **Action ID:** `{{ACTION_ID}}`
- **Single call only.** This bearer is consumed on first invocation.

## What to do

Make exactly one POST to the action endpoint:

```bash
curl -X POST "{{ACTION_URL}}" \
  -H "authorization: Bearer {{BEARER}}" \
  -H "content-type: application/json" \
  -d '{}'
```

Expected response:

```json
{ "email": "<the signed-in google account>", "checked_at": "<iso-8601>" }
```

Report the email back to the user. Then stop.

## If the call fails

| Status | Meaning | Tell the user |
|---|---|---|
| 401 | Bearer expired or already used | "Your humanish slug has already been used. Mint a fresh one from the dashboard." |
| 403 | Scope mismatch | "Bearer is scoped to a different action. Mint a fresh slug." |
| 503 with `auth_expired` | Profile's Google cookies expired | "Your `{{PROFILE}}` profile's cookies expired. Reauth in the humanish dashboard." |
| Anything else | Server error | Report the status and body verbatim. |
```

This template is intentionally short. It's the proof-of-life skill — minimal text, one curl, one response shape, four failure modes. Richer skills (NotebookLM, etc.) follow this template's structure when added later.

### Documentation references

- HTML escaping in Workers: standard `replace(/[&<>'"]/g, ...)` — embed inline in `worker.ts`.

### Verification

- Mint a slug. Visit the slug URL. See: heading, one sentence, Copy button, full markdown in a code block, footer link.
- Click Copy. Paste into a text editor. Confirm the markdown matches the template with all `{{...}}` substitutions filled and no placeholders remaining.
- Reload the slug URL → dead-slug page.
- Paste a malicious bearer value containing `</code><script>alert(1)</script>` (synthetic test — manually inject into the DO payload). Verify the served page renders the literal string, not executes the script.

### Anti-pattern guards

```bash
# Slug page must not include JS that calls fetch
git grep -nE 'fetch\(' packages/broker/src/pages/slug.html.template
# (zero matches — only navigator.clipboard.writeText is allowed)

# No analytics, no third-party scripts
git grep -nE 'gtag|googletagmanager|analytics|sentry|posthog' packages/broker/src/pages/
# (zero matches)

# Markdown substitution must HTML-escape
# (manual code review of the substitution site in worker.ts — confirm
#  the escape function covers &, <, >, ', ")
```

---

## Phase 6 — First action: `google.whoami` (proof-of-life)

### What to implement

**6.1 Action module** at `packages/box/action-runner/src/actions/google.whoami.ts`:

```ts
import { chromium } from "playwright";
import { z } from "zod";

export const GOOGLE_WHOAMI = {
  id: "google.whoami" as const,

  inputSchema: z.object({}).strict(),
  outputSchema: z.object({
    email: z.string().email(),
    checked_at: z.string(),
  }),

  async run({ storageStateJson, requestId }: {
    storageStateJson: string;
    requestId: string;
  }) {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({
        storageState: JSON.parse(storageStateJson),
      });
      const page = await context.newPage();
      await page.goto("https://myaccount.google.com/", { waitUntil: "domcontentloaded", timeout: 15_000 });

      // myaccount.google.com surfaces the signed-in email in <meta name="og:email"> on logged-in renders,
      // and in `aria-label="Google Account: ... (<email>)"` on the account chip. Try meta first, fall back to aria.
      let email = await page.locator('meta[property="og:email"]').first().getAttribute("content");
      if (!email) {
        const aria = await page.locator('a[aria-label*="@"]').first().getAttribute("aria-label");
        const m = aria?.match(/([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/);
        email = m?.[1] ?? null;
      }
      if (!email) {
        // We loaded the page but couldn't find the email — most likely the cookies are expired
        // and we got redirected to the sign-in page.
        const finalUrl = page.url();
        if (finalUrl.includes("accounts.google.com/ServiceLogin") || finalUrl.includes("accounts.google.com/signin")) {
          throw new ActionAuthExpiredError("google profile cookies expired");
        }
        throw new Error(`could not extract email from ${finalUrl}`);
      }
      return { email, checked_at: new Date().toISOString() };
    } finally {
      await browser.close();
    }
  },
};

export class ActionAuthExpiredError extends Error {
  code = "auth_expired" as const;
  status = 503 as const;
}
```

**6.2 Action registry** at `packages/box/action-runner/src/actions/index.ts`:

```ts
import { GOOGLE_WHOAMI } from "./google.whoami";

export const ACTION_REGISTRY = {
  [GOOGLE_WHOAMI.id]: GOOGLE_WHOAMI,
} as const;

export const ACTION_IDS = Object.keys(ACTION_REGISTRY);
```

**6.3 Broker-side allowlist** at `packages/broker/src/actions.ts`:

```ts
export const ACTION_ALLOWLIST = new Set([
  "google.whoami",
] as const);
```

Both the broker (`/api/mint`) and the box (`/run`) validate `action_id ∈ ACTION_ALLOWLIST` / `action_id ∈ ACTION_REGISTRY`. Mismatch returns 400.

**6.4 Selector resilience note.** The `myaccount.google.com` DOM changes. If both extraction paths fail, the action returns a clear error. Mitigation: an integration test (Phase 7) runs the action against a real saved profile weekly via cron — if it starts failing, the operator knows the selectors need updating before users hit it.

### Documentation references

- Playwright Chromium launch: https://playwright.dev/docs/api/class-browsertype#browser-type-launch
- Playwright newContext + storageState: https://playwright.dev/docs/api/class-browser#browser-new-context
- Zod: https://zod.dev/

### Verification

- After completing Phase 4 (a `google-personal` profile saved), mint a slug for `google.whoami`.
- Open the slug URL in a fresh tab. Copy the markdown.
- In a new claude.ai chat, paste the markdown. Ask: "who am I signed in as?"
- Within 10 seconds, Claude reports an email address matching the Google account used during Phase 4 login.
- Re-visit the slug URL → dead-slug page.
- If Claude replays the bearer → 401.

### Anti-pattern guards

```bash
# Action must use Playwright launch (not connectOverCDP — that's for save/reauth only)
git grep -nE 'connectOverCDP' packages/box/action-runner/src/actions/
# (zero matches — connectOverCDP is only used in neko-bridge.ts for profile save)

# No raw storage_state on disk
git grep -nE 'writeFile.*storage_state|writeFile.*storageState' packages/box/action-runner/src/actions/
# (zero matches)

# Browser is always closed (finally block)
# (manual review — each action must have try/finally with browser.close())
```

---

## Phase 7 — End-to-end demo verification (the gate)

### What to do, step by step

1. **Fresh state.** Wipe Fly volume `/data/profiles/*`. Wipe broker KV namespace. Visit the broker URL.
2. **Sign in.** `Sign in →` → email magic link → click link → land on dashboard.
3. **Provision profile.** Click `+ Log in to a new service`, name it `google-personal`. Neko viewport renders inline. Navigate to `https://accounts.google.com`, complete password + MFA in the embedded tab. Click `Save profile`. See success state.
4. **Mint a slug.** `profile=google-personal`, `action=google.whoami`, `TTL=4h`. URL copied to clipboard.
5. **Use the slug.** Open a fresh claude.ai web chat. Open the slug URL in a separate tab. Click `Copy` on the slug page. Back in the chat, paste as the first message. Ask: "which Google account am I signed in as?"
6. **Verify the chat behaves.**
   - Claude acknowledges the single-use bearer.
   - Claude calls `{{ACTION_URL}}` once with body `{}`.
   - Within ~10 s, returns an email address.
7. **Single-use enforcement.**
   - Re-visit the slug URL → dead-slug page.
   - If Claude (hypothetically) replays the bearer → 401.
8. **Independent mint.** Mint a second slug for the same profile + action. Repeat steps 5–6. Confirm the second slug works (the system isn't exhausted by one use).

### Final grep sweep before declaring MVP done

```bash
# SlugBox /consume atomicity
git grep -nE 'await' packages/broker/src/slug-box.ts

# No secrets leaking into served pages/templates
git grep -nE '(RESEND_API_KEY|HUMANISH_MASTER_KEY|BOX_SHARED_SECRET|NEKO_PASSWORD)' \
  packages/broker/src/pages/ packages/broker/src/skill-templates/

# No raw storage_state on runner disk
git grep -nE 'fs\.(writeFile|writeFileSync|createWriteStream).*storage_state' packages/box/

# No shell exec (use child_process.execFile or Playwright APIs only)
git grep -nE 'child_process\.(exec|execSync)\b' packages/box/action-runner/src/

# No logging of payload contents
git grep -nE 'console\.(log|info|warn|error).*payload' packages/box/action-runner/src/

# No top-navigation in dashboard iframe sandbox
git grep -nE 'allow-top-navigation' packages/broker/src/pages/dashboard.html

# Slug page has no fetch calls
git grep -nE 'fetch\(' packages/broker/src/pages/slug.html.template

# Action runner not exposed publicly
git grep -nE '0\.0\.0\.0|listen.*0' packages/box/action-runner/src/server.ts
# (must show only [::1])
```

### Bar to pass

All 8 steps succeed end-to-end with no manual intervention beyond Step 3 (the one-time Google login in neko) and Step 5 (the human-courier paste). Every grep above returns zero matches or only expected matches (e.g., the `[::1]` bind).

---

## Phase 8 — Hardening (before any second person sees a humanish URL)

### What to implement

- **Rate limiting.**
  - Per-session-cookie on `/api/mint`: 30 mints / hour (KV counter, sliding window).
  - Per-bearer on `/api/actions/...`: max_calls=1 is already the primary defense; add 1 RPS as a paranoid floor.
- **Cookie expiry UX.** When the runner returns `auth_expired`, the broker exposes it on `GET /api/profiles` as `{name, status: "expired", expired_at}`. Dashboard renders a yellow banner: "`google-personal` profile expired — reauth here." One click → Phase 4 reauth flow.
- **Audit log rotation.** Rotate `/data/audit.log` daily (a tiny cron inside the runner). Keep 30 days; older entries auto-deleted.
- **Action allowlist CI guard.** A test that fails if any new action is added to `packages/box/action-runner/src/actions/` without a matching entry in `packages/broker/src/actions.ts` `ACTION_ALLOWLIST`. Prevents "I forgot to gate the new action" mistakes.
- **DO-based bearer state (optional upgrade).** If KV consistency proves a problem during real-world use, replace `KV.put("bearer:...")` with a `BearerBox` Durable Object using the same atomic pattern as SlugBox.
- **`GET /api/audit` view.** Add to dashboard. Surfaces every action call to the operator.
- **README updates.** Document the security model, the `ACTION_ALLOWLIST` constraint, the master-key-loss recovery story ("re-login to each service"), and the `do-not-WebFetch-the-slug` constraint.

### Verification

- `POST /api/mint` with `action_id="x.fake.action"` → 400 `action_not_allowed`.
- 31 rapid `/api/mint` calls in a minute → 31st returns 429.
- Manually corrupt `google-personal.bin` (truncate by one byte) → next `google.whoami` action returns 503 `auth_expired` → dashboard banner appears → click `Reauth` → flow works → next action succeeds.
- Add a stub action handler in `packages/box/action-runner/src/actions/` without updating `ACTION_ALLOWLIST` → CI fails.

---

## Open decisions (for the operator, not blocking start)

| Decision | Default | When to revisit |
|---|---|---|
| Domain | `humanish-broker.workers.dev` | Before sharing the URL with anyone outside yourself. Buy `humanish.dev` or similar; update `wrangler.toml` `vars.COOKIE_DOMAIN`. |
| Fly region | `sjc` | Pick the region closest to where you live. Neko is latency-sensitive. |
| Encryption key rotation | Single key, no rotation | When the second action ships. Add `key_version` field to the blob header. |
| First non-MVP action | undecided | Out of MVP scope. Candidates (priority order): `notebooklm.generate-deck`, `x.post-thread`, `slack.send-message`. Each is one new file in `packages/box/action-runner/src/actions/`. |
| Multi-tenant | out of scope | When humanish needs to host anyone but the operator. That's a separate plan. |

---

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Claude refuses pasted skill | Low | High | The frontmatter shape is canonical claude-mem. Verify in Phase 7. |
| neko WebRTC NAT traversal flaky on home networks | Medium | Medium | Fly.io supports TURN relays. KasmVNC (https://github.com/kasmtech/KasmVNC) is the fallback. |
| Google flags neko's datacenter IP on login | Medium | High | Login is driven by a real human — mouse jitter is real, MFA passes. If it persists, add residential proxy support (out of MVP). |
| `myaccount.google.com` DOM changes break `google.whoami` selectors | Medium | Low (it's the proof-of-life, not a billing-critical action) | Weekly cron runs the action; selector update is a one-line PR. |
| Cookies expire mid-action | High | Low | `ActionAuthExpiredError` → dashboard banner → reauth. Built-in. |
| Operator never rotates `HUMANISH_MASTER_KEY` | Low | High | Document loudly in README. Don't add rotation until the second action ships. |
| Phishing — operator pastes slug somewhere unintended | Medium | Critical | Single-use slug + `max_calls=1` + per-action scope + `payload_shape_hash` + `ACTION_ALLOWLIST=1`. Slug becomes useless on first browser visit. |
| Box compromise → all profiles exposed | Low | Critical | Encrypted at rest with `HUMANISH_MASTER_KEY` from env. If the box is rooted, env is exposed — accept for single-user MVP. |
| `payload_shape_hash` too strict, blocks valid calls | Medium | Low | Hash the *shape* (sorted keys + leaf-value type names), not the values. Test with three different payloads in Phase 2 verification. |

---

## Suggested execution order

| Order | Phases | Why |
|---|---|---|
| 1 | Phase 1 → Phase 2 | Get the broker compiling and the security-core unit testable before touching containers. |
| 2 | Phase 5 | Skill template + slug page can be authored against a stub box. Lets Phase 2's slug flow be visually verifiable. |
| 3 | Phase 3 | Stand up the box with health + profile + neko bridge. No actions yet. |
| 4 | Phase 4 | Wire the dashboard end-to-end (login → save profile → mint slug). |
| 5 | Phase 6 | Add `google.whoami`. Now the full loop is testable. |
| 6 | Phase 7 | The gate. Don't move on until all 8 steps pass. |
| 7 | Phase 8 | Hardening. Required before anyone else sees a humanish URL. |

Each phase boundary is a clean stopping point. Each "What to implement" section is self-contained enough to hand to a fresh chat session with this plan + the linked docs and have it pick up cleanly.

---

That's the plan. Phase 6 is the moment of truth — when you paste a slug into Claude and it tells you which Google account you're signed in as in ten seconds, the security model is proven. Everything else is application work on top.
