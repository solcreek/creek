/**
 * Migration discovery and parsing, shared by `creek db migrate`, `creek
 * deploy` (sandbox seeding and `[release] migrations`) and remote builds.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { splitSqlStatements } from "./split.js";

// --- Auto-detect migration directory ---

// db/migrations is June's default location (solcreek/creek#57).
export const MIGRATION_DIRS = [
  "drizzle",
  "drizzle/migrations",
  "prisma/migrations",
  "migrations",
  "db/migrations",
  "sql",
];

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
  for (const dir of MIGRATION_DIRS) {
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
export function parseMigrationFiles(dir: string, opts: { strict?: boolean } = {}): MigrationFile[] {
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
      } catch (err) {
        if (opts.strict) throw unreadable(f, err);
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
export function splitMigrationStatements(sql: string): string[] {
  const trimmed = sql.trim();
  if (!trimmed) return [];

  let parts: string[];

  if (trimmed.includes(DRIZZLE_BREAKPOINT)) {
    parts = trimmed.split(DRIZZLE_BREAKPOINT);
  } else {
    // Split only on semicolons that end statements (not ones inside comments,
    // string literals, quoted identifiers or trigger bodies), and keep the
    // trailing semicolon — each statement includes it for D1 execution.
    parts = splitSqlStatements(trimmed).map((s) => s + ";");
  }

  return parts.map((s) => s.trim()).filter((s) => s.length > 0);
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
 * statements: for the sandbox to seed its ephemeral D1, and for a production
 * deploy to apply with `[release] migrations`. Returns [] when no migration
 * directory is found.
 *
 * By default an unreadable file is skipped, which is fine for a throwaway
 * preview database. `strict` throws instead, naming the file: a production
 * deploy must not apply the migrations after one it could not read.
 */
export function collectMigrations(cwd: string, opts: { strict?: boolean } = {}): MigrationBundle[] {
  const dir = detectMigrationDir(cwd);
  if (!dir) return [];
  return parseMigrationFiles(dir, opts)
    .map((file) => {
      try {
        return {
          name: file.name,
          statements: splitMigrationStatements(readFileSync(file.path, "utf-8")),
        };
      } catch (err) {
        if (opts.strict) throw unreadable(file, err);
        return { name: file.name, statements: [] };
      }
    })
    .filter((m) => m.statements.length > 0);
}

function unreadable(file: MigrationFile, err: unknown): Error {
  const detail = err instanceof Error ? err.message : String(err);
  return new Error(`Cannot read migration ${file.name} (${file.path}): ${detail}`);
}
