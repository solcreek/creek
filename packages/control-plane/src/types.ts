import type { D1Database, R2Bucket } from "@cloudflare/workers-types";

export interface Env {
  // Cloudflare bindings
  DB: D1Database;
  ASSETS: R2Bucket;
  /**
   * Per-tenant log archive. Two prefixes share this bucket:
   *   - `logs/{team}/{project}/...`   — runtime logs (tail-worker writes, control-plane reads)
   *   - `builds/{team}/{project}/...` — build logs (control-plane read+write)
   * Optional because dev/test envs run without it.
   */
  LOGS_BUCKET?: R2Bucket;
  CREEK_DOMAIN: string;
  CREEK_REALTIME_URL?: string;
  REALTIME_MASTER_KEY?: string;
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_ZONE_ID: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  DISPATCH_NAMESPACE: string;

  // Better Auth
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;

  // OAuth providers
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;

  // GitHub App (separate from OAuth login)
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;   // PEM (PKCS#1 or PKCS#8 — auto-detected)
  GITHUB_WEBHOOK_SECRET: string;

  // Web deploy (public, no auth required)
  BUILD_STATUS: KVNamespace;
  REMOTE_BUILDER: Fetcher;
  WEB_BUILDS: Queue;
  SANDBOX_API_URL: string;
  INTERNAL_SECRET: string;

  // Encryption
  ENCRYPTION_KEY?: string;

  // Audit
  IP_HASH_SALT?: string;
}

// Re-export AuthUser for backward compatibility
export type { AuthUser } from "./modules/tenant/types.js";
