import type { D1Database, R2Bucket } from "@cloudflare/workers-types";

export interface Env {
  DB: D1Database;
  ASSETS: R2Bucket;
  SANDBOX_DOMAIN: string;
  DISPATCH_NAMESPACE: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN: string;
  SANDBOX_TTL_MINUTES: string;
  /** Shared secret for service-to-service calls (MCP server → sandbox-api) */
  INTERNAL_SECRET: string;
  /** Salt for IP hashing — must be set in production (falls back to hardcoded default) */
  IP_HASH_SALT?: string;
}
