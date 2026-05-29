// Append-only audit log with daily rotation and 30-day retention.
//
// One line per request, tab-separated:
//   <iso>\t<request_id>\t<profile>\t<action_id>\t<status>\t<bytes>\n
//
// NEVER write payload contents — only scrubbed metadata. Bytes is the
// size of the JSON-stringified response so we have something to graph.
//
// Rotation strategy:
//   - Active log is always env.AUDIT_LOG_PATH (e.g. /data/audit.log).
//   - Before each append we check the existing log's mtime. If its UTC date
//     is older than today, rename it to audit-<that-date>.log and start fresh.
//   - On server startup pruneOldLogs() unlinks rotated logs older than 30 days.
//   - We do NOT cron the prune — pruneOldLogs is also opportunistically run
//     once per rotation, which is the only time the rotated-file set changes.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { env } from "./env.js";

const RETENTION_DAYS = 30;
// Filenames look like `audit-2026-05-17.log`. Anchored to avoid matching
// unrelated files that happen to start with `audit-`.
const ROTATED_NAME_PATTERN = /^audit-(\d{4})-(\d{2})-(\d{2})\.log$/;

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

// Format a Date as YYYY-MM-DD in UTC. UTC, not local: rotation must be
// deterministic across container restarts, regardless of host timezone.
function utcDateString(d: Date): string {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * If the existing active log's mtime falls on a different UTC date than
 * `now`, rename it to `audit-<that-date>.log` so a fresh log starts under the
 * active path. No-op if the file does not exist or is already today's.
 *
 * Caller must `await ensureAuditDir()` first.
 */
export async function rotateIfNeeded(now: Date = new Date()): Promise<void> {
  let stats;
  try {
    stats = await fs.stat(env.AUDIT_LOG_PATH);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  const fileDate = utcDateString(stats.mtime);
  const todayDate = utcDateString(now);
  if (fileDate === todayDate) return;

  const dir = path.dirname(env.AUDIT_LOG_PATH);
  const target = path.join(dir, `audit-${fileDate}.log`);
  // If the target already exists (a clock skew / re-rotation edge case),
  // append a suffix so we never clobber a previous day's rotated log.
  let finalTarget = target;
  let suffix = 1;
  while (await pathExists(finalTarget)) {
    finalTarget = path.join(dir, `audit-${fileDate}.${suffix}.log`);
    suffix++;
  }
  await fs.rename(env.AUDIT_LOG_PATH, finalTarget);

  // Take the opportunity to sweep old logs (cheap and only runs on rotation).
  await pruneOldLogs(now).catch(() => undefined);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Unlink rotated audit logs older than RETENTION_DAYS days. Also called from
 * server startup so a long-running container without rotations still cleans
 * up. Active log is never touched.
 */
export async function pruneOldLogs(now: Date = new Date()): Promise<void> {
  const dir = path.dirname(env.AUDIT_LOG_PATH);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  const cutoffMs = now.getTime() - RETENTION_DAYS * 24 * 3600 * 1000;
  for (const entry of entries) {
    const match = ROTATED_NAME_PATTERN.exec(entry);
    if (!match) continue;
    const [, year, month, day] = match;
    // Construct as UTC midnight of that date — pruning is generous (keeps
    // the file for the entire RETENTION_DAYSth day after the date).
    const fileDateMs = Date.UTC(
      parseInt(year as string, 10),
      parseInt(month as string, 10) - 1,
      parseInt(day as string, 10),
    );
    if (fileDateMs < cutoffMs) {
      await fs.unlink(path.join(dir, entry)).catch(() => undefined);
    }
  }
}

export async function appendAuditLine(line: AuditLine): Promise<void> {
  await ensureAuditDir();
  await rotateIfNeeded();
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
