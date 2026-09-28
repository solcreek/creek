import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { releaseMigrationsForDeploy } from "./deploy.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "creek-release-migrations-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writeMigration(name: string, sql: string) {
  mkdirSync(join(dir, "db/migrations"), { recursive: true });
  writeFileSync(join(dir, "db/migrations", name), sql);
}

describe("releaseMigrationsForDeploy", () => {
  test("ships the project's migrations, in order, when [release] migrations is on", () => {
    writeMigration("0002_posts.sql", "CREATE TABLE posts (id INTEGER);");
    writeMigration(
      "0001_users.sql",
      "CREATE TABLE users (id INTEGER);\nCREATE INDEX u ON users(id);",
    );

    const { migrations, warnings } = releaseMigrationsForDeploy(
      { releaseMigrations: true, releaseCommand: null },
      dir,
    );

    expect(warnings).toEqual([]);
    expect(migrations.map((m) => m.name)).toEqual(["0001_users.sql", "0002_posts.sql"]);
    expect(migrations[0].statements).toHaveLength(2);
  });

  test("ships nothing when the switch is off", () => {
    writeMigration("0001_users.sql", "CREATE TABLE users (id INTEGER);");

    const { migrations, warnings } = releaseMigrationsForDeploy(
      { releaseMigrations: false, releaseCommand: null },
      dir,
    );

    expect(migrations).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("warns when the switch is on but no migrations exist", () => {
    const { migrations, warnings } = releaseMigrationsForDeploy(
      { releaseMigrations: true, releaseCommand: null },
      dir,
    );

    expect(migrations).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("no migrations were found");
  });

  test("warns that [release] command does not run on Cloudflare deploys", () => {
    const { warnings } = releaseMigrationsForDeploy(
      { releaseMigrations: false, releaseCommand: "creek db migrate --yes" },
      dir,
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("set [release] migrations = true");
  });
});
