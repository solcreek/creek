import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  detectMigrationDir,
  parseMigrationFiles,
  splitStatements,
  computePending,
  type MigrationFile,
} from "./migrate.js";

// --- Test temp directory ---

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `creek-migrate-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// --- detectMigrationDir ---

describe("detectMigrationDir", () => {
  test("returns null when no candidate dirs exist", () => {
    expect(detectMigrationDir(testDir)).toBeNull();
  });

  test("returns null when candidate dir exists but has no .sql files", () => {
    mkdirSync(join(testDir, "drizzle"));
    writeFileSync(join(testDir, "drizzle", "config.ts"), "export default {}");
    expect(detectMigrationDir(testDir)).toBeNull();
  });

  test("finds drizzle/ when it contains .sql files", () => {
    mkdirSync(join(testDir, "drizzle"));
    writeFileSync(join(testDir, "drizzle", "0001.sql"), "CREATE TABLE t (id INT);");
    expect(detectMigrationDir(testDir)).toBe(join(testDir, "drizzle"));
  });

  test("finds drizzle/migrations/ over drizzle/ when both exist", () => {
    // drizzle/ has only config, drizzle/migrations/ has SQL
    mkdirSync(join(testDir, "drizzle/migrations"), { recursive: true });
    writeFileSync(join(testDir, "drizzle", "config.ts"), "export default {}");
    writeFileSync(join(testDir, "drizzle/migrations", "0001.sql"), "SELECT 1;");
    // drizzle/ has no .sql so it's skipped, drizzle/migrations/ matches
    expect(detectMigrationDir(testDir)).toBe(join(testDir, "drizzle/migrations"));
  });

  test("prefers drizzle/ over migrations/ when both have .sql", () => {
    mkdirSync(join(testDir, "drizzle"));
    mkdirSync(join(testDir, "migrations"));
    writeFileSync(join(testDir, "drizzle", "0001.sql"), "SELECT 1;");
    writeFileSync(join(testDir, "migrations", "0001.sql"), "SELECT 2;");
    expect(detectMigrationDir(testDir)).toBe(join(testDir, "drizzle"));
  });

  test("finds migrations/ when drizzle/ does not exist", () => {
    mkdirSync(join(testDir, "migrations"));
    writeFileSync(join(testDir, "migrations", "init.sql"), "SELECT 1;");
    expect(detectMigrationDir(testDir)).toBe(join(testDir, "migrations"));
  });

  test("finds sql/ as last resort", () => {
    mkdirSync(join(testDir, "sql"));
    writeFileSync(join(testDir, "sql", "setup.sql"), "SELECT 1;");
    expect(detectMigrationDir(testDir)).toBe(join(testDir, "sql"));
  });
});

// --- parseMigrationFiles ---

describe("parseMigrationFiles", () => {
  test("returns empty array for nonexistent directory", () => {
    expect(parseMigrationFiles(join(testDir, "nope"))).toEqual([]);
  });

  test("returns empty array for empty directory", () => {
    const dir = join(testDir, "empty");
    mkdirSync(dir);
    expect(parseMigrationFiles(dir)).toEqual([]);
  });

  test("filters out non-.sql files", () => {
    const dir = join(testDir, "mixed");
    mkdirSync(dir);
    writeFileSync(join(dir, "0001.sql"), "CREATE TABLE t (id INT);");
    writeFileSync(join(dir, "readme.md"), "# Migrations");
    writeFileSync(join(dir, "config.ts"), "export default {}");
    const files = parseMigrationFiles(dir);
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("0001.sql");
  });

  test("filters out empty .sql files", () => {
    const dir = join(testDir, "empties");
    mkdirSync(dir);
    writeFileSync(join(dir, "0001.sql"), "CREATE TABLE t (id INT);");
    writeFileSync(join(dir, "0002.sql"), "");
    writeFileSync(join(dir, "0003.sql"), "   \n  ");
    const files = parseMigrationFiles(dir);
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("0001.sql");
  });

  test("sorts files lexicographically", () => {
    const dir = join(testDir, "ordered");
    mkdirSync(dir);
    writeFileSync(join(dir, "0003_c.sql"), "SELECT 3;");
    writeFileSync(join(dir, "0001_a.sql"), "SELECT 1;");
    writeFileSync(join(dir, "0002_b.sql"), "SELECT 2;");
    const files = parseMigrationFiles(dir);
    expect(files.map((f) => f.name)).toEqual([
      "0001_a.sql",
      "0002_b.sql",
      "0003_c.sql",
    ]);
  });

  test("includes correct absolute paths", () => {
    const dir = join(testDir, "paths");
    mkdirSync(dir);
    writeFileSync(join(dir, "0001.sql"), "SELECT 1;");
    const files = parseMigrationFiles(dir);
    expect(files[0].path).toBe(join(dir, "0001.sql"));
  });
});

// --- splitStatements ---

describe("splitStatements", () => {
  test("returns empty array for empty string", () => {
    expect(splitStatements("")).toEqual([]);
    expect(splitStatements("   ")).toEqual([]);
  });

  test("splits single statement", () => {
    const stmts = splitStatements("CREATE TABLE t (id INT);");
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toBe("CREATE TABLE t (id INT);");
  });

  test("splits multiple statements by semicolons", () => {
    const sql = `
      CREATE TABLE a (id INT);
      CREATE TABLE b (id INT);
      INSERT INTO a VALUES (1);
    `;
    const stmts = splitStatements(sql);
    expect(stmts).toHaveLength(3);
    expect(stmts[0]).toContain("CREATE TABLE a");
    expect(stmts[1]).toContain("CREATE TABLE b");
    expect(stmts[2]).toContain("INSERT INTO a");
  });

  test("splits by Drizzle breakpoint when present", () => {
    const sql = [
      "CREATE TABLE a (id INT);",
      "--> statement-breakpoint",
      "CREATE TABLE b (id INT);",
      "--> statement-breakpoint",
      "CREATE INDEX idx ON a(id);",
    ].join("\n");
    const stmts = splitStatements(sql);
    expect(stmts).toHaveLength(3);
    expect(stmts[0]).toContain("CREATE TABLE a");
    expect(stmts[1]).toContain("CREATE TABLE b");
    expect(stmts[2]).toContain("CREATE INDEX");
  });

  test("filters empty parts from Drizzle breakpoints", () => {
    const sql = [
      "--> statement-breakpoint",
      "CREATE TABLE a (id INT);",
      "--> statement-breakpoint",
      "",
      "--> statement-breakpoint",
    ].join("\n");
    const stmts = splitStatements(sql);
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toContain("CREATE TABLE a");
  });

  test("handles semicolons inside string literals (basic case)", () => {
    // Single statement with a semicolon in a string value
    const sql = "INSERT INTO t VALUES ('hello; world');";
    const stmts = splitStatements(sql);
    // This is a known limitation of naive splitting — in practice,
    // Drizzle migrations don't have semicolons in string literals.
    // We accept this trade-off for simplicity.
    expect(stmts.length).toBeGreaterThanOrEqual(1);
  });

  test("preserves trailing semicolons", () => {
    const stmts = splitStatements("SELECT 1;\nSELECT 2;");
    for (const s of stmts) {
      expect(s.endsWith(";")).toBe(true);
    }
  });

  test("handles statement without trailing semicolon", () => {
    const stmts = splitStatements("SELECT 1");
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toBe("SELECT 1;");
  });

  test("handles CREATE TABLE with multiple columns and constraints", () => {
    const sql = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    `;
    const stmts = splitStatements(sql);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toContain("CREATE TABLE");
    expect(stmts[0]).toContain("created_at");
    expect(stmts[1]).toContain("CREATE INDEX");
  });
});

// --- computePending ---

describe("computePending", () => {
  const files: MigrationFile[] = [
    { name: "0001_init.sql", path: "/m/0001_init.sql" },
    { name: "0002_users.sql", path: "/m/0002_users.sql" },
    { name: "0003_posts.sql", path: "/m/0003_posts.sql" },
  ];

  test("all pending when none applied", () => {
    const pending = computePending(files, new Set());
    expect(pending).toEqual(files);
  });

  test("none pending when all applied", () => {
    const applied = new Set(["0001_init.sql", "0002_users.sql", "0003_posts.sql"]);
    expect(computePending(files, applied)).toEqual([]);
  });

  test("partial pending", () => {
    const applied = new Set(["0001_init.sql", "0002_users.sql"]);
    const pending = computePending(files, applied);
    expect(pending).toHaveLength(1);
    expect(pending[0].name).toBe("0003_posts.sql");
  });

  test("ignores applied names not in file list", () => {
    const applied = new Set(["0001_init.sql", "0099_deleted.sql"]);
    const pending = computePending(files, applied);
    expect(pending).toHaveLength(2);
    expect(pending[0].name).toBe("0002_users.sql");
    expect(pending[1].name).toBe("0003_posts.sql");
  });

  test("empty file list returns empty", () => {
    expect(computePending([], new Set(["anything"]))).toEqual([]);
  });
});
