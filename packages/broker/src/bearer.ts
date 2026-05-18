// Slug-bound bearer tokens. A bearer is scoped to {profile, action_id,
// payload_shape_hash} and is consumed on first successful call.
//
// Why payload_shape_hash:
//   The bearer is minted before the agent calls the action, so we can't bind
//   to the exact payload bytes. We bind to the SHAPE — the recursive type
//   skeleton — so an attacker who steals the bearer can't repurpose it to call
//   a wildly different operation. Same fields + same types = same hash;
//   different fields or different types = different hash.

import { randomTokenHex, sha256Hex } from "./crypto-util.js";

export interface BearerScope {
  profile: string;
  action_id: string;
  payload_shape_hash: string;
  ttl_seconds: number;
}

interface StoredBearer {
  profile: string;
  action_id: string;
  payload_shape_hash: string;
  ttl_seconds: number;
  max_calls_remaining: number;
  issued_at: number;
}

export type BearerVerifyResult =
  | { ok: true; scope: StoredBearer }
  | { ok: false; code: BearerErrorCode; status: number };

export type BearerErrorCode =
  | "not_found"
  | "expired"
  | "profile_mismatch"
  | "action_mismatch"
  | "payload_shape_mismatch"
  | "consumed";

// Recursively replaces leaf values with their JSON type tag, then JSON-stringifies
// with sorted object keys, then sha256-hexes. Order-stable across object key
// orderings; value-blind within a given shape.
export async function payloadShapeHash(payload: unknown): Promise<string> {
  const normalized = JSON.stringify(shapeOf(payload));
  return sha256Hex(normalized);
}

type Shape =
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "undefined"
  | Shape[]
  | { [key: string]: Shape };

function shapeOf(value: unknown): Shape {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    // Use only the first element's shape — the bearer scope cares about the
    // homogeneous element shape, not the run-time length.
    if (value.length === 0) return [];
    return [shapeOf(value[0])];
  }
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean" || t === "undefined") {
    return t;
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const out: Record<string, Shape> = {};
    for (const k of keys) out[k] = shapeOf(obj[k]);
    return out;
  }
  // function, symbol, bigint — collapse to a tag so JSON.stringify is stable.
  return "string";
}

export async function mintBearer(
  env: Env,
  scope: BearerScope,
): Promise<string> {
  const token = randomTokenHex(16); // 32 hex chars
  const stored: StoredBearer = {
    ...scope,
    max_calls_remaining: 1,
    issued_at: Date.now(),
  };
  await env.KV.put(`bearer:${token}`, JSON.stringify(stored), {
    expirationTtl: scope.ttl_seconds,
  });
  return token;
}

export async function verifyBearer(
  env: Env,
  token: string,
  profile: string,
  action_id: string,
  payload: unknown,
): Promise<BearerVerifyResult> {
  if (!token || !/^[0-9a-f]{32}$/.test(token)) {
    return { ok: false, code: "not_found", status: 401 };
  }
  const raw = await env.KV.get(`bearer:${token}`);
  // KV returns null both for never-existed and TTL-expired tokens. Treat as
  // expired so the caller distinguishes "bad token shape" from "stale".
  if (!raw) return { ok: false, code: "expired", status: 401 };

  let stored: StoredBearer;
  try {
    stored = JSON.parse(raw) as StoredBearer;
  } catch {
    return { ok: false, code: "not_found", status: 401 };
  }

  if (stored.profile !== profile) {
    return { ok: false, code: "profile_mismatch", status: 403 };
  }
  if (stored.action_id !== action_id) {
    return { ok: false, code: "action_mismatch", status: 403 };
  }
  if (stored.max_calls_remaining <= 0) {
    return { ok: false, code: "consumed", status: 401 };
  }
  const shape = await payloadShapeHash(payload);
  if (shape !== stored.payload_shape_hash) {
    return { ok: false, code: "payload_shape_mismatch", status: 400 };
  }

  // max_calls is always 1 in MVP — delete instead of decrement. KV is
  // eventually consistent so a replay could squeak through in the consistency
  // window; Phase 7 hardening replaces this with a DO if needed.
  await env.KV.delete(`bearer:${token}`);
  return { ok: true, scope: stored };
}
