// @ts-nocheck — Node.js test that reads source files; runs under vitest
// (Node), not workerd. The control-plane tsconfig targets workers, so we
// disable type checking for this single file rather than maintaining a
// separate tsconfig.
/**
 * Schema audit — finds SQL queries across packages that reference tables
 * which don't exist in any known schema. Catches regressions like the
 * sandbox-dispatch FROM sandbox bug, where a table rename in one package's
 * migration left other packages with stale SQL.
 *
 * Source of truth:
 *   - control-plane: src/db/schema.ts (drizzle, used at runtime)
 *   - sandbox-api: src/schema.sql
 *
 * Cross-DB note: tables are merged into one set. Both DBs are checked
 * against the union. False positives are unlikely because table names are
 * distinct between the two DBs.
 */

import { describe, test, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../..");

// ─── Schema parsing ──────────────────────────────────────────────────────

function getDrizzleTables(schemaTsPath: string): Set<string> {
  const content = readFileSync(schemaTsPath, "utf-8");
  // Match: sqliteTable("table_name", ...)
  const re = /sqliteTable\(["']([^"']+)["']/g;
  const tables = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    tables.add(m[1]);
  }
  return tables;
}

function getSqlSchemaTables(schemaSqlPath: string): Set<string> {
  const content = readFileSync(schemaSqlPath, "utf-8");
  // Match: CREATE TABLE [IF NOT EXISTS] table_name
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?/gi;
  const tables = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    tables.add(m[1]);
  }
  return tables;
}

// ─── Source file walking ─────────────────────────────────────────────────

// Files that contain SQL strings as example/template code, not real queries.
// Listed as path suffixes for matching against full paths.
const EXCLUDED_FILES: string[] = [
  "packages/cli/src/commands/init.ts", // contains example user-app code as a template literal
];

function walkSourceFiles(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".creek" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkSourceFiles(full, files);
    } else if (
      (entry.endsWith(".ts") || entry.endsWith(".tsx")) &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".test.tsx") &&
      !entry.endsWith(".test-d.ts") &&
      !entry.endsWith(".d.ts") &&
      !EXCLUDED_FILES.some((suffix) => full.endsWith(suffix))
    ) {
      files.push(full);
    }
  }
  return files;
}

// ─── SQL extraction ──────────────────────────────────────────────────────

interface SqlReference {
  file: string;
  table: string;
  context: string;
}

/**
 * Extract referenced table names from SQL string literals in a file.
 * Looks for FROM, JOIN, INTO, and UPDATE clauses.
 */
function extractTableRefs(filePath: string): SqlReference[] {
  const content = readFileSync(filePath, "utf-8");
  const refs: SqlReference[] = [];

  // Find string literals that look like SQL. Run two passes:
  //   1. Double-quoted strings (single line): "SELECT ... FROM ..."
  //   2. Backtick template literals (may be multiline): `INSERT INTO ...`
  const literals: string[] = [];
  const doubleRe = /"((?:[^"\\]|\\.)*)"/g;
  const backtickRe = /`((?:[^`\\]|\\.)*)`/g;
  let m: RegExpExecArray | null;
  while ((m = doubleRe.exec(content)) !== null) literals.push(m[1]);
  while ((m = backtickRe.exec(content)) !== null) literals.push(m[1]);

  for (const literal of literals) {
    if (!/\b(SELECT|INSERT|UPDATE|DELETE)\b/i.test(literal)) continue;

    // FROM <table> or JOIN <table>
    // Skip qualified names like p.id (table is "p", we don't want aliases)
    // We extract the actual table after FROM/JOIN/INTO/UPDATE keywords
    const tableRe = /\b(?:FROM|JOIN|INTO|UPDATE)\s+["`]?(\w+)["`]?/gi;
    let tableMatch: RegExpExecArray | null;
    while ((tableMatch = tableRe.exec(literal)) !== null) {
      const name = tableMatch[1];
      // Skip SQL keywords that can follow these clauses
      if (["SELECT", "VALUES", "DEFAULT", "SET"].includes(name.toUpperCase())) continue;
      refs.push({ file: filePath, table: name, context: literal.slice(0, 100) });
    }
  }

  return refs;
}

// ─── The audit ───────────────────────────────────────────────────────────

describe("schema audit", () => {
  // Build the union of all known tables across both schemas
  const drizzleTables = getDrizzleTables(
    join(REPO_ROOT, "packages/control-plane/src/db/schema.ts"),
  );
  const sandboxTables = getSqlSchemaTables(
    join(REPO_ROOT, "packages/sandbox-api/src/schema.sql"),
  );

  // Better Auth creates tables that aren't in our schema files but exist at runtime
  // (it manages its own migrations). Allow these.
  const betterAuthTables = new Set<string>([
    "user",
    "session",
    "account",
    "verification",
    "apikey",
    "organization",
    "member",
    "invitation",
  ]);

  const knownTables = new Set<string>([
    ...drizzleTables,
    ...sandboxTables,
    ...betterAuthTables,
    // Drizzle internal table — created by drizzle migrations
    "__drizzle_migrations",
    // SQLite internals
    "sqlite_master",
    "sqlite_schema", // alias for sqlite_master (SQLite ≥3.33)
    "sqlite_sequence",
    "_cf_KV",
    // d1-schema package internal table
    "_d1schema_meta",
  ]);

  // Walk all package source dirs
  const packagesDir = join(REPO_ROOT, "packages");
  const packages = readdirSync(packagesDir).filter((p) => {
    try {
      return statSync(join(packagesDir, p, "src")).isDirectory();
    } catch {
      return false;
    }
  });

  const allRefs: SqlReference[] = [];
  for (const pkg of packages) {
    const srcDir = join(packagesDir, pkg, "src");
    const files = walkSourceFiles(srcDir);
    for (const file of files) {
      allRefs.push(...extractTableRefs(file));
    }
  }

  test("sanity: found schema tables", () => {
    expect(drizzleTables.size).toBeGreaterThan(0);
    expect(sandboxTables.size).toBeGreaterThan(0);
  });

  test("sanity: found SQL queries to audit", () => {
    expect(allRefs.length).toBeGreaterThan(0);
  });

  test("every queried table exists in a schema", () => {
    const unknownRefs = allRefs.filter((r) => !knownTables.has(r.table));
    if (unknownRefs.length > 0) {
      const grouped = new Map<string, SqlReference[]>();
      for (const r of unknownRefs) {
        const key = r.table;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key)!.push(r);
      }
      const message = [...grouped.entries()]
        .map(([table, refs]) => {
          const locations = refs
            .map((r) => `  - ${r.file.replace(REPO_ROOT, "")}: ${r.context.replace(/\s+/g, " ")}`)
            .join("\n");
          return `Unknown table "${table}":\n${locations}`;
        })
        .join("\n\n");
      throw new Error(
        `Found ${unknownRefs.length} SQL references to unknown tables:\n\n${message}\n\n` +
          `Either fix the query, or if the table is intentionally external, ` +
          `add it to the allowlist in schema-audit.test.ts.`,
      );
    }
  });
});
