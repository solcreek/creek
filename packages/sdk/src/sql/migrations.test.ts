import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MIGRATION_DIRS, collectMigrations } from "./migrations.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "creek-sdk-migrations-"));
  mkdirSync(join(dir, "db/migrations"), { recursive: true });
  writeFileSync(join(dir, "db/migrations/0001_a.sql"), "CREATE TABLE a (id INTEGER);");
  // A path that looks like a migration but can't be read as a file.
  mkdirSync(join(dir, "db/migrations/0002_b.sql"));
  writeFileSync(join(dir, "db/migrations/0003_c.sql"), "CREATE TABLE c (id INTEGER);");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("collectMigrations", () => {
  test("skips an unreadable migration by default (sandbox seeding)", () => {
    expect(collectMigrations(dir).map((m) => m.name)).toEqual(["0001_a.sql", "0003_c.sql"]);
  });

  test("strict throws naming the unreadable migration", () => {
    expect(() => collectMigrations(dir, { strict: true })).toThrow(
      /Cannot read migration 0002_b.sql/,
    );
  });

  test("checks the documented directories, drizzle/migrations included", () => {
    expect(MIGRATION_DIRS).toEqual([
      "drizzle",
      "drizzle/migrations",
      "prisma/migrations",
      "migrations",
      "db/migrations",
      "sql",
    ]);
  });
});
