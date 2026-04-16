/**
 * Migration logic for `creek db migrate`.
 *
 * Pure functions are exported for testing. The CLI command wires
 * them together with the SDK client in db.ts.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// --- Auto-detect migration directory ---

const CANDIDATE_DIRS = [
  "drizzle",
  "drizzle/migrations",
  "migrations",
  "sql",
];

/**
 * Find the migration directory relative to cwd.
 * Returns the absolute path of the first candidate that exists and
 * contains at least one .sql file, or null if none found.
 */
export function detectMigrationDir(cwd: string): string | null {
  for (const dir of CANDIDATE_DIRS) {
    const abs = resolve(cwd, dir);
    if (existsSync(abs)) {
      try {
        const files = readdirSync(abs);
        if (files.some((f) => f.endsWith(".sql"))) return abs;
      } catch {
        // Permission error or not a directory — skip
      }
    }
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
 * Read .sql files from a directory, sorted lexicographically.
 * Non-.sql files and empty .sql files are skipped.
 */
export function parseMigrationFiles(dir: string): MigrationFile[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  return entries
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, path: join(dir, name) }))
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

// --- Compute pending migrations ---

/**
 * Given files on disk and names already applied, return the pending
 * migrations in order.
 */
export function computePending(
  files: MigrationFile[],
  applied: Set<string>,
): MigrationFile[] {
  return files.filter((f) => !applied.has(f.name));
}
