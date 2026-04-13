import { defineConfig } from "drizzle-kit";

// Migrations are emitted to ./drizzle/migrations and applied:
//   - locally:  npm run db:migrate:local  (against ./local.db)
//   - on Creek: applied lazily by ensureSchema() on first request
//
// `dialect: "sqlite"` works for both better-sqlite3 and D1 — the
// generated SQL is portable.
export default defineConfig({
  schema: "./server/schema.ts",
  out: "./drizzle/migrations",
  dialect: "sqlite",
});
