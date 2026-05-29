// Bridge between the action runner and neko's embedded Chromium via CDP.
//
// neko exposes Chrome DevTools Protocol on a loopback port (127.0.0.1:9223).
// We attach via Playwright's connectOverCDP so we get the full Playwright
// API without re-launching Chromium. Closing the returned Browser handle
// only disconnects the CDP channel — it does NOT close the underlying
// Chromium that neko is driving. That's the behavior we want.

import { chromium, type Browser, type BrowserContext } from "playwright";
import { env } from "./env.js";

/**
 * Attach to the neko-managed Chromium over CDP. Caller is responsible
 * for calling `browser.close()` to release the protocol connection.
 */
export async function connectCdp(): Promise<Browser> {
  return chromium.connectOverCDP(env.CDP_URL);
}

/**
 * Pick the default (first) context. CDP-attached Chromium reuses the
 * existing browser, so contexts() is non-empty.
 */
function defaultContext(browser: Browser): BrowserContext {
  const contexts = browser.contexts();
  const ctx = contexts[0];
  if (!ctx) {
    throw new Error("no browser context available over CDP");
  }
  return ctx;
}

/**
 * Capture the storageState (cookies, localStorage, indexedDB) of the
 * user's neko session. Returns the JSON as a string so the caller can
 * pipe it straight into encryptProfile().
 */
export async function captureStorageState(): Promise<string> {
  const browser = await connectCdp();
  try {
    const ctx = defaultContext(browser);
    const state = await ctx.storageState({ indexedDB: true });
    return JSON.stringify(state);
  } finally {
    // Disconnect CDP channel only — underlying Chromium keeps running.
    await browser.close();
  }
}

/**
 * Navigate the first page to about:blank so the next operator does not
 * inherit the previous session. This is a soft reset — the underlying
 * Chromium keeps its disk profile; the storageState is wiped by
 * navigating away and (separately) by neko's cleanup hooks.
 */
export async function resetNekoTab(): Promise<void> {
  const browser = await connectCdp();
  try {
    const ctx = defaultContext(browser);
    const pages = ctx.pages();
    const page = pages[0] ?? (await ctx.newPage());
    await page.goto("about:blank", { waitUntil: "load" }).catch(() => {
      // Best effort; even if navigation fails the user gets a fresh
      // tab next visit via neko's own reset path.
    });
  } finally {
    await browser.close();
  }
}
