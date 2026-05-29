// humanish broker — Cloudflare Worker.
//
// Responsibilities:
//   1. Magic-link auth + session cookies (operator only, single-user MVP).
//   2. Dashboard proxy to the box (profile CRUD + browser-jail login).
//   3. /api/mint — issue a slug-bound one-shot bearer; render a skill markdown
//      page; stash the page in a SlugBox DO under a two-word slug.
//   4. GET /:slug — atomically consume the slug page; render once, kill the
//      slug. Browser-only render (CSP locks down outbound network).
//   5. POST /api/actions/:profile/:action_id — verify bearer + payload shape;
//      forward to box; stream response back.
//
// Anti-patterns CI-enforced in Phase 7:
//   - SlugBox /consume must have no intervening await between get and delete.
//   - No request-body logging in this file or anywhere under src/.
//   - No literal secret values in pages/ or skill-templates/.

import { ACTION_ALLOWLIST, ACTION_TTL_BOUNDS, isActionAllowed } from "./actions.js";
import {
  consumeMagicToken,
  isEmailAllowed,
  mintMagicToken,
  sendMagicLinkEmail,
} from "./auth.js";
import {
  checkMintRateLimit,
  mintBearer,
  payloadShapeHash,
  verifyBearer,
} from "./bearer.js";
import { htmlEscape } from "./crypto-util.js";
import {
  buildClearCookie,
  buildSessionCookie,
  createSession,
  readSessionToken,
  readSessionUser,
} from "./session.js";
import { EFF_LONG_SLUG_SAFE, EFF_LONG_SLUG_SAFE_SET } from "./wordlist.js";

// Page + skill-template assets bundled by wrangler's Text module rules
// (see wrangler.toml `[[rules]]`). Each import is the file contents as a
// string at build time — no filesystem access at runtime.
import LANDING_HTML from "./pages/landing.html";
import DASHBOARD_HTML from "./pages/dashboard.html";
import SLUG_HTML_TEMPLATE from "./pages/slug.html.template";
import DEAD_SLUG_HTML from "./pages/dead-slug.html";
import SKILL_TEMPLATE_GOOGLE_WHOAMI from "./skill-templates/google.whoami.md.template";

export { SlugBox } from "./slug-box.js";

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await route(req, env);
    } catch (err) {
      // Generic 500 — never leak error details to the user. Real cause goes
      // to wrangler tail for the operator.
      console.error("unhandled_error", err instanceof Error ? err.message : String(err));
      return jsonResponse({ error: "internal" }, 500);
    }
  },
};

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // -----------------------------------------------------------------
  // Static + session-gated pages
  // -----------------------------------------------------------------
  if (method === "GET" && path === "/") {
    return htmlResponse(LANDING_HTML);
  }

  if (method === "GET" && path === "/dashboard") {
    const user = await readSessionUser(req, env);
    if (!user) return redirect("/");
    return htmlResponse(DASHBOARD_HTML);
  }

  // -----------------------------------------------------------------
  // Auth
  // -----------------------------------------------------------------
  if (method === "POST" && path === "/api/auth/request") {
    return handleAuthRequest(req, env, url);
  }

  if (method === "GET" && path === "/api/auth/verify") {
    return handleAuthVerify(req, env, url);
  }

  if (method === "POST" && path === "/api/auth/logout") {
    return handleAuthLogout(env);
  }

  if (method === "GET" && path === "/api/me") {
    return handleMe(req, env);
  }

  // -----------------------------------------------------------------
  // Profile proxy (session-gated; forwards to box with shared secret)
  // -----------------------------------------------------------------
  if (method === "GET" && path === "/api/profiles") {
    return withSession(req, env, () => handleProfilesList(env));
  }

  const profileStartLogin = path.match(/^\/api\/profiles\/([a-z][a-z0-9-]{0,63})\/start-login$/);
  if (method === "POST" && profileStartLogin) {
    const name = profileStartLogin[1] as string;
    return withSession(req, env, () =>
      proxyToBox(env, "POST", `/profiles/${name}/start-login${url.search}`, req),
    );
  }

  const profileSave = path.match(/^\/api\/profiles\/([a-z][a-z0-9-]{0,63})\/save$/);
  if (method === "POST" && profileSave) {
    const name = profileSave[1] as string;
    return withSession(req, env, () =>
      proxyToBox(env, "POST", `/profiles/${name}/save`, req),
    );
  }

  const profileDelete = path.match(/^\/api\/profiles\/([a-z][a-z0-9-]{0,63})$/);
  if (method === "DELETE" && profileDelete) {
    const name = profileDelete[1] as string;
    return withSession(req, env, () =>
      proxyToBox(env, "DELETE", `/profiles/${name}`),
    );
  }

  // -----------------------------------------------------------------
  // Mint slug
  // -----------------------------------------------------------------
  if (method === "POST" && path === "/api/mint") {
    return withSession(req, env, () => handleMint(req, env, url));
  }

  // -----------------------------------------------------------------
  // Reauth marker — clear the `expired:<profile>` flag after re-login.
  // Session-gated so only the operator can clear flags.
  // -----------------------------------------------------------------
  const profileReauth = path.match(
    /^\/api\/profiles\/([a-z][a-z0-9-]{0,63})\/clear-expired$/,
  );
  if (method === "POST" && profileReauth) {
    const name = profileReauth[1] as string;
    return withSession(req, env, async () => {
      await env.KV.delete(`expired:${name}`);
      return jsonResponse({ ok: true }, 200);
    });
  }

  // -----------------------------------------------------------------
  // Audit feed — session-gated. Proxies to box /audit, parses TSV records,
  // strips request_id (internal trace ID) before returning.
  // -----------------------------------------------------------------
  if (method === "GET" && path === "/api/audit") {
    return withSession(req, env, () => handleAuditList(env));
  }

  // -----------------------------------------------------------------
  // Action call (bearer-gated, public)
  // -----------------------------------------------------------------
  const actionCall = path.match(
    /^\/api\/actions\/([a-z][a-z0-9-]{0,63})\/([A-Za-z0-9._-]{1,64})$/,
  );
  if (method === "POST" && actionCall) {
    const profile = actionCall[1] as string;
    const action_id = actionCall[2] as string;
    return handleActionCall(req, env, profile, action_id);
  }

  // -----------------------------------------------------------------
  // Slug redeem — must be last so it doesn't shadow /api/* and /dashboard.
  // -----------------------------------------------------------------
  if (method === "GET") {
    const slugMatch = path.match(/^\/([a-z]+-[a-z]+)$/);
    if (slugMatch) return handleSlugRedeem(env, slugMatch[1] as string);
  }

  return new Response("not found", { status: 404 });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleAuthRequest(req: Request, env: Env, url: URL): Promise<Response> {
  let body: { email?: unknown };
  try {
    body = (await req.json()) as { email?: unknown };
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonResponse({ error: "invalid_email" }, 400);
  }
  if (!isEmailAllowed(env, email)) {
    return jsonResponse({ error: "not_allowed" }, 403);
  }
  const token = await mintMagicToken(env, email);
  const magicUrl = `${url.origin}/api/auth/verify?token=${encodeURIComponent(token)}`;
  await sendMagicLinkEmail(env, email, magicUrl);
  return jsonResponse({ ok: true }, 200);
}

async function handleAuthVerify(req: Request, env: Env, url: URL): Promise<Response> {
  const token = url.searchParams.get("token") ?? "";
  if (!/^[0-9a-f]{32}$/.test(token)) {
    return new Response("invalid token", { status: 400 });
  }
  const email = await consumeMagicToken(env, token);
  if (!email) return new Response("invalid or expired token", { status: 400 });
  const sessionToken = await createSession(env, email);
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/dashboard",
      "Set-Cookie": buildSessionCookie(sessionToken, env.COOKIE_DOMAIN),
    },
  });
}

function handleAuthLogout(env: Env): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/",
      "Set-Cookie": buildClearCookie(env.COOKIE_DOMAIN),
    },
  });
}

async function handleMe(req: Request, env: Env): Promise<Response> {
  const user = await readSessionUser(req, env);
  if (!user) return jsonResponse({ error: "unauthenticated" }, 401);
  return jsonResponse({ email: user.email }, 200);
}

interface MintBody {
  profile?: unknown;
  action_id?: unknown;
  payload_shape?: unknown;
  ttl_seconds?: unknown;
}

async function handleMint(req: Request, env: Env, url: URL): Promise<Response> {
  // Per-session rate limit. withSession already established the cookie is
  // valid, so readSessionToken is guaranteed to return a token here — but be
  // defensive and 401 anyway if it somehow returns null.
  const sessionToken = readSessionToken(req);
  if (!sessionToken) return jsonResponse({ error: "unauthenticated" }, 401);
  const rl = await checkMintRateLimit(env, sessionToken);
  if (!rl.ok) {
    return jsonResponse(
      { error: "rate_limited", retry_after_seconds: rl.retry_after_seconds },
      429,
      { "Retry-After": String(rl.retry_after_seconds) },
    );
  }

  let body: MintBody;
  try {
    body = (await req.json()) as MintBody;
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  const profile = typeof body.profile === "string" ? body.profile : "";
  const action_id = typeof body.action_id === "string" ? body.action_id : "";
  const ttl_seconds = typeof body.ttl_seconds === "number" ? body.ttl_seconds : NaN;

  if (!/^[a-z][a-z0-9-]{0,63}$/.test(profile)) {
    return jsonResponse({ error: "invalid_profile" }, 400);
  }
  if (!isActionAllowed(action_id)) {
    return jsonResponse({ error: "action_not_allowed", allowed: [...ACTION_ALLOWLIST] }, 400);
  }
  if (
    !Number.isFinite(ttl_seconds) ||
    !Number.isInteger(ttl_seconds) ||
    ttl_seconds < ACTION_TTL_BOUNDS.min ||
    ttl_seconds > ACTION_TTL_BOUNDS.max
  ) {
    return jsonResponse({ error: "invalid_ttl_seconds", bounds: ACTION_TTL_BOUNDS }, 400);
  }

  const shape_hash = await payloadShapeHash(body.payload_shape ?? null);
  const bearer = await mintBearer(env, {
    profile,
    action_id,
    payload_shape_hash: shape_hash,
    ttl_seconds,
  });

  const expires_at = new Date(Date.now() + ttl_seconds * 1000).toISOString();
  const action_url = `${url.origin}/api/actions/${profile}/${action_id}`;
  const markdown = renderSkillMarkdown(action_id, {
    bearer,
    action_url,
    profile,
    action_id,
    expires_at,
  });

  // Roll slug, claim via DO, retry on collision. With 7772^2 ~= 6e7 namespace
  // and a single-user MVP, collisions should be near-zero, but the retry loop
  // is cheap insurance.
  const ttl_expires_at = Date.now() + ttl_seconds * 1000;
  let slug = "";
  let claimed = false;
  for (let attempt = 0; attempt < 3 && !claimed; attempt++) {
    slug = rollSlug();
    const stub = env.SLUG_NS.get(env.SLUG_NS.idFromName(slug));
    const claimRes = await stub.fetch("https://slug/claim", {
      method: "POST",
      body: JSON.stringify({
        markdown,
        profile,
        action_id,
        ttl_expires_at,
        max_calls: 1,
      }),
      headers: { "Content-Type": "application/json" },
    });
    if (claimRes.status === 201) {
      claimed = true;
    } else if (claimRes.status !== 409) {
      return jsonResponse({ error: "slug_claim_failed", status: claimRes.status }, 502);
    }
  }
  if (!claimed) {
    return jsonResponse({ error: "slug_collision" }, 503);
  }

  return jsonResponse({ slug, url: `${url.origin}/${slug}` }, 200);
}

async function handleSlugRedeem(env: Env, slug: string): Promise<Response> {
  // Defense in depth: regex already matched `[a-z]+-[a-z]+`, also require both
  // halves to be in the slug-safe wordlist subset.
  const dash = slug.indexOf("-");
  if (dash < 1 || dash === slug.length - 1) return deadSlugResponse();
  const left = slug.slice(0, dash);
  const right = slug.slice(dash + 1);
  if (!EFF_LONG_SLUG_SAFE_SET.has(left) || !EFF_LONG_SLUG_SAFE_SET.has(right)) {
    return deadSlugResponse();
  }

  const stub = env.SLUG_NS.get(env.SLUG_NS.idFromName(slug));
  const res = await stub.fetch("https://slug/consume", { method: "GET" });
  if (res.status === 410) return deadSlugResponse();
  if (res.status !== 200) return deadSlugResponse();
  const stored = (await res.json()) as { markdown?: unknown };
  const md = typeof stored.markdown === "string" ? stored.markdown : "";
  const html = SLUG_HTML_TEMPLATE.replace("{{MARKDOWN_HTML_ESCAPED}}", htmlEscape(md));
  return slugHtmlResponse(html);
}

async function handleActionCall(
  req: Request,
  env: Env,
  profile: string,
  action_id: string,
): Promise<Response> {
  const started = Date.now();
  const auth = req.headers.get("Authorization") ?? "";
  const m = auth.match(/^Bearer\s+([0-9a-f]{32})$/i);
  if (!m) {
    logActionResult("-", profile, action_id, 401, Date.now() - started);
    return jsonResponse({ error: "missing_bearer", code: "not_found" }, 401);
  }
  const token = (m[1] as string).toLowerCase();

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    logActionResult("-", profile, action_id, 400, Date.now() - started);
    return jsonResponse({ error: "invalid_json", code: "payload_shape_mismatch" }, 400);
  }

  const verdict = await verifyBearer(env, token, profile, action_id, payload);
  if (!verdict.ok) {
    logActionResult("-", profile, action_id, verdict.status, Date.now() - started);
    return jsonResponse({ error: verdict.code, code: verdict.code }, verdict.status);
  }

  const request_id = crypto.randomUUID();
  // Do not include the user payload in any log line.
  const boxRes = await fetch(`${env.BOX_ORIGIN}/run`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.BOX_SHARED_SECRET}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ profile, action_id, payload, request_id }),
  });

  logActionResult(request_id, profile, action_id, boxRes.status, Date.now() - started);

  // The box has no notion of "expired" — it just sees that Playwright bounced
  // to login. When that happens it returns 503 {error: "auth_expired"}. The
  // broker translates that into a persistent `expired:<profile>` KV marker
  // so the dashboard can render a yellow banner without re-running the action.
  // We must clone the body to read it for the marker decision AND pass it
  // through to the caller unchanged.
  if (boxRes.status === 503) {
    const cloned = boxRes.clone();
    let parsed: { error?: unknown } | null = null;
    try {
      parsed = (await cloned.json()) as { error?: unknown };
    } catch {
      parsed = null;
    }
    if (parsed && parsed.error === "auth_expired") {
      const marker = {
        request_id,
        expired_at: new Date().toISOString(),
      };
      // 30-day TTL — survives a forgetful operator; dashboard banner shows it.
      // Cleared by POST /api/profiles/:name/clear-expired after reauth.
      await env.KV.put(`expired:${profile}`, JSON.stringify(marker), {
        expirationTtl: 30 * 24 * 3600,
      }).catch(() => undefined);
    }
  }

  // Stream the box's response back unchanged — don't materialize the body.
  return new Response(boxRes.body, {
    status: boxRes.status,
    headers: filterUpstreamHeaders(boxRes.headers),
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withSession(
  req: Request,
  env: Env,
  fn: () => Promise<Response>,
): Promise<Response> {
  const user = await readSessionUser(req, env);
  if (!user) return jsonResponse({ error: "unauthenticated" }, 401);
  return fn();
}

/**
 * GET /api/profiles — fetches the raw list from the box, then decorates each
 * entry with `status: "expired" | "ready"` by checking the KV `expired:<name>`
 * marker. The box itself has no concept of expiry (just files on disk) — the
 * marker is set by handleActionCall when the box returns 503 auth_expired.
 */
async function handleProfilesList(env: Env): Promise<Response> {
  const boxRes = await proxyToBox(env, "GET", "/profiles");
  if (boxRes.status !== 200) {
    // Pass non-200s through untouched — the dashboard handles errors.
    return boxRes;
  }
  let parsed: { profiles?: unknown } = {};
  try {
    parsed = (await boxRes.json()) as { profiles?: unknown };
  } catch {
    return jsonResponse({ error: "upstream_invalid_json" }, 502);
  }
  const profiles = Array.isArray(parsed.profiles) ? parsed.profiles : [];

  // Parallel-fetch all expiry markers. Single-user MVP — list stays small.
  const decorated = await Promise.all(
    profiles.map(async (entry) => {
      if (!entry || typeof entry !== "object") return entry;
      const name = (entry as { name?: unknown }).name;
      if (typeof name !== "string") return entry;
      const marker = await env.KV.get(`expired:${name}`);
      if (!marker) return { ...(entry as object), status: "ready" as const };
      let expired_at: string | undefined;
      try {
        const parsedMarker = JSON.parse(marker) as { expired_at?: unknown };
        if (typeof parsedMarker.expired_at === "string") {
          expired_at = parsedMarker.expired_at;
        }
      } catch {
        // Corrupt marker — fall through with status only.
      }
      return {
        ...(entry as object),
        status: "expired" as const,
        ...(expired_at ? { expired_at } : {}),
      };
    }),
  );
  return jsonResponse({ profiles: decorated }, 200);
}

/**
 * GET /api/audit — fetches the last 100 raw TSV audit lines from the box,
 * parses each into a structured record, and returns the last 100 newest-first.
 * We strip request_id before returning — it's an internal trace ID with no
 * value to the dashboard. Malformed lines are skipped silently.
 */
async function handleAuditList(env: Env): Promise<Response> {
  const boxRes = await fetch(`${env.BOX_ORIGIN}/audit`, {
    headers: {
      Authorization: `Bearer ${env.BOX_SHARED_SECRET}`,
      "Content-Type": "application/json",
    },
  });
  if (boxRes.status !== 200) {
    return jsonResponse({ error: "upstream_audit_failed", status: boxRes.status }, 502);
  }
  let parsed: { lines?: unknown } = {};
  try {
    parsed = (await boxRes.json()) as { lines?: unknown };
  } catch {
    return jsonResponse({ error: "upstream_invalid_json" }, 502);
  }
  const rawLines = Array.isArray(parsed.lines) ? parsed.lines : [];
  const entries: Array<{
    ts: string;
    profile: string;
    action_id: string;
    status: string;
    bytes: number;
  }> = [];
  for (const line of rawLines) {
    if (typeof line !== "string") continue;
    // Format: <iso>\t<request_id>\t<profile>\t<action_id>\t<status>\t<bytes>
    const parts = line.split("\t");
    if (parts.length < 6) continue;
    const ts = parts[0] as string;
    // parts[1] is request_id — deliberately not exposed.
    const profile = parts[2] as string;
    const action_id = parts[3] as string;
    const status = parts[4] as string;
    const bytes = parseInt(parts[5] as string, 10);
    entries.push({
      ts,
      profile,
      action_id,
      status,
      bytes: Number.isFinite(bytes) ? bytes : 0,
    });
  }
  // Limit to last 100 (audit endpoint already caps, but be defensive).
  const limited = entries.slice(-100);
  return jsonResponse({ entries: limited }, 200);
}

async function proxyToBox(
  env: Env,
  method: string,
  pathAndQuery: string,
  forwardReq?: Request,
): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${env.BOX_SHARED_SECRET}`,
      "Content-Type": "application/json",
    },
  };
  if (forwardReq && method !== "GET" && method !== "HEAD") {
    // Pass through the request body (already buffered by Workers runtime).
    init.body = await forwardReq.text();
  }
  const res = await fetch(`${env.BOX_ORIGIN}${pathAndQuery}`, init);
  return new Response(res.body, {
    status: res.status,
    headers: filterUpstreamHeaders(res.headers),
  });
}

function filterUpstreamHeaders(headers: Headers): Headers {
  const out = new Headers();
  const ct = headers.get("Content-Type");
  if (ct) out.set("Content-Type", ct);
  return out;
}

function rollSlug(): string {
  const a = randomWord();
  let b = randomWord();
  // Avoid the same word twice — looks like a bug to humans, costs nothing.
  while (b === a) b = randomWord();
  return `${a}-${b}`;
}

function randomWord(): string {
  // Rejection sampling so the distribution is exactly uniform over the
  // wordlist length (avoids modulo bias from a naive % len).
  const n = EFF_LONG_SLUG_SAFE.length;
  const cap = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    const r = buf[0] as number;
    if (r < cap) return EFF_LONG_SLUG_SAFE[r % n] as string;
  }
}

interface SkillTemplateVars {
  bearer: string;
  action_url: string;
  profile: string;
  action_id: string;
  expires_at: string;
}

function renderSkillMarkdown(action_id: string, vars: SkillTemplateVars): string {
  // Phase 5 will introduce per-action templates from skill-templates/. For
  // now we only have google.whoami; if more land before Phase 5, extend here.
  const template =
    action_id === "google.whoami" ? SKILL_TEMPLATE_GOOGLE_WHOAMI : SKILL_TEMPLATE_GOOGLE_WHOAMI;
  // replaceAll — the template references each placeholder multiple times
  // (e.g. {{PROFILE}} in the failure-mode table, {{BEARER}} in the curl
  // example). String.replace replaces only the first match, which leaks
  // raw placeholders into the rendered markdown.
  return template
    .replaceAll("{{BEARER}}", vars.bearer)
    .replaceAll("{{ACTION_URL}}", vars.action_url)
    .replaceAll("{{PROFILE}}", vars.profile)
    .replaceAll("{{ACTION_ID}}", vars.action_id)
    .replaceAll("{{EXPIRES_AT}}", vars.expires_at);
}

function logActionResult(
  request_id: string,
  profile: string,
  action_id: string,
  status: number,
  ms: number,
): void {
  // Structured, fixed-field log line. NEVER add the request body to this.
  console.log(JSON.stringify({ request_id, profile, action_id, status, ms }));
}

function jsonResponse(body: unknown, status: number, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store, private");
  return new Response(JSON.stringify(body), { status, headers });
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, private",
    },
  });
}

function slugHtmlResponse(html: string): Response {
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Critical: never cache the slug-burn response — the markdown is
      // single-use and must not be re-served from any cache.
      "Cache-Control": "no-store, private",
      "X-Robots-Tag": "noindex, nofollow",
      // Lock the page down: no outbound network at all (no fetch / XHR / WS /
      // image / font / connect). Inline styles + inline scripts allowed so the
      // slug page can offer a "Copy" button without external assets.
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none'",
    },
  });
}

function deadSlugResponse(): Response {
  return new Response(DEAD_SLUG_HTML, {
    status: 410,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, private",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } });
}
