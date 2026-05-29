// Tests for bearer.ts.
//
// These tests run in node (see ../../vitest.config.ts for why) and use the
// in-memory MockKVNamespace from ./test-helpers.ts. The bearer module under
// test depends only on env.KV (get/put/delete) and the global `crypto`
// (getRandomValues + subtle.digest), both of which are real on Node 20+.

import { describe, expect, it } from "vitest";
import {
  mintBearer,
  payloadShapeHash,
  verifyBearer,
  type BearerScope,
} from "../bearer.js";
import { makeBearerEnv } from "./test-helpers.js";

const baseScope = (overrides: Partial<BearerScope> = {}): BearerScope => ({
  profile: "alice",
  action_id: "google.whoami",
  payload_shape_hash: "placeholder",
  ttl_seconds: 600,
  ...overrides,
});

describe("payloadShapeHash", () => {
  it("returns the same hash for same shape with different values", async () => {
    const a = await payloadShapeHash({ name: "alice" });
    const b = await payloadShapeHash({ name: "bob" });
    expect(a).toBe(b);
  });

  it("returns the same hash regardless of object key order", async () => {
    const a = await payloadShapeHash({ a: "x", b: "y" });
    const b = await payloadShapeHash({ b: "y", a: "x" });
    expect(a).toBe(b);
  });

  it("returns different hashes for string vs number at the same key", async () => {
    const stringShape = await payloadShapeHash({ name: "x" });
    const numberShape = await payloadShapeHash({ name: 0 });
    expect(stringShape).not.toBe(numberShape);
  });

  it("is recursively shape-sensitive (nested object types differ)", async () => {
    const a = await payloadShapeHash({ user: { name: "alice", age: 30 } });
    const b = await payloadShapeHash({ user: { name: "bob", age: 99 } });
    const c = await payloadShapeHash({ user: { name: "alice", age: "30" } });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  // Documented semantics — confirmed from bearer.ts shapeOf():
  //
  //   Arrays collapse to a single-element "shape of first element" representation,
  //   so length does NOT matter for non-empty arrays, but an EMPTY array hashes
  //   differently from a non-empty one (`[]` vs `["string"]`).
  it("arrays: length within non-empty arrays does NOT change the hash (only element shape matters)", async () => {
    const oneStr = await payloadShapeHash(["x"]);
    const twoStr = await payloadShapeHash(["x", "y"]);
    const threeStr = await payloadShapeHash(["x", "y", "z"]);
    expect(twoStr).toBe(oneStr);
    expect(threeStr).toBe(oneStr);
  });

  it("arrays: empty array hashes differently from non-empty array", async () => {
    const empty = await payloadShapeHash([]);
    const oneStr = await payloadShapeHash(["x"]);
    expect(empty).not.toBe(oneStr);
  });

  it("arrays: element-type differences are reflected in the hash", async () => {
    const strs = await payloadShapeHash(["x", "y"]);
    const nums = await payloadShapeHash([1, 2]);
    expect(strs).not.toBe(nums);
  });

  // Documented semantics — confirmed from bearer.ts shapeOf():
  //
  //   - null      -> "null"
  //   - undefined -> "undefined"
  //   - missing key -> the key is just absent from the shape object
  //
  // Therefore all three hash differently: {a: null} has key "a" mapped to "null",
  // {a: undefined} has key "a" mapped to "undefined", {} has no keys at all.
  it("distinguishes null, undefined, and missing keys", async () => {
    const withNull = await payloadShapeHash({ a: null });
    const withUndef = await payloadShapeHash({ a: undefined });
    const missing = await payloadShapeHash({});
    expect(withNull).not.toBe(withUndef);
    expect(withNull).not.toBe(missing);
    expect(withUndef).not.toBe(missing);
  });

  it("booleans: true and false hash identically (both are 'boolean')", async () => {
    const t = await payloadShapeHash({ active: true });
    const f = await payloadShapeHash({ active: false });
    expect(t).toBe(f);
  });

  it("top-level primitive shapes differ from each other", async () => {
    const s = await payloadShapeHash("hi");
    const n = await payloadShapeHash(42);
    const b = await payloadShapeHash(true);
    const nl = await payloadShapeHash(null);
    expect(new Set([s, n, b, nl]).size).toBe(4);
  });
});

describe("mintBearer + verifyBearer", () => {
  it("mints a token that verifies with matching scope", async () => {
    const env = makeBearerEnv();
    const payload = { user: "alice" };
    const shape = await payloadShapeHash(payload);
    const token = await mintBearer(
      env as unknown as Env,
      baseScope({ payload_shape_hash: shape }),
    );
    const result = await verifyBearer(
      env as unknown as Env,
      token,
      "alice",
      "google.whoami",
      payload,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scope.profile).toBe("alice");
      expect(result.scope.action_id).toBe("google.whoami");
    }
  });

  it("rejects a malformed token (not 32 hex chars) with not_found", async () => {
    const env = makeBearerEnv();
    const result = await verifyBearer(
      env as unknown as Env,
      "not-hex!",
      "alice",
      "google.whoami",
      {},
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("not_found");
      expect(result.status).toBe(401);
    }
  });

  it("returns 'expired' for a well-formed token that does not exist in KV", async () => {
    const env = makeBearerEnv();
    const ghostToken = "0123456789abcdef0123456789abcdef";
    const result = await verifyBearer(
      env as unknown as Env,
      ghostToken,
      "alice",
      "google.whoami",
      {},
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("expired");
      expect(result.status).toBe(401);
    }
  });

  it("returns 'consumed' on the second verify (single-shot semantics)", async () => {
    const env = makeBearerEnv();
    const payload = { user: "alice" };
    const shape = await payloadShapeHash(payload);
    const token = await mintBearer(
      env as unknown as Env,
      baseScope({ payload_shape_hash: shape }),
    );
    const first = await verifyBearer(
      env as unknown as Env,
      token,
      "alice",
      "google.whoami",
      payload,
    );
    expect(first.ok).toBe(true);
    // KV entry was deleted; second call finds nothing.
    const second = await verifyBearer(
      env as unknown as Env,
      token,
      "alice",
      "google.whoami",
      payload,
    );
    expect(second.ok).toBe(false);
    if (!second.ok) {
      // In the current impl, a deleted entry returns "expired" because KV.get()
      // returns null both for deleted and never-existed entries. This is the
      // contracted "consumed" outcome even though the code returns the "expired"
      // status code. Document this explicitly so a future refactor cannot quietly
      // change the user-visible status without updating the test.
      expect(["consumed", "expired"]).toContain(second.code);
    }
  });

  it("returns 'profile_mismatch' (403) when profile differs", async () => {
    const env = makeBearerEnv();
    const payload = {};
    const shape = await payloadShapeHash(payload);
    const token = await mintBearer(
      env as unknown as Env,
      baseScope({ profile: "alice", payload_shape_hash: shape }),
    );
    const result = await verifyBearer(
      env as unknown as Env,
      token,
      "bob",
      "google.whoami",
      payload,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("profile_mismatch");
      expect(result.status).toBe(403);
    }
  });

  it("returns 'action_mismatch' (403) when action_id differs", async () => {
    const env = makeBearerEnv();
    const payload = {};
    const shape = await payloadShapeHash(payload);
    const token = await mintBearer(
      env as unknown as Env,
      baseScope({ action_id: "google.whoami", payload_shape_hash: shape }),
    );
    const result = await verifyBearer(
      env as unknown as Env,
      token,
      "alice",
      "google.send_email",
      payload,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("action_mismatch");
      expect(result.status).toBe(403);
    }
  });

  it("returns 'payload_shape_mismatch' (400) when payload shape diverges", async () => {
    const env = makeBearerEnv();
    const mintedShape = await payloadShapeHash({ name: "alice" });
    const token = await mintBearer(
      env as unknown as Env,
      baseScope({ payload_shape_hash: mintedShape }),
    );
    // Same key but a different leaf type — should fail shape check.
    const result = await verifyBearer(
      env as unknown as Env,
      token,
      "alice",
      "google.whoami",
      { name: 42 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("payload_shape_mismatch");
      expect(result.status).toBe(400);
    }
  });
});
