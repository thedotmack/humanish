// Magic-link auth: mint a one-time token, email a verification URL, redeem
// the token on click, swap it for a session cookie (see session.ts).
//
// MVP scope: single-user broker. ALLOWED_EMAILS gates who can even request a
// link; the rest of the flow stays minimal (no rate limiting, no password
// reset, no second factor).

import { htmlEscape, randomTokenHex } from "./crypto-util.js";

const MAGIC_TTL_SECONDS = 15 * 60; // 15 minutes

export async function sendMagicLinkEmail(
  env: Env,
  email: string,
  magicUrl: string,
): Promise<void> {
  const escapedUrl = htmlEscape(magicUrl);
  const body = {
    from: env.FROM_EMAIL,
    to: [email],
    subject: "Sign in to humanish",
    html: `<p>Click <a href="${escapedUrl}">here</a> to sign in. Link expires in 15 minutes.</p>`,
    text: `Sign in to humanish: ${magicUrl} (expires in 15 minutes)`,
  };
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`resend send failed (${res.status}): ${text}`);
  }
}

export async function mintMagicToken(env: Env, email: string): Promise<string> {
  const token = randomTokenHex(16); // 32 hex chars
  await env.KV.put(`magic:${token}`, email, {
    expirationTtl: MAGIC_TTL_SECONDS,
  });
  return token;
}

// One-shot redemption: read, then delete. KV is eventually consistent so the
// delete is best-effort within seconds; for a single-user MVP this is fine.
export async function consumeMagicToken(
  env: Env,
  token: string,
): Promise<string | null> {
  const email = await env.KV.get(`magic:${token}`);
  if (!email) return null;
  await env.KV.delete(`magic:${token}`);
  return email;
}

export function isEmailAllowed(env: Env, email: string): boolean {
  const raw = env.ALLOWED_EMAILS ?? "";
  const needle = email.trim().toLowerCase();
  if (!needle) return false;
  for (const candidate of raw.split(",")) {
    if (candidate.trim().toLowerCase() === needle) return true;
  }
  return false;
}
