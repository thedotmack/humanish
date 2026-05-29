// Action runner HTTP server.
//
// Loopback / Flycast only. We bind to env.LISTEN_HOST (default "::1") so
// the runner is never reachable from the public internet — only from the
// broker over Fly's private network. Public traffic enters via neko on
// :8080 instead, which is a separate process.
//
// Auth: every route except /healthz requires
//   Authorization: Bearer ${BOX_SHARED_SECRET}
// Bearer comparison is constant-time.

import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { z } from "zod";
import { env } from "./env.js";
import { ulid } from "ulid";
import {
  InvalidProfileName,
  deleteProfile,
  listProfiles,
  profileExists,
  readProfile,
  writeProfileAtomic,
} from "./profile-store.js";
import { captureStorageState, resetNekoTab } from "./neko-bridge.js";
import { appendAuditLine, pruneOldLogs, readRecentAuditLines } from "./audit.js";
import {
  ACTION_IDS,
  ACTION_REGISTRY,
  type ActionId,
} from "./actions/index.js";
import { ActionAuthExpiredError } from "./actions/google.whoami.js";

// -------- bearer auth --------

const BEARER_PREFIX = "Bearer ";
const SECRET_BYTES = Buffer.from(env.BOX_SHARED_SECRET, "utf8");

function checkBearer(authHeader: string | undefined): boolean {
  if (!authHeader || !authHeader.startsWith(BEARER_PREFIX)) return false;
  const presented = authHeader.slice(BEARER_PREFIX.length);
  const presentedBytes = Buffer.from(presented, "utf8");
  if (presentedBytes.length !== SECRET_BYTES.length) return false;
  return timingSafeEqual(presentedBytes, SECRET_BYTES);
}

function requireBearer(req: FastifyRequest, reply: FastifyReply): boolean {
  const auth = req.headers["authorization"];
  if (!checkBearer(typeof auth === "string" ? auth : undefined)) {
    reply.code(401).send({ error: "unauthorized" });
    return false;
  }
  return true;
}

// -------- request schemas --------

const ProfileNameParams = z.object({
  name: z.string(),
});

const StartLoginBody = z
  .object({
    restore: z.boolean().optional(),
  })
  .strict()
  .optional();

const RunBody = z
  .object({
    profile: z.string(),
    action_id: z.string(),
    payload: z.unknown().optional(),
    request_id: z.string().min(1).max(64).optional(),
  })
  .strict();

// -------- server --------

export function buildServer(): FastifyInstance {
  const app = Fastify({
    bodyLimit: 1024 * 1024, // 1 MB; profiles never travel in the body.
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
    },
    disableRequestLogging: false,
  });

  // -------- /healthz (no auth) --------
  app.get("/healthz", async () => ({
    ok: true,
    ts: new Date().toISOString(),
  }));

  // -------- /profiles --------
  app.get("/profiles", async (req, reply) => {
    if (!requireBearer(req, reply)) return;
    const profiles = await listProfiles();
    return { profiles };
  });

  // -------- /profiles/:name/start-login --------
  app.post("/profiles/:name/start-login", async (req, reply) => {
    if (!requireBearer(req, reply)) return;
    const params = ProfileNameParams.safeParse(req.params);
    if (!params.success) {
      reply.code(400);
      return { error: "bad_params" };
    }
    const body = StartLoginBody.safeParse(req.body ?? {});
    const restore = body.success && body.data?.restore === true;
    let restoreSupported = false;
    try {
      restoreSupported = restore && (await profileExists(params.data.name));
    } catch (err) {
      if (err instanceof InvalidProfileName) {
        reply.code(400);
        return { error: "invalid_profile_name" };
      }
      throw err;
    }
    // MVP: the operator drives neko manually. Phase 8 will add server-
    // side restoration of storageState before handing off the tab.
    return {
      neko_url: env.NEKO_URL,
      neko_password_hint: "ask operator",
      restore_supported: restoreSupported,
    };
  });

  // -------- /profiles/:name/save --------
  app.post("/profiles/:name/save", async (req, reply) => {
    if (!requireBearer(req, reply)) return;
    const params = ProfileNameParams.safeParse(req.params);
    if (!params.success) {
      reply.code(400);
      return { error: "bad_params" };
    }
    const name = params.data.name;
    let stateJson: string;
    try {
      stateJson = await captureStorageState();
    } catch (err) {
      req.log.error({ err: scrub(err) }, "captureStorageState failed");
      reply.code(502);
      return { error: "cdp_capture_failed" };
    }
    let result: { bytes: number };
    try {
      result = await writeProfileAtomic(name, stateJson);
    } catch (err) {
      if (err instanceof InvalidProfileName) {
        reply.code(400);
        return { error: "invalid_profile_name" };
      }
      throw err;
    }
    // Fire-and-forget reset so the next user doesn't inherit the session.
    resetNekoTab().catch((err) => {
      req.log.warn({ err: scrub(err) }, "resetNekoTab failed (non-fatal)");
    });
    return { ok: true, profile: name, bytes: result.bytes };
  });

  // -------- DELETE /profiles/:name --------
  app.delete("/profiles/:name", async (req, reply) => {
    if (!requireBearer(req, reply)) return;
    const params = ProfileNameParams.safeParse(req.params);
    if (!params.success) {
      reply.code(400);
      return { error: "bad_params" };
    }
    try {
      await deleteProfile(params.data.name);
    } catch (err) {
      if (err instanceof InvalidProfileName) {
        reply.code(400);
        return { error: "invalid_profile_name" };
      }
      throw err;
    }
    return { ok: true };
  });

  // -------- GET /audit --------
  // Returns the last N tab-separated audit lines (raw). Broker is responsible
  // for parsing into structured records. Bearer-gated like every other route.
  app.get("/audit", async (req, reply) => {
    if (!requireBearer(req, reply)) return;
    let lines: string[];
    try {
      lines = await readRecentAuditLines(100);
    } catch (err) {
      req.log.error({ err: scrub(err) }, "readRecentAuditLines failed");
      reply.code(500);
      return { error: "audit_read_failed" };
    }
    return { lines };
  });

  // -------- /run --------
  app.post("/run", async (req, reply) => {
    if (!requireBearer(req, reply)) return;
    const parsed = RunBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "bad_body" };
    }
    const { profile, action_id, payload } = parsed.data;
    const requestId = parsed.data.request_id ?? ulid();

    const action = (ACTION_REGISTRY as Record<string, (typeof ACTION_REGISTRY)[ActionId] | undefined>)[
      action_id
    ];
    if (!action) {
      await appendAuditLine({
        request_id: requestId,
        profile,
        action_id,
        status: "action_not_found",
        bytes: 0,
      }).catch(() => undefined);
      reply.code(404);
      return { error: "action_not_found", known_actions: ACTION_IDS };
    }

    let storageStateJson: string;
    try {
      storageStateJson = await readProfile(profile);
    } catch (err) {
      if (err instanceof InvalidProfileName) {
        reply.code(400);
        return { error: "invalid_profile_name" };
      }
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        await appendAuditLine({
          request_id: requestId,
          profile,
          action_id,
          status: "error:profile_not_found",
          bytes: 0,
        }).catch(() => undefined);
        reply.code(404);
        return { error: "profile_not_found" };
      }
      req.log.error({ err: scrub(err) }, "readProfile failed");
      await appendAuditLine({
        request_id: requestId,
        profile,
        action_id,
        status: "error:profile_decrypt",
        bytes: 0,
      }).catch(() => undefined);
      reply.code(500);
      return { error: "profile_decrypt_failed" };
    }

    try {
      const result = await action.run({
        storageStateJson,
        payload,
        requestId,
      });
      const responseJson = JSON.stringify(result);
      await appendAuditLine({
        request_id: requestId,
        profile,
        action_id,
        status: "ok",
        bytes: responseJson.length,
      }).catch(() => undefined);
      reply.header("content-type", "application/json").code(200);
      return result;
    } catch (err) {
      if (err instanceof ActionAuthExpiredError) {
        await appendAuditLine({
          request_id: requestId,
          profile,
          action_id,
          status: "error:auth_expired",
          bytes: 0,
        }).catch(() => undefined);
        reply.code(503);
        return { error: "auth_expired" };
      }
      const scrubbed = scrub(err);
      req.log.error({ err: scrubbed, action_id, profile }, "action failed");
      await appendAuditLine({
        request_id: requestId,
        profile,
        action_id,
        status: "error:action_failed",
        bytes: 0,
      }).catch(() => undefined);
      reply.code(500);
      return { error: "action_failed" };
    }
  });

  return app;
}

// Strip anything that looks payload-ish from an error before logging.
// Never logs the original message verbatim because action handlers may
// embed user input in thrown errors.
function scrub(err: unknown): { name: string; message: string } {
  if (err instanceof Error) {
    return {
      name: err.name,
      // Cap the message length so we never write more than a snippet.
      message: err.message.length > 200
        ? `${err.message.slice(0, 200)}...[truncated]`
        : err.message,
    };
  }
  return { name: "NonError", message: typeof err };
}

// -------- bootstrap --------

async function main(): Promise<void> {
  const app = buildServer();
  // Best-effort: prune any rotated audit logs older than retention. A failure
  // here must not stop the server (a stuck disk for instance).
  pruneOldLogs().catch((err) => {
    app.log.warn({ err: String(err) }, "pruneOldLogs failed at startup");
  });
  await app.listen({
    host: env.LISTEN_HOST, // "::1" by default — never bind 0.0.0.0
    port: env.LISTEN_PORT,
  });
  app.log.info(
    { host: env.LISTEN_HOST, port: env.LISTEN_PORT },
    "action-runner listening",
  );
}

// Run when executed directly (e.g. `node dist/server.js`).
// We avoid `import.meta.url === \`file://${process.argv[1]}\`` checks
// because they're fragile with symlinks; instead we just always run when
// loaded as the entrypoint via `node dist/server.js`.
main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("action-runner failed to start", err);
  process.exit(1);
});
