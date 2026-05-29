// Tiny crypto/encoding helpers shared across broker modules.
// All helpers are pure and side-effect-free (apart from getRandomValues).

export function bufferToHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i] as number;
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

export function randomTokenHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return bufferToHex(buf);
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bufferToHex(digest);
}

// Escapes the five XML/HTML-significant characters. Used wherever untrusted
// strings are interpolated into rendered HTML (slug page markdown, magic URL
// in the email body, etc.).
export function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Length-independent constant-time comparison. Returns false immediately if
// lengths differ (length itself is not secret in our usage — token length is
// fixed by the minting function), then folds an XOR over every byte so the
// timing does not depend on where the first mismatch is.
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
