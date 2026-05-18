// Encrypted profile storage on the Fly volume.
//
// On disk:
//   ${PROFILES_DIR}/<profile-name>.bin    — AES-GCM encrypted Playwright storageState JSON
//   ${PROFILES_DIR}/<profile-name>.bin.tmp — transient, only present during atomic writes
//
// We never write plaintext to disk. The plaintext only lives in memory
// inside an action's handler invocation.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { env } from "./env.js";
import { decryptProfile, encryptProfile } from "./crypto.js";

const PROFILE_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

export class InvalidProfileName extends Error {
  code = "invalid_profile_name" as const;
  constructor(name: string) {
    super(`invalid profile name: ${JSON.stringify(name)}`);
  }
}

function validateProfileName(name: string): void {
  if (typeof name !== "string" || !PROFILE_NAME_RE.test(name)) {
    throw new InvalidProfileName(name);
  }
}

function profilePath(name: string): string {
  return path.join(env.PROFILES_DIR, `${name}.bin`);
}

export interface ProfileListEntry {
  name: string;
  has_blob: boolean;
  mtime: string; // ISO 8601
}

/**
 * Enumerate stored profiles. Returns [] if the directory does not exist
 * yet (first boot, no profiles saved).
 */
export async function listProfiles(): Promise<ProfileListEntry[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(env.PROFILES_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
  const blobNames = entries.filter((entry) => entry.endsWith(".bin"));
  const out: ProfileListEntry[] = [];
  for (const fileName of blobNames) {
    const name = fileName.slice(0, -".bin".length);
    if (!PROFILE_NAME_RE.test(name)) {
      // Skip files that don't match the schema rather than crashing the list call.
      continue;
    }
    const stat = await fs.stat(path.join(env.PROFILES_DIR, fileName));
    out.push({
      name,
      has_blob: true,
      mtime: stat.mtime.toISOString(),
    });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/**
 * Read and decrypt a profile. Throws InvalidProfileName for bad names and
 * a generic Error for missing or unauthenticated blobs.
 */
export async function readProfile(name: string): Promise<string> {
  validateProfileName(name);
  const blob = await fs.readFile(profilePath(name));
  return decryptProfile(name, blob);
}

/**
 * Encrypt and write a profile atomically:
 *   1. write to <name>.bin.tmp
 *   2. rename to <name>.bin (POSIX atomic on the same filesystem)
 */
export async function writeProfileAtomic(
  name: string,
  plaintextJson: string,
): Promise<{ bytes: number }> {
  validateProfileName(name);
  const ciphertext = await encryptProfile(name, plaintextJson);
  await fs.mkdir(env.PROFILES_DIR, { recursive: true });
  const finalPath = profilePath(name);
  const tmpPath = `${finalPath}.tmp`;
  await fs.writeFile(tmpPath, ciphertext, { mode: 0o600 });
  await fs.rename(tmpPath, finalPath);
  return { bytes: ciphertext.length };
}

/**
 * Delete a profile blob. Idempotent: missing files are not an error.
 */
export async function deleteProfile(name: string): Promise<void> {
  validateProfileName(name);
  try {
    await fs.unlink(profilePath(name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

export async function profileExists(name: string): Promise<boolean> {
  validateProfileName(name);
  try {
    await fs.access(profilePath(name));
    return true;
  } catch {
    return false;
  }
}
