// Tests for the AES-GCM profile crypto module.
//
// crypto.ts initializes its key from process.env.HUMANISH_MASTER_KEY in a
// top-level promise at module load time. To test both the happy path and
// the "invalid key length" failure mode, we use vi.resetModules() + dynamic
// import() so each test gets a fresh module evaluation with the env var
// set to whatever the test needs.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";

// Node 18+ already exposes globalThis.crypto, but be defensive in case
// some environment doesn't. crypto.ts uses globalThis.crypto.subtle and
// globalThis.crypto.getRandomValues directly.
if (typeof globalThis.crypto === "undefined") {
  // @ts-expect-error — patching globalThis for the test environment only.
  globalThis.crypto = webcrypto;
}

function freshKeyB64(): string {
  // 32 random bytes, base64-encoded.
  const raw = new Uint8Array(32);
  globalThis.crypto.getRandomValues(raw);
  return Buffer.from(raw).toString("base64");
}

async function importCrypto() {
  // Dynamic import after env is set so the top-level KEY_PROMISE
  // captures the current HUMANISH_MASTER_KEY value.
  return await import("../crypto.js");
}

describe("encryptProfile / decryptProfile round-trip", () => {
  const savedEnv = process.env.HUMANISH_MASTER_KEY;

  beforeEach(() => {
    vi.resetModules();
    process.env.HUMANISH_MASTER_KEY = freshKeyB64();
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.HUMANISH_MASTER_KEY;
    else process.env.HUMANISH_MASTER_KEY = savedEnv;
  });

  it("recovers the exact plaintext for the same profile name", async () => {
    const { encryptProfile, decryptProfile } = await importCrypto();
    const plaintext = "hello humanish — UTF-8 with é, ü, 漢";
    const blob = await encryptProfile("alice", plaintext);
    const recovered = await decryptProfile("alice", blob);
    expect(recovered).toBe(plaintext);
  });

  it("AAD tampering: blob encrypted as alice cannot be decrypted as bob", async () => {
    const { encryptProfile, decryptProfile } = await importCrypto();
    const blob = await encryptProfile("alice", "secret-for-alice");
    // GCM tag verification must fail because AAD (profile name) differs.
    await expect(decryptProfile("bob", blob)).rejects.toThrow();
  });

  it("ciphertext tampering: flipping one byte in the blob causes decrypt to throw", async () => {
    const { encryptProfile, decryptProfile } = await importCrypto();
    const blob = await encryptProfile("alice", "payload");
    // Flip a byte inside the ciphertext body (not the IV) by XOR-ing 0xFF.
    // Index 20 is well past the 12-byte IV and inside the ciphertext+tag region.
    const tampered = Buffer.from(blob);
    tampered[20] = (tampered[20] ?? 0) ^ 0xff;
    await expect(decryptProfile("alice", tampered)).rejects.toThrow();
  });

  it("IV uniqueness: two encryptions of the same plaintext produce different ciphertexts", async () => {
    const { encryptProfile } = await importCrypto();
    const plaintext = "deterministic plaintext";
    const blobA = await encryptProfile("alice", plaintext);
    const blobB = await encryptProfile("alice", plaintext);
    expect(Buffer.compare(blobA, blobB)).not.toBe(0);
    // And the first 12 bytes (IV) should differ with overwhelming probability.
    expect(Buffer.compare(blobA.subarray(0, 12), blobB.subarray(0, 12))).not.toBe(0);
  });

  it("empty plaintext round-trips through encrypt/decrypt", async () => {
    const { encryptProfile, decryptProfile } = await importCrypto();
    const blob = await encryptProfile("alice", "");
    // Minimum size: 12B IV + 16B GCM tag (no ciphertext bytes for empty input).
    expect(blob.length).toBe(12 + 16);
    const recovered = await decryptProfile("alice", blob);
    expect(recovered).toBe("");
  });

  it("256 KB plaintext round-trips", async () => {
    const { encryptProfile, decryptProfile } = await importCrypto();
    const plaintext = "x".repeat(256 * 1024);
    const blob = await encryptProfile("alice", plaintext);
    const recovered = await decryptProfile("alice", blob);
    expect(recovered.length).toBe(plaintext.length);
    expect(recovered).toBe(plaintext);
  });

  it("blob too short to be valid AES-GCM ciphertext throws with clear message", async () => {
    const { decryptProfile } = await importCrypto();
    const tiny = Buffer.alloc(10); // less than the 12-byte IV alone
    await expect(decryptProfile("alice", tiny)).rejects.toThrow(/too short/i);
  });
});

describe("HUMANISH_MASTER_KEY validation", () => {
  const savedEnv = process.env.HUMANISH_MASTER_KEY;

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.HUMANISH_MASTER_KEY;
    else process.env.HUMANISH_MASTER_KEY = savedEnv;
  });

  it("rejects a 16-byte key (must be exactly 32 bytes after base64-decode)", async () => {
    vi.resetModules();
    // 16 random bytes, base64-encoded.
    const raw = new Uint8Array(16);
    globalThis.crypto.getRandomValues(raw);
    process.env.HUMANISH_MASTER_KEY = Buffer.from(raw).toString("base64");
    const { encryptProfile } = await importCrypto();
    await expect(encryptProfile("alice", "hi")).rejects.toThrow(/32 bytes/);
  });

  it("rejects an unset HUMANISH_MASTER_KEY with a clear error", async () => {
    vi.resetModules();
    delete process.env.HUMANISH_MASTER_KEY;
    const { encryptProfile } = await importCrypto();
    await expect(encryptProfile("alice", "hi")).rejects.toThrow(/HUMANISH_MASTER_KEY/);
  });
});
