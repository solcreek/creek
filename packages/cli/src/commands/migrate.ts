/**
 * Migration logic for `creek db migrate`.
 *
 * Pure functions are exported for testing. The CLI command wires
 * them together with the SDK client in db.ts.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// --- Auto-detect migration directory ---

const CANDIDATE_DIRS = ["drizzle", "drizzle/migrations", "prisma/migrations", "migrations", "sql"];

/**
 * Whether a directory holds migrations in either supported layout:
 *  - flat: `.sql` files directly in the dir (Drizzle `drizzle-kit generate`,
 *    plain SQL dirs)
 *  - nested: `<name>/migration.sql` per migration (Prisma `prisma migrate`)
 */
function hasMigrations(dir: string): boolean {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false; // Permission error or not a directory.
  }
  if (entries.some((f) => f.endsWith(".sql"))) return true;
  return entries.some((f) => existsSync(join(dir, f, "migration.sql")));
}

/**
 * Find the migration directory relative to cwd.
 * Returns the absolute path of the first candidate that holds migrations
 * (flat `.sql` or Prisma's nested `<name>/migration.sql`), or null.
 */
export function detectMigrationDir(cwd: string): string | null {
  for (const dir of CANDIDATE_DIRS) {
    const abs = resolve(cwd, dir);
    if (existsSync(abs) && hasMigrations(abs)) return abs;
  }
  return null;
}

// --- Parse migration files ---

export interface MigrationFile {
  /** File name without directory (e.g. "0001_init.sql") */
  name: string;
  /** Absolute path */
  path: string;
}

/**
 * Read migrations from a directory in either layout, sorted lexicographically
 * by name (Drizzle's `NNNN_` prefixes and Prisma's `<timestamp>_` prefixes both
 * sort chronologically). Empty migrations are skipped.
 *
 *  - flat: each `.sql` file is a migration; name = file name (e.g. `0001_init.sql`)
 *  - nested: each `<name>/migration.sql` is a migration; name = subdir name
 *    (e.g. `20260614120000_init`) — the identifier Prisma tracks
 */
export function parseMigrationFiles(dir: string): MigrationFile[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const files: MigrationFile[] = [];
  for (const name of entries) {
    if (name.endsWith(".sql")) {
      files.push({ name, path: join(dir, name) });
      continue;
    }
    // Prisma nests each migration as `<name>/migration.sql`.
    const nested = join(dir, name, "migration.sql");
    if (existsSync(nested)) files.push({ name, path: nested });
  }

  return files
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .filter((f) => {
      try {
        const content = readFileSync(f.path, "utf-8").trim();
        return content.length > 0;
      } catch {
        return false;
      }
    });
}

// --- Split SQL statements ---

const DRIZZLE_BREAKPOINT = "--> statement-breakpoint";

/**
 * Split a migration file's SQL content into individual statements.
 *
 * If the content contains Drizzle's `--> statement-breakpoint` marker,
 * split on those. Otherwise split on semicolons. Empty statements are
 * filtered out.
 */
export function splitStatements(sql: string): string[] {
  const trimmed = sql.trim();
  if (!trimmed) return [];

  let parts: string[];

  if (trimmed.includes(DRIZZLE_BREAKPOINT)) {
    parts = trimmed.split(DRIZZLE_BREAKPOINT);
  } else {
    // Split on semicolons but preserve them — each statement should
    // include its trailing semicolon for D1 execution.
    parts = trimmed
      .split(/;(?=\s|$)/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => (s.endsWith(";") ? s : s + ";"));
  }

  return parts.map((s) => s.trim()).filter((s) => s.length > 0);
}

// --- Batch statements for fewer round-trips ---

/**
 * Control-plane's /resources/:id/query rejects a `sql` payload over 100KB.
 * Stay well under it so JSON/transport overhead can't push a batch over.
 */
export const MAX_BATCH_BYTES = 90_000;

/**
 * Group ordered SQL statements into as few batches as possible, each a single
 * multi-statement string under `maxBytes`. CF D1's /query executes a
 * multi-statement string in one call (SQLite's own tokenizer splits it, so
 * triggers/strings with inner semicolons are safe), which collapses the
 * per-statement HTTP round-trips `creek db migrate` used to make — the cost
 * that made migrating a many-table schema feel slow — down to ~one per file.
 *
 * Order is preserved: statements are packed greedily, never reordered. A
 * single statement larger than `maxBytes` becomes its own (oversize) batch
 * rather than being dropped — the server-side limit then surfaces the real
 * problem instead of us silently truncating.
 */
export function batchStatements(
  statements: string[],
  maxBytes: number = MAX_BATCH_BYTES,
): string[] {
  const batches: string[] = [];
  let current = "";
  for (const stmt of statements) {
    const piece = stmt.trim();
    if (!piece) continue;
    if (current === "") {
      current = piece;
      continue;
    }
    // +1 for the joining newline.
    if (Buffer.byteLength(current) + 1 + Buffer.byteLength(piece) > maxBytes) {
      batches.push(current);
      current = piece;
    } else {
      current = `${current}\n${piece}`;
    }
  }
  if (current !== "") batches.push(current);
  return batches;
}

// --- Compute pending migrations ---

/**
 * Given files on disk and names already applied, return the pending
 * migrations in order.
 */
export function computePending(files: MigrationFile[], applied: Set<string>): MigrationFile[] {
  return files.filter((f) => !applied.has(f.name));
}

// --- Collect migrations for sandbox seeding ---

export interface MigrationBundle {
  /** Migration identifier (file or dir name), in apply order. */
  name: string;
  /** Individual SQL statements to run in order. */
  statements: string[];
}

/**
 * Read all migrations from the auto-detected directory as ordered SQL
 * statements, for the sandbox to apply to its ephemeral D1 (so DB-backed
 * routes work in the preview without `creek db migrate`). Returns [] when no
 * migration directory is found.
 */
export function collectMigrations(cwd: string): MigrationBundle[] {
  const dir = detectMigrationDir(cwd);
  if (!dir) return [];
  return parseMigrationFiles(dir)
    .map((file) => {
      try {
        return { name: file.name, statements: splitStatements(readFileSync(file.path, "utf-8")) };
      } catch {
        return { name: file.name, statements: [] };
      }
    })
    .filter((m) => m.statements.length > 0);
}
