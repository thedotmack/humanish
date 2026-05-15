# humanish

For the times your AI needs to act humanish.

A two-tier credential broker that lets you give a Claude chat a single-use, scoped bearer to perform one action against one of your logged-in services — without ever handing over a long-lived secret. Built around a Cloudflare Worker link broker and a Fly.io container that runs a [neko](https://github.com/m1k1o/neko) browser jail for human login flows plus a Playwright-driven action runner.

**Status:** early. The MVP plan lives in `plans/2026-05-14-humanish.md`. The architecture rationale lives in `reports/2026-05-14-humanish-server.md`.

## What it does

1. You log into a service (e.g. Google) inside an embedded neko Chromium tab on the humanish dashboard.
2. humanish captures the Playwright `storageState`, encrypts it at rest with AES-GCM, and names the profile.
3. You mint a two-word EFF slug from the dashboard, scoped to one profile + one action + one TTL.
4. You paste the slug URL into any Claude chat. The slug page serves a single-use skill markdown blob with a one-call bearer.
5. Claude calls the action endpoint; humanish runs the action (the first one: generate a NotebookLM slide deck and publish it to wooow.now); the URL comes back inline.

Zero shell. Zero Claude Code. Zero local setup on the user's side.

## Architecture (one paragraph)

**Tier 1** — Cloudflare Worker on the public edge. Mints two-word EFF slugs. Renders single-use HTML pages. Burns slugs on first browser visit (Durable Object with atomic single-use). Authenticates dashboard traffic via Resend magic links. Calls Tier 2 over Fly's private network with a shared bearer.

**Tier 2** — Single VM on Fly.io. Hosts neko (`ghcr.io/m1k1o/neko/chromium`) for human login flows, a Node action-runner that decrypts profile blobs and runs actions against ephemeral Playwright contexts, and the [`notebooklm-py`](https://github.com/teng-lin/notebooklm-py) CLI as the first action's executor.

See `reports/2026-05-14-humanish-server.md` for the full design.

## License

Apache 2.0. See `LICENSE`.
