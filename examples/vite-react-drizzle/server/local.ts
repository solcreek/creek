/**
 * Local development entry — Node + better-sqlite3.
 *
 * Run with:  pnpm dev   (starts this alongside Vite via concurrently)
 * Or solo:   tsx watch server/local.ts
 *
 * The DB lives at ./local.db (gitignored). Schema is created on
 * boot via ensureSchema() so first-run is one command.
 */

import { serve } from "@hono/node-server";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sql } from "drizzle-orm";
import { createApi } from "./routes.js";

const sqlite = new Database(process.env.SQLITE_PATH ?? "./local.db");
sqlite.pragma("journal_mode = WAL");
const db = drizzle(sqlite);

ensureSchema();

const app = createApi(() => db);
const port = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port }, ({ port }) => {
  console.log(`api: http://localhost:${port}`);
});

function ensureSchema() {
  db.run(sql`
    CREATE TABLE IF NOT EXISTS todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )
  `);
}
