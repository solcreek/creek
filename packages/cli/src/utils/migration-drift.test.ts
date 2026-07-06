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

/**
 * A fake client with a bound database and a fixed applied set.
 *
 * `applied` sets the applied migrations for the single default DB (res-1).
 * For multi-DB scenarios, pass explicit `bindings` plus `appliedByResource`
 * (resourceId → applied names, or an Error to make that DB unreadable).
 */
function fakeClient(opts: {
  bindings?: Array<{ resourceId: string; kind: string; name: string }>;
  applied?: string[];
  appliedByResource?: Record<string, string[] | Error>;
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
    async queryDatabase(resourceId: string) {
      if (opts.queryError) throw opts.queryError;
      if (opts.appliedByResource) {
        const entry = opts.appliedByResource[resourceId];
        if (entry instanceof Error) throw entry;
        return { rows: (entry ?? []).map((name) => ({ name })) };
      }
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

  it("reports databaseCount 1 and no multi-db scope for a single database", async () => {
    writeMigration("0001_init");
    const drift = await detectMigrationDrift({
      cwd: testDir,
      projectSlug: "proj",
      client: fakeClient({ applied: [] }),
    });
    expect(drift.databaseCount).toBe(1);
    expect(driftWarning(drift)).not.toContain("bound databases");
  });

  // --- B10: a project binding more than one D1 ---
  describe("multiple bound databases", () => {
    const twoDbs = [
      { resourceId: "real", kind: "database", name: "creek-real" },
      { resourceId: "spare", kind: "database", name: "creek-spare" },
    ];

    it("reports in-sync against the migrated DB, ignoring an empty spare", async () => {
      writeMigration("0001_init");
      writeMigration("0002_add");
      const drift = await detectMigrationDrift({
        cwd: testDir,
        projectSlug: "proj",
        client: fakeClient({
          bindings: twoDbs,
          appliedByResource: { real: ["0001_init", "0002_add"], spare: [] },
        }),
      });
      expect(drift.status).toBe("in-sync");
      expect(drift.pending).toEqual([]);
      expect(drift.databaseName).toBe("creek-real");
      expect(drift.databaseCount).toBe(2);
      expect(driftWarning(drift)).toBeNull();
    });

    it("does not depend on binding order (empty DB listed first)", async () => {
      writeMigration("0001_init");
      writeMigration("0002_add");
      const drift = await detectMigrationDrift({
        cwd: testDir,
        projectSlug: "proj",
        client: fakeClient({
          bindings: [twoDbs[1], twoDbs[0]], // spare first
          appliedByResource: { real: ["0001_init", "0002_add"], spare: [] },
        }),
      });
      expect(drift.status).toBe("in-sync");
      expect(drift.databaseName).toBe("creek-real");
    });

    it("warns against the least-behind DB when every bound DB lags", async () => {
      writeMigration("0001_init");
      writeMigration("0002_add");
      writeMigration("0003_more");
      const drift = await detectMigrationDrift({
        cwd: testDir,
        projectSlug: "proj",
        client: fakeClient({
          bindings: twoDbs,
          appliedByResource: {
            real: ["0001_init", "0002_add"], // 1 pending
            spare: ["0001_init"], // 2 pending
          },
        }),
      });
      expect(drift.status).toBe("pending");
      expect(drift.pending).toEqual(["0003_more"]);
      expect(drift.databaseName).toBe("creek-real");
      expect(driftWarning(drift)).toContain("1 migration not yet applied");
      expect(driftWarning(drift)).toContain("most up-to-date of 2 bound databases");
    });

    it("skips an unreadable DB and evaluates the readable one", async () => {
      writeMigration("0001_init");
      const drift = await detectMigrationDrift({
        cwd: testDir,
        projectSlug: "proj",
        client: fakeClient({
          bindings: twoDbs,
          appliedByResource: {
            real: new Error("503 upstream unavailable"),
            spare: ["0001_init"],
          },
        }),
      });
      expect(drift.status).toBe("in-sync");
      expect(drift.databaseName).toBe("creek-spare");
    });

    it("treats a missing tracking table on one DB as everything-pending", async () => {
      writeMigration("0001_init");
      writeMigration("0002_add");
      const drift = await detectMigrationDrift({
        cwd: testDir,
        projectSlug: "proj",
        client: fakeClient({
          bindings: twoDbs,
          appliedByResource: {
            real: new Error("D1_ERROR: no such table: _creek_migrations"),
            spare: ["0001_init"], // 1 pending — least behind, wins
          },
        }),
      });
      expect(drift.status).toBe("pending");
      expect(drift.databaseName).toBe("creek-spare");
      expect(drift.pending).toEqual(["0002_add"]);
    });

    it("degrades to unknown when every bound DB is unreadable", async () => {
      writeMigration("0001_init");
      const drift = await detectMigrationDrift({
        cwd: testDir,
        projectSlug: "proj",
        client: fakeClient({
          bindings: twoDbs,
          appliedByResource: {
            real: new Error("503"),
            spare: new Error("network"),
          },
        }),
      });
      expect(drift.status).toBe("unknown");
      expect(driftWarning(drift)).toBeNull();
    });
  });
});
