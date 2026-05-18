interface Env {
  SLUG_NS: DurableObjectNamespace;
  KV: KVNamespace;
  RESEND_API_KEY: string;
  HUMANISH_MASTER_KEY: string;
  BOX_SHARED_SECRET: string;
  BOX_ORIGIN: string;
  COOKIE_DOMAIN: string;
  FROM_EMAIL: string;
  ALLOWED_EMAILS: string;
}

// Static text assets bundled by wrangler's Text module rules (wrangler.toml).
// The default export is the file contents as a string.
declare module "*.html" {
  const content: string;
  export default content;
}
declare module "*.template" {
  const content: string;
  export default content;
}
declare module "*.md.template" {
  const content: string;
  export default content;
}
