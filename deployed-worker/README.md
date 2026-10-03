# humanish-broker (as deployed on Cloudflare)

Source pulled read-only from the Cloudflare account on 2026-10-03, before the Worker was
retired. The Worker was never committed to git, so this is the only copy of its source.

- `worker.js`: the bundled script. The other files are the HTML/Markdown modules it imports.
- Bindings it ran with: DO `SLUG_NS` (class SlugBox, KV-backed), KV `KV` (empty), plain-text
  `BOX_ORIGIN` and `COOKIE_DOMAIN`, and secrets `ALLOWED_EMAILS`, `BOX_SHARED_SECRET`,
  `FROM_EMAIL`, `HUMANISH_MASTER_KEY`, `RESEND_API_KEY`. Secret values cannot be read back and
  are not here.
