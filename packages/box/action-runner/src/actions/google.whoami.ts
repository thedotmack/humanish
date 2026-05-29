// google.whoami — first real action. Proof-of-life that proves the whole
// pipeline works end-to-end: broker mints a slug → Claude calls /run →
// box decrypts the profile → Playwright loads myaccount.google.com using
// the stored storageState → returns the signed-in email.
//
// Design choices worth calling out:
//   - We launch a fresh ephemeral headless Chromium per call instead of
//     reusing the long-lived neko-driven browser. neko's CDP is for
//     interactive save/reauth flows only (see neko-bridge.ts). Actions
//     must never touch the user-visible neko tab.
//   - storageStateJson is fed directly to newContext() and never written
//     to disk anywhere in the action lifecycle.
//   - A try/finally guarantees browser.close() so we never leak Chromium
//     processes — critical on a long-running box.
//   - The whole run is wrapped in a 30s overall timeout. Cold-start
//     budgets vary, and a hung navigation would otherwise pin the
//     request indefinitely.

import { chromium } from "playwright";
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
    this.name = "ActionAuthExpiredError";
  }
}

export interface ActionRunInput {
  storageStateJson: string;
  payload: unknown;
  requestId: string;
}

// Per-action overall budget. Whoami should complete in ~5s; 30s is a
// generous ceiling for cold starts. Beyond this, abandon the attempt.
const ACTION_TIMEOUT_MS = 30_000;

// Per-navigation budget. Kept shorter than the overall budget so we leave
// room for selector queries and clean shutdown.
const NAV_TIMEOUT_MS = 15_000;

// Regex used to extract an email from an aria-label fallback. Standard
// (deliberately conservative) email shape; we never accept anything
// that doesn't match this before returning.
const EMAIL_REGEX = /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/;

const inputSchema = z.object({}).strict();
const outputSchema = z.object({
  email: z.string().email(),
  checked_at: z.string(),
});

type GoogleWhoamiOutput = z.infer<typeof outputSchema>;

async function runImpl(
  input: ActionRunInput,
): Promise<GoogleWhoamiOutput> {
  // Validate input. payload is `{}` for whoami; anything else is a
  // contract violation by the caller — fail fast with a clear error so
  // the server can return 400.
  const inputCheck = inputSchema.safeParse(input.payload ?? {});
  if (!inputCheck.success) {
    throw new Error(
      `google.whoami input validation failed: ${inputCheck.error.message}`,
    );
  }

  // Parse storage state once up front. If the JSON is corrupt we want a
  // clear error before we burn the cost of launching Chromium.
  let parsedStorageState: unknown;
  try {
    parsedStorageState = JSON.parse(input.storageStateJson);
  } catch (err) {
    throw new Error(
      `google.whoami: storageState JSON parse failed: ${(err as Error).message}`,
    );
  }

  // Args required to run reliably inside a Docker container — the
  // default Chromium sandbox needs capabilities that our box image
  // doesn't grant, and /dev/shm is too small for default usage.
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const context = await browser.newContext({
      storageState: parsedStorageState as Parameters<
        typeof browser.newContext
      >[0] extends infer T
        ? T extends { storageState?: infer S }
          ? S
          : never
        : never,
    });
    const page = await context.newPage();
    await page.goto("https://myaccount.google.com/", {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT_MS,
    });

    // Selector 1: og:email as a property attribute. This is the most
    // common path on a fully-rendered logged-in account page.
    let email: string | null = await page
      .locator('meta[property="og:email"]')
      .first()
      .getAttribute("content")
      .catch(() => null);

    // Selector 2: og:email as a name attribute (alternate Google
    // rendering path). Different account UIs ship different markup.
    if (!email) {
      email = await page
        .locator('meta[name="og:email"]')
        .first()
        .getAttribute("content")
        .catch(() => null);
    }

    // Selector 3: the account chip's aria-label. Format is roughly
    // "Google Account: Name (someone@example.com)". We extract the
    // email substring with a conservative regex.
    if (!email) {
      const aria = await page
        .locator('a[aria-label*="@"]')
        .first()
        .getAttribute("aria-label")
        .catch(() => null);
      const match = aria?.match(EMAIL_REGEX);
      email = match?.[1] ?? null;
    }

    if (!email) {
      // No email found. If we got redirected to a sign-in URL, the
      // cookies have expired — surface that as auth_expired so the
      // dashboard can prompt the user. Otherwise it's a generic
      // selector/extraction failure and we want the final URL in logs
      // for debugging without leaking user data.
      const finalUrl = page.url();
      if (
        finalUrl.includes("accounts.google.com/ServiceLogin") ||
        finalUrl.includes("accounts.google.com/signin")
      ) {
        throw new ActionAuthExpiredError(
          "google profile cookies expired",
        );
      }
      throw new Error(
        `google.whoami: could not extract email from ${finalUrl}`,
      );
    }

    const result = {
      email,
      checked_at: new Date().toISOString(),
    };

    // Validate output before returning. Never hand malformed data back
    // to the caller — fail fast so a regression in the extraction
    // logic surfaces as a 500 instead of a confusing downstream parse
    // error.
    const outputCheck = outputSchema.safeParse(result);
    if (!outputCheck.success) {
      throw new Error(
        `google.whoami output validation failed: ${outputCheck.error.message}`,
      );
    }
    return outputCheck.data;
  } finally {
    await browser.close();
  }
}

async function runWithBudget(
  input: ActionRunInput,
): Promise<GoogleWhoamiOutput> {
  // Promise.race with a timeout reject. We DO clear the timer in the
  // happy path so the process doesn't keep an orphan reference alive,
  // and we surface a clear error message on timeout.
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `google.whoami timed out after ${ACTION_TIMEOUT_MS}ms (request_id=${input.requestId})`,
        ),
      );
    }, ACTION_TIMEOUT_MS);
  });
  try {
    return await Promise.race([runImpl(input), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const GOOGLE_WHOAMI = {
  id: "google.whoami" as const,
  inputSchema,
  outputSchema,
  run: runWithBudget,
} as const;
