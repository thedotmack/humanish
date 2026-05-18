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
