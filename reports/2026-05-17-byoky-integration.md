# byoky — what it is, what's gold, and how the "cookie jar" plugs in

**Date:** 2026-05-17
**Subject:** [`MichaelLod/byoky`](https://github.com/MichaelLod/byoky) v0.9.13 · MIT
**One-liner:** byoky is an encrypted wallet that brokers LLM API keys to apps via a `createFetch()` proxy — five integration paths (extension, mobile, backend, bridge, relay) and a gift primitive that map onto humanish's slug-bound bearer almost 1:1. Lift its crypto and URL/header hardening for the MVP; consider it the merge target for the cloud version.

---

## 1. What byoky actually does

**Bring Your Own Key.** An encrypted wallet/extension that stores LLM API keys (Anthropic, OpenAI, Gemini, 13 providers) and proxies all calls so consumer apps never hold the secret. The app uses any provider's native SDK — it just swaps in a `createFetch()` that routes through the wallet.

Repository shape: pnpm monorepo, ~20 packages: `core` (shared protocol/crypto/types/translation), `sdk` + `sdk/server`, `extension` (WXT, Chrome/Firefox/Safari), `bridge` (`@byoky/bridge` — local HTTP proxy + Native Messaging Host), `relay` (WebSocket server), `vault` (Hono server-side vault on Railway), `ios` (SwiftUI), `android` (Kotlin/Compose), `openclaw-plugin` (third-party agent integration), `create-byoky-app` (scaffolder), `web` (byoky.com Next.js + Token Pool + apps marketplace), plus a self-contained marketing pipeline.

**Five integration paths, same guarantee — keys stay in the wallet:**

```
Browser app   → SDK postMessage → Content script → Extension SW → fetch(provider)
Mobile wallet → SDK WebSocket   → Relay server   → Phone app    → fetch(provider)
Backend       → SDK WebSocket   → User's browser → Extension    → fetch(provider)
CLI / desktop → HTTP            → Bridge :19280  → Native msg   → Extension → fetch(provider)
Remote agent  → WebSocket       → Relay server   → Wallet       → fetch(provider)
Gift link     → relay (sender's wallet stays the proxy, recipient never touches the key)
```

The whole system runs on **two ideas**:

1. **Custom fetch as the indirection point.** `createFetch(providerId)` returns a function shaped like the standard `fetch` API. Apps drop it into any provider's native SDK constructor (`new Anthropic({ fetch: session.createFetch('anthropic') })`). The fake fetch serializes the request, hands it across whichever transport (postMessage/WebSocket/HTTP), the wallet decrypts the real key, injects auth headers, calls the upstream, streams the response back via `TransformStream`. Two lines of code change in the consuming app.

2. **A `Credential` discriminated union** (`api_key | oauth`) stored encrypted under a master-password-derived AES-GCM key, with per-app `Group` bindings that let users drag apps between credential buckets and even cross provider families (Anthropic ↔ OpenAI ↔ Gemini ↔ Cohere) with on-the-fly request/response/SSE translation.

---

## 2. Repository at a glance (what's where)

| Package | Purpose | Files I read in full |
|---|---|---|
| `core/src/types.ts` | Shared types — `Credential`, `Session`, `Group`, `RequestLogEntry`, `ProxyRequest`, `MarketplaceApp` | yes |
| `core/src/crypto.ts` | AES-256-GCM + PBKDF2-600K, `deriveKey`, `encrypt`/`decrypt`, `encryptWithKey`/`decryptWithKey`, `hashPassword`/`verifyPassword`, `maskKey` | yes |
| `core/src/protocol.ts` | `BYOKY_*` postMessage envelope, `createMessage`, `isByokyMessage` | yes |
| `core/src/providers.ts` | `PROVIDERS` registry — 13 providers + per-provider `chatPath`, `requiresCustomBaseUrl`, OAuth config | yes |
| `core/src/gift.ts` | `Gift`, `GiftLink` (versioned envelope), `GiftedCredential`, relay protocol messages, short-link resolution, validation | yes |
| `core/src/relay.ts` | Relay wire protocol — `relay:hello`/`request`/`response:meta`/`chunk`/`done`/`error`/`ping`/`pong`/`pair:hello`/`vault:offer`, `parseRelayMessage` validator | yes |
| `core/src/routing.ts` | `resolveRoute` — 4-tier resolution: cross-family translation, same-family swap, direct credential, auto cross-family fallback | yes |
| `core/src/proxy-utils.ts` | `validateProxyUrl` (origin allow-list), `buildHeaders` (forward allow-list + per-provider auth injection), `parseUsage`, `injectClaudeCodeSystemPrompt`, `rewriteToolNamesForClaudeCode`, SSE tool-name rewriter | yes |
| `core/src/errors.ts` | `ByokyError` class + static factories per `ByokyErrorCode` | yes |
| `sdk/src/byoky.ts` | `Byoky` class — `connect`, `tryReconnect`, `connectViaVault`, `connectMock`, extension/relay/vault session builders | yes |
| `sdk/src/proxy-fetch.ts` | `createProxyFetch` — MessageChannel-based postMessage fetch with TransformStream body | yes |
| `sdk/src/relay-fetch.ts` | `createRelayFetch` — WebSocket-based equivalent | yes |
| `sdk/src/relay-client.ts` | `createRelayClient` — backend-relay receiver (`@byoky/sdk/server` companion) | yes |
| `sdk/src/server.ts` | `ByokyServer` — Node-side WebSocket handler for backend relay | yes |
| `sdk/src/vault-fetch.ts` | `createVaultFetch` — HTTP-only fetch against `<vault>/proxy` with JWT | yes |
| `sdk/src/detect.ts` | `isExtensionInstalled`, `getStoreUrl`, popup-iframe detection | yes |
| `bridge/src/host.ts` | Native Messaging Host — stdin/stdout length-prefixed JSON, OAuth proxy + direct fetch + start-proxy dispatch | yes |
| `bridge/src/proxy-server.ts` | Local HTTP server on `127.0.0.1:19280` — DNS-rebinding defense, per-provider URL build, `/_shutdown`, hop-by-hop strip | yes |
| `bridge/src/session-store.ts` | Persists `~/.byoky-bridge/session.json` (mode 0o600, atomic rename) | yes |
| `bridge/src/connect-mode.ts` | `byoky-bridge connect` — ephemeral loopback HTTP, browser-open, SDK connect, start-proxy ack | yes |
| `bridge/src/relay-mode.ts` | `byoky-bridge relay` — same `:19280` HTTP front but talks WebSocket to mobile wallet via relay, vault fallback when phone offline | yes |
| `bridge/src/installer.ts` | Native Messaging Host manifest install — Chrome/Brave/Chromium/Firefox on macOS/Linux/Windows, bash wrapper with locked-down PATH | yes |
| `bridge/src/spawner.ts` | `spawnRelay` — scanner-safe detached child-process spawn helper for the OpenClaw plugin | yes |
| `bridge/src/hermes-setup.ts` | Patches `~/.hermes/config.yaml` so Hermes Agent routes through the bridge as `byoky-anthropic` custom provider | yes |
| `openclaw-plugin/src/index.ts` | Full OpenClaw plugin — registers 13 byoky providers, runs the auth loopback HTTP page, ensures Native Messaging Host is installed, spawns relay-mode bridge for mobile pairings | yes |
| `extension/entrypoints/background.ts` | Service worker — sessions, password unlock, auto-lock, bridge auth, gift relays, MV3 session-storage persistence | first 300 lines |
| `extension/entrypoints/content.ts` | Content script — postMessage bridge to background, MessagePort secure channel | yes |

Skipped on purpose: native Swift/Kotlin ports (mirror TS by design, per `CLAUDE.md`), web Next.js pages (marketing surface), marketing/ pipeline (asset generation), tests, and the WXT popup React UI. All `pnpm-lock.yaml`, all node_modules. Every architecturally-important TypeScript file is read.

---

## 3. The architectural hidden gems

| What byoky already solved | File | Why it matters for humanish |
|---|---|---|
| **AES-256-GCM + PBKDF2-600K vault** | `core/src/crypto.ts` | Identical crypto humanish was planning — same primitives, already battle-tested |
| **Slug-equivalent**: `sessionKey` scoped to `(origin, providers, expiry)` | `core/src/types.ts:89` | Same "single bearer, narrow scope" shape as the slug-bound bearer |
| **Gift link primitive** — `(credentialId, providerId, authToken, maxTokens, expiresAt, relayUrl)` with budget enforcement, expiry, short-URL form | `core/src/gift.ts` | This is literally humanish's slug-bound bearer with `max_calls=1` — same idea, productized |
| **Versioned `GiftLink` envelope** (`v: 1`, base64url, ≤8KB cap, `byoky://gift/`/`https://byoky.com/gift/` prefix tolerance) | `core/src/gift.ts:94-114` | Drop-in shape for humanish slug URLs |
| **Short-link resolver** — `https://byoky.com/g/<id>` resolves via the vault; needed because WhatsApp stops linkifying long URLs | `core/src/gift.ts:128-178` | Real-world UX detail humanish would have hit |
| **Token Pool** — public board where users list free gifts (online/offline status, remaining budget, expiration countdown) | `web/app/token-pool/` | Direct precedent for a "public humanish actions board" if you ever want one |
| **WebSocket relay protocol** (recipient/sender/auth/peer:status/vault:offer) with size cap, per-type required-field validation | `core/src/relay.ts` | Solves "remote AI uses my local credential" — exactly humanish's Fly box ↔ chat.anthropic.com problem |
| **Bridge: native messaging host → local HTTP `:19280`** with DNS-rebinding defense, `/_shutdown`, session-key probing, persistent session restore across MV3 SW recycles | `bridge/src/host.ts`, `bridge/src/proxy-server.ts` | For Phase 7+ ("operator's local Claude Code uses my Google session"), this is the missing piece — already written, MIT-licensed |
| **Magic-link-alternative**: password-encrypted vault unlocks per session, auto-locks after 20 min idle, session-storage persistence for MV3 worker survival | `extension/entrypoints/background.ts:269` | Could replace your wooow.now Resend magic-link copy if you'd rather not run an email-sender |
| **Header allow-list with control-char rejection** (no `x-stainless-*`, no `cookie`, no `transfer-encoding`, no `set-cookie` on response) | `core/src/proxy-utils.ts:80`, `bridge/src/proxy-server.ts:86` | Same defenses humanish needs at the action-runner boundary |
| **`validateProxyUrl`**: origin allow-listing per provider; loopback-only `http://` for Ollama/LM Studio | `core/src/proxy-utils.ts:33` | Plug-and-play for humanish's host-allowlist |
| **Audit log entry shape**: `{sessionId, appOrigin, providerId, url, status, ts, model, capabilities, actualProviderId?, actualModel?, groupId?}` | `core/src/types.ts:287` | Drop-in for `/data/audit.log` |
| **`detectRequestCapabilities`** — parses body for `tools[]`, `response_format: json_schema`, `thinking`, image content blocks | `core/src/proxy-utils.ts:208` | Pattern humanish wants for "what did this action invocation request" |
| **`parseUsage`** with per-provider SSE quirks (Anthropic `message_start`+`message_delta` split, Gemini `usageMetadata`, Cohere `message-end`, Groq `x_groq.usage`) | `core/src/proxy-utils.ts:309` | Reference for how to compute usage on per-action billing if humanish ever charges |
| **Anti-Anthropic-bot-detection rewrites**: tool name PascalCasing, system prompt relocation, `oauth` beta headers (`claude-code-20250219` etc.), stripped 1M-context betas | `core/src/proxy-utils.ts:497-820` | Gold for the future "operator uses Claude Pro/Max setup token against humanish actions" path |
| **`/_shutdown` for hot-swapping a stale bridge** | `bridge/src/proxy-server.ts:159` | Pattern humanish needs for swapping the live neko session when a profile is reauthed |
| **Native Messaging Host installer** with hardened bash wrapper (locked-down PATH, no env inheritance, 0700 dirs, 0600 manifests, multi-browser registration on darwin/linux/win32) | `bridge/src/installer.ts` | Lift wholesale if humanish ever wants a CLI surface |
| **`ByokyError` hierarchy** with typed codes (`WALLET_NOT_INSTALLED`, `USER_REJECTED`, `PROVIDER_UNAVAILABLE`, `SESSION_EXPIRED`, `NO_SESSION`, `RATE_LIMITED`, `QUOTA_EXCEEDED`, `INVALID_KEY`, `TOKEN_EXPIRED`, `PROXY_ERROR`, `RELAY_CONNECTION_FAILED`, `RELAY_DISCONNECTED`) | `core/src/errors.ts` | Drop-in for action-runner error taxonomy |
| **MessagePort over CustomEvent** — uses transferable ports for response delivery so page scripts can't spoof or intercept | `sdk/src/byoky.ts:907`, `extension/entrypoints/content.ts:20` | Security pattern humanish should adopt if it ever exposes a postMessage surface |
| **Backend-relay protocol** — `ByokyServer.handleConnection(ws)` gives Node consumers the same `createFetch(providerId)` shape | `sdk/src/server.ts` | Direct precedent for "humanish remote action runner gets a typed `runAction(actionId, payload)` shape via WebSocket from a sender that holds the cookies" |

---

## 4. Where the "cookie jar" slots in — concretely

byoky's vault is a **`Credential` = `ApiKeyCredential | OAuthCredential`** discriminated union, encrypted under a master-password-derived AES-GCM key. Adding a third variant gets you 80% of humanish:

```ts
// packages/core/src/types.ts — add to the union
export interface BrowserSessionCredential extends CredentialBase {
  authMethod: 'browser_session';
  encryptedStorageState: string;  // AES-GCM(storage_state.json), AAD = label
  profileMeta: {
    capturedAt: number;
    refreshedAt?: number;          // bumped by keepalive cron
    cookieExpiresEarliest?: number;
    indexedDBStored: boolean;       // your Phase 0 noted Firebase needs this
  };
}
```

And a new `ProviderConfig.authMethods` value `'browser_session'`. Then services without an API (`notebooklm`, `x_personal`, `slack_workspace`) register as providers with that auth method.

The bridge already routes `POST /<providerId>/...` to a handler keyed by provider ID. Today it forwards to `fetch(real URL)`. Humanish swaps the handler:

```ts
// packages/bridge/src/proxy-server.ts — handler for browser_session providers
if (provider.authMethod === 'browser_session') {
  // Decrypt storage_state, spawn Playwright with NOTEBOOKLM_AUTH_JSON env,
  // run the typed action, return result. Exactly your Phase 4 plan.
}
```

### Gift ↔ slug-bound bearer mapping

The byoky `Gift` primitive maps **1:1** to humanish's slug-bound bearer:

| Humanish concept | byoky equivalent | Mapping |
|---|---|---|
| Two-word EFF slug | `Gift.id` | Replace UUID generator with `EFF_LONG` two-word format; the rest of the gift envelope stays |
| `max_calls=1` | `Gift.maxTokens=1` + custom decrement on action invoke | Same enforcement point, semantically rename `tokens` → `calls` for action gifts |
| `payload_shape_hash` | New `Gift.payloadShapeHash` field | Two-line add to `validateGiftLink` |
| TTL (4h default) | `Gift.expiresAt` | Already there, `isGiftExpired` exists |
| Slug → HTML page → copy-paste skill markdown | New: `Gift.skillTemplate` + slug-detail HTML route | The MacGyver-pattern courier UX is humanish's unique addition; byoky's gift redemption is purely SDK-driven |
| Action allowlist | New: `Gift.actionId` constrained by `ACTION_ALLOWLIST` | Phase 7 hardening |
| Burn on first browser visit (DO atomic single-use) | byoky has no equivalent — gifts are reusable up to `maxTokens` | humanish adds Durable Object `SlugBox` layer in front |
| Single-use bearer for action call | `Gift.authToken` + relay-side budget decrement | Match shape; humanish adds payload-shape verification |

### Relay protocol reuse

`core/src/relay.ts` is **exactly** the wire format you'd want between a humanish Fly box (sender) and a future remote consumer (recipient). Sender holds the cookies, recipient gets typed action results, never raw `storage_state`. Humanish would add a new message type:

```ts
interface RelayActionRequest {
  type: 'relay:action:request';
  requestId: string;
  profile: string;
  actionId: string;
  payload: unknown;
}

interface RelayActionResult {
  type: 'relay:action:result';
  requestId: string;
  result: unknown;
}
```

Alongside the existing `relay:request`/`relay:response:*` chain — the auth, peer-status, vault-offer, and ping/pong machinery are reusable verbatim.

---

## 5. What humanish uniquely adds (and what byoky lacks)

1. **The neko browser jail.** byoky has nothing for "user logs into a real service in a real headful browser inside the dashboard tab." This is humanish's core IP.
2. **Playwright `storage_state` capture via CDP.** byoky has no concept of cookie jars. The whole `chromium.connectOverCDP("http://127.0.0.1:9223")` + `context.storageState({ indexedDB: true })` flow is humanish-only.
3. **The chat-shaped consumer.** byoky's consumer is always an SDK call (`createFetch`). Humanish's consumer is a Claude.ai web chat that can't `WebFetch` instructions due to the Haiku pre-summarizer. The paste-the-markdown courier flow + slug-detail HTML page is humanish-only.
4. **Typed action handlers.** byoky proxies arbitrary fetch. Humanish needs the equivalent of `notebooklm.generate-deck`: a typed Zod-validated handler that runs CLI calls, polls for artifacts, uploads to wooow.now, returns inline.
5. **Cookie keepalive cron** (`__Secure-1PSIDTS` rotation every ~5 min via `notebooklm list`). Pure humanish, no byoky equivalent.
6. **Atomic single-use slug** via Cloudflare Durable Object `SlugBox` with no-intervening-await `storage.get`/`storage.delete`. byoky's gifts are budgeted but reusable; humanish's are explicitly one-shot.
7. **Phishing risk framing.** byoky's allowlist is implicit (provider URL must match registered base). Humanish's `ACTION_ALLOWLIST` of one (`notebooklm.generate-deck`) is a structural defense against "paste this `dusty-koala` link into your bank's chat" — a class of risk byoky doesn't have because LLM API endpoints aren't user-targeted services.

---

## 6. Recommended integration path

### Option A — Cherry-pick (MVP-friendly, ships fast)

Keep humanish as a separate Cloudflare Worker + Fly box per the plan in `plans/2026-05-14-humanish.md`. Lift these three specific byoky modules verbatim, credit them, and ship:

1. **`core/src/crypto.ts`** → drops straight into `packages/box/action-runner/src/crypto.ts`. AES-GCM with PBKDF2-600K. Add AAD = profile name in the calls (byoky doesn't use AAD; humanish should).
2. **`core/src/proxy-utils.ts`** `validateProxyUrl` + `buildHeaders` FORWARDABLE_HEADERS allow-list → wrap the action-runner's HTTP surface and the wooow.now upload call with the same defenses. Single most valuable lift.
3. **`core/src/gift.ts`** `decodeGiftLink` / `validateGiftLink` / `giftBudget*` helpers + the `v: 1` versioned envelope shape → adapt for the slug-bound bearer. Replace `Gift.maxTokens` semantics with `max_calls`; add `payloadShapeHash`; add `skillTemplate`. Keep the base64url short-link resolver for free.

Also worth a glance:
- `bridge/src/proxy-server.ts:86-126` (`handleProxyResponse` — strip `transfer-encoding`, `content-encoding`, `content-length`, `set-cookie*` from upstream responses) — apply to the action-runner's outbound responses too.
- `bridge/src/proxy-server.ts:132-141` (DNS-rebinding defense via Host-header allow-list) — humanish's `[::1]:7654` action runner gets the same treatment for defense in depth.

### Option B — Fork byoky (long-term, becomes the cloud version)

Fork byoky. Add `browser_session` as a third `authMethod`. Make the bridge route `browser_session` providers to a Playwright runner instead of `fetch`. Now humanish is "byoky for cookies," and you inherit free:

- The encrypted vault + master-password UX
- The CLI bridge (Claude Code locally can use Google sessions via humanish-anthropic-style provider, with the OAuth/setup-token rewrite infrastructure already in place)
- The mobile wallet (log into Google on your phone, AI uses it from the cloud — speculative but architecturally supported)
- The relay (cloud agents borrow phone-held cookies)
- The Token Pool concept (with TOS caveats — gifting cookie sessions is structurally different from gifting API budgets)
- The gift primitive (already what the slug is)
- The cross-family translation infrastructure (overkill for cookies, but precedent for "humanish action A failed, transparently retry with action B")
- 13-provider OpenClaw plugin pattern (template for any future third-party agent framework that wants to drive humanish actions)

### My read

**Option A for the MVP.** The plan in `plans/2026-05-14-humanish.md` stays intact, you cherry-pick the proven crypto + URL/header hardening + gift envelope, and the slug primitive maps onto `Gift` cleanly enough that you can adopt byoky's exact share-link encoding (base64url, short-link resolver, `v: 1` versioned envelope) without rewriting. Option B becomes the multi-tenant cloud version sketched in section 9 of `2026-05-14-humanish-server.md`.

**The single most valuable thing to lift right now:** `core/src/proxy-utils.ts:33-189` (`validateProxyUrl` + `buildHeaders` with the FORWARDABLE_HEADERS allow-list). That's the action-runner's outer boundary done in ~150 lines of MIT-licensed, test-covered, production-running code.

### Things to NOT lift

- **`core/src/translate/*`** — adapter system for Anthropic ↔ OpenAI ↔ Gemini ↔ Cohere request/response/SSE translation. Genuinely impressive engineering, irrelevant to humanish's MVP. If a future humanish action wants "translate to whichever slide-deck service the operator has," revisit.
- **The full extension** — humanish's dashboard is a Cloudflare Worker page, not a browser extension. The MessagePort/postMessage bridge logic is interesting but not load-bearing for the MVP.
- **Mobile apps** — out of scope.

---

## 7. Repository housekeeping observations

- byoky uses `pnpm` workspaces and Node ≥20. Humanish should pick its own; no need to match.
- byoky's MIT license is compatible with humanish's Apache 2.0 — lifting files is legal, just preserve the copyright notice in headers if you copy `core/src/*` files wholesale.
- byoky's TODO.md tracks removed providers (Replicate, HuggingFace Inference API) and translation phase-2 follow-ups. Notably no security TODOs.
- byoky's `SECURITY.md` lists exactly the threat model humanish inherits: API key exposure, encryption weaknesses, approval flow bypass, content script injection, session token prediction/replay.
- The repo's `marketing/` pipeline (auto-generates Chrome Web Store / iOS / Play / Product Hunt screenshots + narrated videos from Playwright fixtures + iOS/Android simulators) is unrelated to humanish but worth a separate look if humanish ever ships to consumer surfaces.

---

## 8. Open questions for the operator

1. **Single-user MVP scope.** Does the MVP want a browser-extension front (byoky's model — password-encrypted vault, no email) or the planned Cloudflare-Worker-with-Resend-magic-link dashboard? Extension is simpler to ship; Worker is what `plans/2026-05-14-humanish.md` Phase 1 specifies.
2. **Slug vs Gift naming.** Adopting byoky's `Gift` envelope literally means humanish slug URLs would be `byoky://gift/<base64url>` or `https://humanish.example/g/<shortId>`. Either rebrand the envelope to humanish or fork the type names. Recommend the latter — `humanish-action-grant` reads honestly.
3. **License header preservation.** If we lift `core/src/{crypto,proxy-utils,gift}.ts`, add a header noting the byoky MIT origin + the commit SHA the lift came from. Cheap, polite, audit-friendly.
4. **CLI surface in Phase 7+.** The byoky bridge proves a CLI tool can route through a wallet over native messaging. If humanish ever wants Claude Code (the CLI) to use the operator's Google session, lifting `@byoky/bridge` wholesale and swapping its provider handlers for `browser_session` action runners is the cleanest path. Defer until there's user demand.

---

## 9. One-paragraph executive summary

byoky is the indirection layer humanish was about to invent: encrypted credential vault, scoped-bearer gifts, single-use share envelopes, WebSocket relay for remote consumers, local HTTP bridge for CLI tools, and a custom-fetch SDK shape that lets any consumer use a credential without ever holding it. The one thing it doesn't do — the only thing — is treat a Playwright `storage_state.json` as a first-class credential type. Adding `BrowserSessionCredential` to its `Credential` union and a Playwright handler to its bridge converts byoky into humanish's full backend. For the MVP: cherry-pick `crypto.ts`, `proxy-utils.ts`, and `gift.ts`, ship per the existing plan. For the cloud version: fork byoky and contribute `browser_session` back upstream — there's nothing structurally hostile in byoky's design to cookie-jar credentials, the maintainer just didn't need them yet.
