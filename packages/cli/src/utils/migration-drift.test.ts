import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectMigrationDrift, driftWarning, type DriftClient } from "./migration-drift.js";

let testDir: string;
beforeEach(() => {
  testDir = join(tmpdir(), `creek-drift-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});
afterEach(() => rmSync(testDir, { recursive: true, force: true }));

/** Write a Prisma-style nested migration under prisma/migrations. */
function writeMigration(name: string, sql = "CREATE TABLE T (id INTEGER);") {
  const dir = join(testDir, "prisma", "migrations", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "migration.sql"), sql);
}

/** A fake client with a bound database and a fixed applied set. */
function fakeClient(opts: {
  bindings?: Array<{ resourceId: string; kind: string; name: string }>;
  applied?: string[];
  queryError?: Error;
  bindingsError?: Error;
}): DriftClient {
  return {
    async listBindings() {
      if (opts.bindingsError) throw opts.bindingsError;
      return {
        bindings:
          opts.bindings ?? [{ resourceId: "res-1", kind: "database", name: "mydb" }],
      };
    },
    async queryDatabase() {
      if (opts.queryError) throw opts.queryError;
      return { rows: (opts.applied ?? []).map((name) => ({ name })) };
    },
  };
}

describe("detectMigrationDrift", () => {
  it("returns no-migrations when there is no migration directory", async () => {
    const drift = await detectMigrationDrift({
      cwd: testDir,
      projectSlug: "proj",
      client: fakeClient({}),
    });
    expect(drift.status).toBe("no-migrations");
    expect(driftWarning(drift)).toBeNull();
  });

  it("flags pending migrations the database has not applied", async () => {
    writeMigration("0001_init");
    writeMigration("0002_add");
    writeMigration("0003_more");
    const drift = await detectMigrationDrift({
      cwd: testDir,
      projectSlug: "proj",
      client: fakeClient({ applied: ["0001_init"] }),
    });
    expect(drift.status).toBe("pending");
    expect(drift.pending).toEqual(["0002_add", "0003_more"]);
    expect(drift.applied).toBe(1);
    expect(drift.total).toBe(3);
    expect(drift.databaseName).toBe("mydb");
    expect(driftWarning(drift)).toContain("2 migrations not yet applied");
    expect(driftWarning(drift)).toContain("mydb");
  });

  it("reports in-sync when every local migration is applied", async () => {
    writeMigration("0001_init");
    writeMigration("0002_add");
    const drift = await detectMigrationDrift({
      cwd: testDir,
      projectSlug: "proj",
      client: fakeClient({ applied: ["0001_init", "0002_add"] }),
    });
    expect(drift.status).toBe("in-sync");
    expect(drift.pending).toEqual([]);
    expect(driftWarning(drift)).toBeNull();
  });

  it("treats a missing tracking table as everything pending", async () => {
    writeMigration("0001_init");
    writeMigration("0002_add");
    const drift = await detectMigrationDrift({
      cwd: testDir,
      projectSlug: "proj",
      client: fakeClient({ queryError: new Error("D1_ERROR: no such table: _creek_migrations") }),
    });
    expect(drift.status).toBe("pending");
    expect(drift.pending).toEqual(["0001_init", "0002_add"]);
    expect(drift.applied).toBe(0);
  });

  it("returns no-database when migrations exist but nothing is bound", async () => {
    writeMigration("0001_init");
    const drift = await detectMigrationDrift({
      cwd: testDir,
      projectSlug: "proj",
      client: fakeClient({ bindings: [{ resourceId: "r", kind: "storage", name: "files" }] }),
    });
    expect(drift.status).toBe("no-database");
    expect(driftWarning(drift)).toContain("no database is bound");
  });

  it("degrades to unknown (never throws) when applied state can't be read", async () => {
    writeMigration("0001_init");
    const drift = await detectMigrationDrift({
      cwd: testDir,
      projectSlug: "proj",
      client: fakeClient({ queryError: new Error("503 upstream unavailable") }),
    });
    expect(drift.status).toBe("unknown");
    expect(driftWarning(drift)).toBeNull();
  });

  it("degrades to unknown when bindings can't be listed", async () => {
    writeMigration("0001_init");
    const drift = await detectMigrationDrift({
      cwd: testDir,
      projectSlug: "proj",
      client: fakeClient({ bindingsError: new Error("network") }),
    });
    expect(drift.status).toBe("unknown");
  });

  it("honors an explicit migrationDir override", async () => {
    const custom = join(testDir, "db", "changes");
    mkdirSync(custom, { recursive: true });
    writeFileSync(join(custom, "0001_init.sql"), "CREATE TABLE T (id INTEGER);");
    const drift = await detectMigrationDrift({
      cwd: testDir,
      projectSlug: "proj",
      client: fakeClient({ applied: [] }),
      migrationDir: custom,
    });
    expect(drift.status).toBe("pending");
    expect(drift.pending).toEqual(["0001_init.sql"]);
  });

  it("uses singular wording for a single pending migration", async () => {
    writeMigration("0001_init");
    const drift = await detectMigrationDrift({
      cwd: testDir,
      projectSlug: "proj",
      client: fakeClient({ applied: [] }),
    });
    expect(driftWarning(drift)).toContain("1 migration not yet applied");
  });
});
