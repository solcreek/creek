/**
 * Cloudflare Worker entry — D1 + Static Assets.
 *
 * Bundled by `npm run build` to dist/_worker.mjs. Creek deploys
 * dist/_worker.mjs as the Worker entry and dist/* as static assets
 * (env.ASSETS). The same Hono routes that run locally against
 * better-sqlite3 run here against D1 — only the driver swap differs.
 *
 * Bindings (auto-provisioned by Creek when [resources] in
 * creek.toml is set, OR auto-detected from package.json deps):
 *   env.DB     — D1Database
 *   env.ASSETS — Fetcher
 *
 * Schema is created on the first /api request via ensureSchema()
 * so a fresh D1 database boots without an external migration step.
 */

import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { createApi } from "./routes.js";

type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
};

let schemaReady = false;
async function ensureSchema(db: D1Database) {
  if (schemaReady) return;
  await db.exec(
    "CREATE TABLE IF NOT EXISTS todos (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)",
  );
  schemaReady = true;
}

const app = new Hono<{ Bindings: Env }>();

app.use("/api/*", async (c, next) => {
  await ensureSchema(c.env.DB);
  await next();
});

app.route("/", createApi<Env>((env) => drizzle(env.DB)));

// Anything not matched by the API falls through to the static React build.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
