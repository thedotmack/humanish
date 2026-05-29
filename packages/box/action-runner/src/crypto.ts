// AES-GCM encryption for profile blobs.
//
// Layout on disk: [12-byte random IV][AES-GCM ciphertext+16-byte tag]
//
// AAD (additionalData) is the profile NAME (UTF-8 bytes). This means a
// blob encrypted as "alice.bin" cannot be moved to "bob.bin" — the GCM tag
// will fail verification because the AAD won't match. This is the
// filename-binding defense: an attacker who can rename files on the data
// volume cannot swap a victim's blob into the attacker's profile slot.
//
// Key handling: lazy-initialized once at module load via a top-level
// promise so the key import happens exactly once per process.

const KEY_PROMISE = (async () => {
  const rawBase64 = process.env.HUMANISH_MASTER_KEY;
  if (!rawBase64) {
    throw new Error("HUMANISH_MASTER_KEY is not set");
  }
  const raw = Buffer.from(rawBase64, "base64");
  if (raw.length !== 32) {
    throw new Error("HUMANISH_MASTER_KEY must decode to exactly 32 bytes");
  }
  return globalThis.crypto.subtle.importKey(
    "raw",
    raw,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
})();

/**
 * Encrypt a UTF-8 plaintext into a self-describing blob:
 *   [12B random IV][AES-GCM ciphertext+tag]
 *
 * The profile name is bound via AAD so the resulting blob cannot be moved
 * to a different filename without GCM verification failing on decrypt.
 */
export async function encryptProfile(
  profileName: string,
  plaintext: string,
): Promise<Buffer> {
  const key = await KEY_PROMISE;
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode(profileName);
  const ciphertext = new Uint8Array(
    await globalThis.crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad },
      key,
      new TextEncoder().encode(plaintext),
    ),
  );
  const out = new Uint8Array(12 + ciphertext.length);
  out.set(iv, 0);
  out.set(ciphertext, 12);
  return Buffer.from(out);
}

/**
 * Decrypt a profile blob produced by {@link encryptProfile}.
 * Throws (with a non-leaky message) if the AAD or ciphertext does not
 * authenticate — that's the desired fail-fast behavior. Callers MUST
 * treat any throw here as a hard authentication failure.
 */
export async function decryptProfile(
  profileName: string,
  blob: Buffer,
): Promise<string> {
  if (blob.length < 12 + 16) {
    // 12B IV + at least the 16-byte GCM tag.
    throw new Error("profile blob too short to be valid AES-GCM ciphertext");
  }
  const key = await KEY_PROMISE;
  // Copy into a plain Uint8Array (backed by ArrayBuffer, not the Node
  // Buffer pool / SharedArrayBuffer) so WebCrypto's BufferSource accepts it.
  const ivView = new Uint8Array(blob.subarray(0, 12));
  const ciphertextView = new Uint8Array(blob.subarray(12));
  const aad = new TextEncoder().encode(profileName);
  const plaintext = await globalThis.crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ivView, additionalData: aad },
    key,
    ciphertextView,
  );
  return new TextDecoder().decode(plaintext);
}
