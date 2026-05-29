// Action runner environment parsing + validation.
//
// All process.env lookups go through this module so that misconfiguration
// fails fast at startup with a clear error rather than producing confusing
// runtime errors deep inside crypto / network code.

import { z } from "zod";

const EnvSchema = z.object({
  // 32-byte base64 master key used for AES-GCM profile encryption.
  HUMANISH_MASTER_KEY: z
    .string()
    .refine(
      (value) => {
        try {
          return Buffer.from(value, "base64").length === 32;
        } catch {
          return false;
        }
      },
      "HUMANISH_MASTER_KEY must decode to exactly 32 bytes of base64",
    ),
  // Shared bearer used by the broker (Worker) to call this action runner.
  // The broker must send `Authorization: Bearer ${BOX_SHARED_SECRET}`.
  BOX_SHARED_SECRET: z.string().min(32),
  // Public URL of the neko UI; only used to hand the broker an embed URL.
  NEKO_URL: z.string().url().default("http://localhost:8080"),
  // Password for the neko single-user mode. Operator-only.
  NEKO_PASSWORD: z.string().min(8),
  // Chrome DevTools Protocol endpoint of the neko-managed Chromium.
  // MUST be loopback-bound; never publicly exposed.
  CDP_URL: z.string().url().default("http://127.0.0.1:9223"),
  // Where encrypted profile blobs live. `/data` is the Fly volume mount.
  PROFILES_DIR: z.string().default("/data/profiles"),
  // Append-only audit log path. `/data` survives Fly machine restarts.
  AUDIT_LOG_PATH: z.string().default("/data/audit.log"),
  // Action runner bind address. Defaults to "0.0.0.0" (all IPv4 interfaces)
  // because Fly's fly-proxy connects via the machine's IPv4 from outside the
  // network namespace. The actual network defense is BOX_SHARED_SECRET:
  // every non-/healthz route requires `Authorization: Bearer ${BOX_SHARED_SECRET}`
  // (constant-time compare). TLS terminates at fly-proxy.
  // For local dev set LISTEN_HOST=::1 (loopback-only) via .dev.vars/env.
  LISTEN_HOST: z.string().default("0.0.0.0"),
  LISTEN_PORT: z.coerce.number().int().positive().default(7654),
});

export type Env = z.infer<typeof EnvSchema>;

export const env: Env = EnvSchema.parse(process.env);
