// Append-only audit log.
//
// One line per request, tab-separated:
//   <iso>\t<request_id>\t<profile>\t<action_id>\t<status>\t<bytes>\n
//
// NEVER write payload contents — only scrubbed metadata. Bytes is the
// size of the JSON-stringified response so we have something to graph.
// Rotation is the operator's problem (logrotate / fly logs) and will be
// handled in Phase 8.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { env } from "./env.js";

export interface AuditLine {
  request_id: string;
  profile: string;
  action_id: string;
  status: string; // "ok" | "error:<code>" | "action_not_found"
  bytes: number;
}

let initPromise: Promise<void> | null = null;

async function ensureAuditDir(): Promise<void> {
  if (!initPromise) {
    initPromise = fs
      .mkdir(path.dirname(env.AUDIT_LOG_PATH), { recursive: true })
      .then(() => undefined);
  }
  await initPromise;
}

function safeField(value: string): string {
  // No tabs or newlines in a field — replace defensively. We don't expect
  // any of these in our controlled inputs (request_id is a ULID, profile
  // is regex-validated, action_id is a registry key) but be safe.
  return value.replace(/[\t\r\n]/g, "_");
}

export async function appendAuditLine(line: AuditLine): Promise<void> {
  await ensureAuditDir();
  const fields = [
    new Date().toISOString(),
    safeField(line.request_id),
    safeField(line.profile),
    safeField(line.action_id),
    safeField(line.status),
    String(line.bytes | 0),
  ];
  await fs.appendFile(env.AUDIT_LOG_PATH, `${fields.join("\t")}\n`);
}

/**
 * Tail the audit log. Best-effort: reads the entire file and slices the
 * last N lines. Phase 8 will replace this with proper rotation-aware
 * tail reads.
 */
export async function readRecentAuditLines(
  limit: number = 100,
): Promise<string[]> {
  let raw: string;
  try {
    raw = await fs.readFile(env.AUDIT_LOG_PATH, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const lines = raw.split("\n").filter((line) => line.length > 0);
  return lines.slice(Math.max(0, lines.length - limit));
}
