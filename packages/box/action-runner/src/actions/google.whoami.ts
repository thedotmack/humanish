// google.whoami — STUB ONLY for Phase 3.
//
// Phase 6 owns the real implementation. This file exists so the action
// registry has a typed entry to import, and so the server can route to
// "google.whoami" without 404'ing during early integration tests.
//
// Calling `run()` deliberately throws PHASE_6_PLACEHOLDER so we never
// accidentally ship a partial action.

import { z } from "zod";

/**
 * Throw this when a profile's stored auth has expired. The HTTP layer
 * maps it to a 503 with `{error: "auth_expired"}` so the dashboard
 * can prompt the user to re-login.
 */
export class ActionAuthExpiredError extends Error {
  code = "auth_expired" as const;
  status = 503 as const;
  constructor(message: string = "auth expired") {
    super(message);
  }
}

export interface ActionRunInput {
  storageStateJson: string;
  payload: unknown;
  requestId: string;
}

export const GOOGLE_WHOAMI = {
  id: "google.whoami" as const,
  inputSchema: z.object({}).strict(),
  outputSchema: z.object({
    email: z.string().email(),
    checked_at: z.string(),
  }),
  async run(
    _input: ActionRunInput,
  ): Promise<{ email: string; checked_at: string }> {
    throw new Error(
      "PHASE_6_PLACEHOLDER: google.whoami not yet implemented",
    );
  },
} as const;
