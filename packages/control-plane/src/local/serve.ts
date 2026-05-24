/**
 * Local development server for the control-plane.
 *
 * Runs the same Hono app as the CF Worker, but backed by:
 * - better-sqlite3 instead of D1
 * - local filesystem instead of R2
 * - in-memory Map instead of KV
 *
 * Usage:
 *   bun run src/local/serve.ts
 *   # or: npx tsx src/local/serve.ts
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalD1Database } from "./d1-adapter.js";
import { LocalR2Bucket } from "./r2-adapter.js";
import { LocalKVNamespace } from "./kv-adapter.js";
import type { Env } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.CREEK_DATA_DIR || join(__dirname, "../../.creek-local");
const PORT = parseInt(process.env.PORT || "8787", 10);

function loadEnvFile(): Record<string, string> {
  const devVars = join(__dirname, "../../.dev.vars");
  if (!existsSync(devVars)) return {};
  const content = readFileSync(devVars, "utf-8");
  const vars: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    vars[key] = val;
  }
  return vars;
}

async function main() {
  const envVars = loadEnvFile();

  const dbPath = join(DATA_DIR, "creek.db");
  const db = new LocalD1Database(dbPath);

  // Run migrations in order
  const migrationsDir = join(__dirname, "../../drizzle");
  if (existsSync(migrationsDir)) {
    const files = readdirSync(migrationsDir)
      .filter((f: string) => f.endsWith(".sql") && /^\d{4}/.test(f))
      .sort();
    for (const file of files) {
      const sql = readFileSync(join(migrationsDir, file), "utf-8");
      try {
        db.inner.exec(sql);
      } catch {
        // Migration may have already been applied (e.g. table already exists)
      }
    }
    if (files.length > 0) console.log(`  ${files.length} migrations applied`);
  }

  const assets = new LocalR2Bucket(join(DATA_DIR, "assets"));
  const logsBucket = new LocalR2Bucket(join(DATA_DIR, "logs"));
  const buildStatus = new LocalKVNamespace();

  const env: Env = {
    DB: db as any,
    ASSETS: assets as any,
    LOGS_BUCKET: logsBucket as any,
    BUILD_STATUS: buildStatus as any,
    REMOTE_BUILDER: { fetch: () => Promise.resolve(new Response("not available in local mode", { status: 503 })) } as any,
    WEB_BUILDS: { send: () => Promise.resolve() } as any,

    CREEK_DOMAIN: envVars.CREEK_DOMAIN || "localhost",
    CREEK_REALTIME_URL: envVars.CREEK_REALTIME_URL || "",
    REALTIME_MASTER_KEY: envVars.REALTIME_MASTER_KEY || "",
    SANDBOX_API_URL: envVars.SANDBOX_API_URL || "",
    INTERNAL_SECRET: envVars.INTERNAL_SECRET || "local-dev-secret",
    DISPATCH_NAMESPACE: envVars.DISPATCH_NAMESPACE || "",

    CLOUDFLARE_API_TOKEN: envVars.CLOUDFLARE_API_TOKEN || "",
    CLOUDFLARE_ZONE_ID: envVars.CLOUDFLARE_ZONE_ID || "",
    CLOUDFLARE_ACCOUNT_ID: envVars.CLOUDFLARE_ACCOUNT_ID || "",

    BETTER_AUTH_SECRET: envVars.BETTER_AUTH_SECRET || "local-dev-secret-32-chars-min!!",
    BETTER_AUTH_URL: envVars.BETTER_AUTH_URL || `http://localhost:${PORT}`,

    GITHUB_CLIENT_ID: envVars.GITHUB_CLIENT_ID || "",
    GITHUB_CLIENT_SECRET: envVars.GITHUB_CLIENT_SECRET || "",
    GOOGLE_CLIENT_ID: envVars.GOOGLE_CLIENT_ID || "",
    GOOGLE_CLIENT_SECRET: envVars.GOOGLE_CLIENT_SECRET || "",

    GITHUB_APP_ID: envVars.GITHUB_APP_ID || "",
    GITHUB_APP_PRIVATE_KEY: envVars.GITHUB_APP_PRIVATE_KEY || "",
    GITHUB_WEBHOOK_SECRET: envVars.GITHUB_WEBHOOK_SECRET || "",

    ENCRYPTION_KEY: envVars.ENCRYPTION_KEY || "",
    IP_HASH_SALT: envVars.IP_HASH_SALT || "",
  };

  // Import the app — it's a module-level const so we need dynamic import
  // and inject env via Hono's middleware
  const { default: worker } = await import("../index.js");

  // The CF Worker export is { fetch, scheduled }. We need the fetch function.
  const workerFetch = worker.fetch;

  console.log(`\n  creek control-plane (local)`);
  console.log(`  listening on http://localhost:${PORT}`);
  console.log(`  data dir: ${DATA_DIR}\n`);

  const server = Bun.serve({
    port: PORT,
    async fetch(request: Request) {
      // Inject env into the request context — Hono Workers adapter reads from the second arg
      return workerFetch(request, env, {
        waitUntil: (p: Promise<unknown>) => { p.catch(console.error); },
        passThroughOnException: () => {},
      });
    },
  });

  process.on("SIGINT", () => {
    console.log("\nshutting down...");
    db.close();
    server.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
