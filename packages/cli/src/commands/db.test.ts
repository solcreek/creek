import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dbCommand } from "./db.js";

// Drive `creek db migrate` end to end against an in-memory fake D1, exercising
// the apply loop in db.ts (list resources → ensure tracking table → diff →
// apply each pending migration → record it). MSW mocks the control-plane HTTP;
// process.exit is stubbed so we assert on the exit code + JSON output instead
// of tearing vitest down. Tests run non-TTY, so resolveJsonMode is true and the
// command emits machine-readable JSON. Fabricated IDs only.
const API = "https://cp.test";
const DB_ID = "db-1";

const migrateCommand = (dbCommand.subCommands as Record<string, { run?: (ctx: never) => Promise<unknown> }>).migrate;

// --- In-memory fake D1 ---
// Mirrors just enough of D1's observable behaviour for the migration loop:
// a `_creek_migrations` tracking table and a set of created tables that rejects
// a duplicate `CREATE TABLE` with the same "already exists" error D1 returns.
interface FakeD1 {
  applied: Set<string>; // names recorded in _creek_migrations
  tables: Set<string>; // tables that physically exist
  calls: string[]; // ordered log of request "kinds" for structural assertions
}

function makeD1(seed?: { applied?: string[]; tables?: string[] }): FakeD1 {
  return {
    applied: new Set(seed?.applied ?? []),
    tables: new Set(seed?.tables ?? []),
    calls: [],
  };
}

function okResult(changes = 0) {
  return HttpResponse.json({
    columns: [],
    rows: [],
    meta: { changes, duration: 1, rows_read: 0, rows_written: changes },
  });
}

function rowsResult(rows: Record<string, unknown>[]) {
  return HttpResponse.json({
    columns: ["name"],
    rows,
    meta: { changes: 0, duration: 1, rows_read: rows.length, rows_written: 0 },
  });
}

/** MSW handlers backed by a FakeD1 instance. */
function d1Handlers(d1: FakeD1) {
  return [
    http.get(`${API}/resources`, () =>
      HttpResponse.json({
        resources: [
          {
            id: DB_ID,
            teamId: "team-1",
            kind: "database",
            name: "mydb",
            cfResourceId: "cf-1",
            cfResourceType: "d1",
            status: "active",
            createdAt: 0,
            updatedAt: 0,
          },
        ],
      }),
    ),
    http.post(`${API}/resources/${DB_ID}/query`, async ({ request }) => {
      const { sql } = (await request.json()) as { sql: string; params?: unknown[] };

      // Ensure tracking table — idempotent no-op.
      if (/CREATE TABLE IF NOT EXISTS _creek_migrations/i.test(sql)) {
        d1.calls.push("ensure-tracking");
        return okResult();
      }
      // Read applied migrations.
      if (sql.trimStart().startsWith("SELECT name FROM _creek_migrations")) {
        d1.calls.push("read-applied");
        return rowsResult([...d1.applied].sort().map((name) => ({ name })));
      }

      // A request may carry migration statements, a folded tracking insert, or
      // both — the apply loop now records a migration in the SAME request as
      // its schema change. Parse out created tables and any recorded names.
      const created = [...sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?["'`]?(\w+)["'`]?/gi)]
        .map((m) => m[1])
        .filter((t) => t !== "_creek_migrations");
      const trackNames = [...sql.matchAll(/INSERT INTO _creek_migrations[^']*'([^']+)'/gi)].map((m) => m[1]);

      if (created.length > 0) {
        d1.calls.push("batch");
        // Reject any table that already exists, leaving NOTHING recorded — a
        // non-transactional /query aborts at the failing statement, so the
        // folded tracking insert never runs. This is what bites a re-run after
        // an interrupted, half-applied migration.
        const dup = created.find((t) => d1.tables.has(t));
        if (dup) {
          return HttpResponse.json(
            { error: "d1_error", message: `D1_ERROR: table ${dup} already exists` },
            { status: 400 },
          );
        }
        for (const t of created) d1.tables.add(t);
        for (const n of trackNames) d1.applied.add(n); // folded tracking insert
        return okResult(created.length);
      }

      // Standalone tracking insert — the --resume reconcile path.
      if (trackNames.length > 0) {
        d1.calls.push("track");
        for (const n of trackNames) d1.applied.add(n);
        return okResult(1);
      }

      d1.calls.push("other");
      return okResult();
    }),
  ];
}

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

class ExitSignal extends Error {
  constructor(public code: number) {
    super(`exit:${code}`);
  }
}

let stdout: string;
let testDir: string;
beforeEach(() => {
  stdout = "";
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as never);
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  });
  process.env.CREEK_API_URL = API;
  process.env.CREEK_TOKEN = "tok-test";

  testDir = join(tmpdir(), `creek-db-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CREEK_API_URL;
  delete process.env.CREEK_TOKEN;
  rmSync(testDir, { recursive: true, force: true });
});

/** Write a Prisma-style nested migration (`<name>/migration.sql`). */
function writeMigration(name: string, sql: string) {
  const dir = join(testDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "migration.sql"), sql);
}

/** Run the migrate command and return the exit code its process.exit got. */
async function runMigrate(args: Record<string, unknown>): Promise<number> {
  try {
    await migrateCommand.run!({ args: { dir: testDir, "dry-run": false, ...args } } as never);
    // A successful run with nothing to report may not call process.exit.
    return 0;
  } catch (err) {
    if (err instanceof ExitSignal) return err.code;
    throw err;
  }
}

function json() {
  return JSON.parse(stdout);
}

describe("creek db migrate", () => {
  it("applies all pending migrations and records each in the tracking table", async () => {
    const d1 = makeD1();
    server.use(...d1Handlers(d1));
    writeMigration("0001_init", "CREATE TABLE A (id INTEGER PRIMARY KEY);");
    writeMigration("0002_add", "CREATE TABLE B (id INTEGER PRIMARY KEY);");
    writeMigration("0003_more", "CREATE TABLE C (id INTEGER PRIMARY KEY);");

    const code = await runMigrate({ name: "mydb" });

    expect(code).toBe(0);
    expect(json()).toMatchObject({ ok: true, migrated: 3, total: 3 });
    expect(d1.applied).toEqual(new Set(["0001_init", "0002_add", "0003_more"]));
    expect(d1.tables).toEqual(new Set(["A", "B", "C"]));
  });

  it("applies only migrations not yet recorded as applied", async () => {
    // 0001 already applied; A already exists. Only 0002, 0003 should run.
    const d1 = makeD1({ applied: ["0001_init"], tables: ["A"] });
    server.use(...d1Handlers(d1));
    writeMigration("0001_init", "CREATE TABLE A (id INTEGER PRIMARY KEY);");
    writeMigration("0002_add", "CREATE TABLE B (id INTEGER PRIMARY KEY);");
    writeMigration("0003_more", "CREATE TABLE C (id INTEGER PRIMARY KEY);");

    const code = await runMigrate({ name: "mydb" });

    expect(code).toBe(0);
    expect(json()).toMatchObject({ ok: true, migrated: 2 });
    expect(d1.applied).toEqual(new Set(["0001_init", "0002_add", "0003_more"]));
    expect(d1.calls.filter((c) => c === "batch")).toHaveLength(2);
  });

  it("reports up to date when every migration is already applied", async () => {
    const d1 = makeD1({ applied: ["0001_init"], tables: ["A"] });
    server.use(...d1Handlers(d1));
    writeMigration("0001_init", "CREATE TABLE A (id INTEGER PRIMARY KEY);");

    const code = await runMigrate({ name: "mydb" });

    expect(code).toBe(0);
    expect(json()).toMatchObject({ ok: true, migrated: 0 });
    expect(d1.calls).not.toContain("batch");
  });

  it("--dry-run lists pending migrations without touching the database", async () => {
    const d1 = makeD1({ applied: ["0001_init"], tables: ["A"] });
    server.use(...d1Handlers(d1));
    writeMigration("0001_init", "CREATE TABLE A (id INTEGER PRIMARY KEY);");
    writeMigration("0002_add", "CREATE TABLE B (id INTEGER PRIMARY KEY);");

    const code = await runMigrate({ name: "mydb", "dry-run": true });

    expect(code).toBe(0);
    expect(json()).toMatchObject({ ok: true, dryRun: true, pending: ["0002_add"] });
    expect(d1.calls).not.toContain("batch");
    expect(d1.calls).not.toContain("track");
  });

  it("accepts the database name as a bare positional (args._)", async () => {
    const d1 = makeD1();
    server.use(...d1Handlers(d1));
    writeMigration("0001_init", "CREATE TABLE A (id INTEGER PRIMARY KEY);");

    // No `name` option — the name arrives as the first positional, like
    // `creek db migrate mydb`.
    const code = await runMigrate({ name: undefined, _: ["mydb"] });

    expect(code).toBe(0);
    expect(json()).toMatchObject({ ok: true, migrated: 1 });
  });

  it("accepts the database name via --name", async () => {
    const d1 = makeD1();
    server.use(...d1Handlers(d1));
    writeMigration("0001_init", "CREATE TABLE A (id INTEGER PRIMARY KEY);");

    const code = await runMigrate({ name: "mydb" });

    expect(code).toBe(0);
    expect(json()).toMatchObject({ ok: true, migrated: 1 });
  });

  it("exits no_database_specified when no name, --project, or creek.toml is available", async () => {
    const d1 = makeD1();
    server.use(...d1Handlers(d1));
    writeMigration("0001_init", "CREATE TABLE A (id INTEGER PRIMARY KEY);");

    // No name, no --project, and the cwd has no creek.toml → same unified
    // resolution error `db shell` gives.
    const code = await runMigrate({ name: undefined, _: [] });

    expect(code).toBe(1);
    expect(json()).toMatchObject({ ok: false, error: "no_database_specified" });
  });

  it("infers the database from --project when no name is given", async () => {
    const d1 = makeD1();
    server.use(
      http.get(`${API}/projects/myproj/bindings`, () =>
        HttpResponse.json({
          bindings: [
            { bindingName: "DB", resourceId: DB_ID, kind: "database", name: "mydb", status: "active", createdAt: 0 },
          ],
        }),
      ),
      ...d1Handlers(d1),
    );
    writeMigration("0001_init", "CREATE TABLE A (id INTEGER PRIMARY KEY);");

    // `creek db migrate --project myproj` — no DB name repeated.
    const code = await runMigrate({ name: undefined, _: [], project: "myproj" });

    expect(code).toBe(0);
    expect(json()).toMatchObject({ ok: true, migrated: 1 });
    expect(d1.applied).toEqual(new Set(["0001_init"]));
  });

  it("exits not_found for an unknown database name", async () => {
    const d1 = makeD1();
    server.use(...d1Handlers(d1));
    writeMigration("0001_init", "CREATE TABLE A (id INTEGER PRIMARY KEY);");

    const code = await runMigrate({ name: "nope" });

    expect(code).toBe(1);
    expect(json()).toMatchObject({ ok: false, error: "not_found" });
  });

  // --- B3: atomic apply + --resume recovery ---
  // The migration's schema change and its tracking insert now ride in the SAME
  // request, so an interrupt can't leave a migration applied-but-unrecorded for
  // the common single-request case. For a migration left half-applied by an
  // older/interrupted run, --resume reconciles it instead of getting stuck.
  describe("B3 — atomic apply and --resume", () => {
    it("records a migration in the same request as its schema change", async () => {
      const d1 = makeD1();
      server.use(...d1Handlers(d1));
      writeMigration("0001_init", "CREATE TABLE A (id INTEGER PRIMARY KEY);");

      const code = await runMigrate({ name: "mydb" });

      expect(code).toBe(0);
      // The applied state is recorded by the batch request itself — there is no
      // separate, droppable "track" request to be interrupted between.
      expect(d1.calls).toContain("batch");
      expect(d1.calls).not.toContain("track");
      expect(d1.applied.has("0001_init")).toBe(true);
    });

    it("still fails (without --resume) on a migration left half-applied by an interrupted run", async () => {
      // Default behavior stays conservative: a real collision is a hard error,
      // but the message now points at the recovery path.
      const d1 = makeD1({ applied: ["0001_init"], tables: ["A", "B"] });
      server.use(...d1Handlers(d1));
      writeMigration("0001_init", "CREATE TABLE A (id INTEGER PRIMARY KEY);");
      writeMigration("0002_add", "CREATE TABLE B (id INTEGER PRIMARY KEY);");
      writeMigration("0003_more", "CREATE TABLE C (id INTEGER PRIMARY KEY);");

      const code = await runMigrate({ name: "mydb" });
      expect(code).toBe(1);
      expect(json()).toMatchObject({
        ok: false,
        error: "migration_failed",
        file: "0002_add",
        migrated: 0,
        hint: expect.stringContaining("--resume"),
      });
      expect(d1.applied.has("0002_add")).toBe(false);
    });

    it("--resume reconciles the half-applied migration and continues", async () => {
      // Interrupted state: 0002's CREATE TABLE B reached D1 (table exists) but
      // the tracking insert never did (0002 not in _creek_migrations).
      const d1 = makeD1({ applied: ["0001_init"], tables: ["A", "B"] });
      server.use(...d1Handlers(d1));
      writeMigration("0001_init", "CREATE TABLE A (id INTEGER PRIMARY KEY);");
      writeMigration("0002_add", "CREATE TABLE B (id INTEGER PRIMARY KEY);");
      writeMigration("0003_more", "CREATE TABLE C (id INTEGER PRIMARY KEY);");

      const code = await runMigrate({ name: "mydb", resume: true });

      expect(code).toBe(0);
      // 0002 reconciled (recorded without re-creating B); 0003 applied fresh.
      expect(json()).toMatchObject({ ok: true, migrated: 2, resumed: 1 });
      expect(d1.applied.has("0002_add")).toBe(true);
      expect(d1.applied.has("0003_more")).toBe(true);
      expect(d1.tables.has("C")).toBe(true);
    });
  });
});
