// Session cookie + KV-backed session store.
//
// Token is a 32-hex random string. Storage key is sha256(token) so the raw
// token never sits in KV — if a snapshot of KV leaks, sessions cannot be
// hijacked from the dump alone.

import { randomTokenHex, sha256Hex } from "./crypto-util.js";

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const COOKIE_NAME = "humanish_session";

export interface SessionUser {
  email: string;
}

interface StoredSession {
  email: string;
  created_at: number;
}

export async function createSession(env: Env, email: string): Promise<string> {
  const token = randomTokenHex(16); // 32 hex chars
  const hash = await sha256Hex(token);
  const value: StoredSession = { email, created_at: Date.now() };
  await env.KV.put(`session:${hash}`, JSON.stringify(value), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
  return token;
}

export async function readSessionUser(
  req: Request,
  env: Env,
): Promise<SessionUser | null> {
  const cookieHeader = req.headers.get("Cookie") ?? "";
  const token = parseCookie(cookieHeader, COOKIE_NAME);
  if (!token) return null;
  // Cookie tokens are 32 hex chars; reject anything else without a KV lookup.
  if (!/^[0-9a-f]{32}$/.test(token)) return null;
  const hash = await sha256Hex(token);
  const raw = await env.KV.get(`session:${hash}`);
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw) as StoredSession;
    if (typeof stored?.email !== "string") return null;
    return { email: stored.email };
  } catch {
    return null;
  }
}

// `domain` is optional. On a *.workers.dev host the cookie is host-only (no
// Domain=) because workers.dev is on the Public Suffix List. Pass the apex
// only when we're on a custom domain we own.
export function buildSessionCookie(token: string, domain?: string): string {
  return formatCookie(COOKIE_NAME, token, SESSION_TTL_SECONDS, domain);
}

export function buildClearCookie(domain?: string): string {
  return formatCookie(COOKIE_NAME, "", 0, domain);
}

function formatCookie(
  name: string,
  value: string,
  maxAge: number,
  domain?: string,
): string {
  const parts = [
    `${name}=${value}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ];
  if (domain && !isWorkersDevHost(domain)) {
    parts.push(`Domain=${domain}`);
  }
  return parts.join("; ");
}

function isWorkersDevHost(domain: string): boolean {
  return domain === "workers.dev" || domain.endsWith(".workers.dev");
}

function parseCookie(header: string, name: string): string | null {
  if (!header) return null;
  const parts = header.split(/;\s*/);
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (key !== name) continue;
    return part.slice(eq + 1).trim();
  }
  return null;
}
