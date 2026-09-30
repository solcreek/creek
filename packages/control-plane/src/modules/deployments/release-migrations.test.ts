import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import type { Env } from "../../types.js";
import {
  MAX_MIGRATION_BYTES,
  applyReleaseMigrations,
  pickMigrationDatabase,
} from "./release-migrations.js";

const QUERY = "https://api.cloudflare.com/client/v4/accounts/:acc/d1/database/:id/query";
const queries: string[] = [];
const ok = (results: Array<Record<string, unknown>> = []) =>
  HttpResponse.json({ success: true, result: [{ results }], errors: [] });
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  queries.length = 0;
  server.resetHandlers();
});
afterAll(() => server.close());

const env = { CLOUDFLARE_ACCOUNT_ID: "acc", CLOUDFLARE_API_TOKEN: "t" } as unknown as Env;

/** A fake D1: records every query; `onApply` decides each migration request's fate. */
function fakeD1(opts: { recorded?: () => string[]; onApply?: (sql: string) => Response | null }) {
  server.use(
    http.post(QUERY, async ({ request }) => {
      const { sql } = (await request.json()) as { sql: string };
      queries.push(sql);
      if (sql.startsWith("SELECT name FROM _creek_migrations")) {
        return ok((opts.recorded?.() ?? []).map((name) => ({ name })));
      }
      if (sql.startsWith("CREATE TABLE IF NOT EXISTS _creek_migrations")) return ok();
      return opts.onApply?.(sql) ?? ok();
    }),
  );
}
const d1Error = (message: string) =>
  HttpResponse.json({ success: false, errors: [{ code: 7500, message }] }, { status: 400 });

describe("applyReleaseMigrations", () => {
  it("sends each migration as one request, statements then its tracking insert", async () => {
    fakeD1({});
    const result = await applyReleaseMigrations(
      env,
      "db-1",
      [
        {
          name: "0001_init.sql",
          statements: ["CREATE TABLE a (id INTEGER);", "CREATE INDEX i ON a(id);"],
        },
        { name: "0002_it's.sql", statements: ["CREATE TABLE b (id INTEGER);"] },
      ],
      () => {},
    );

    expect(result).toEqual({ applied: ["0001_init.sql", "0002_it's.sql"], alreadyApplied: 0 });
    const applies = queries.slice(2); // after CREATE TABLE + SELECT
    expect(applies).toHaveLength(2);
    const lines = applies[0].split("\n");
    expect(lines.slice(0, 2)).toEqual(["CREATE TABLE a (id INTEGER);", "CREATE INDEX i ON a(id);"]);
    expect(lines[2]).toMatch(
      /^INSERT INTO _creek_migrations \(name, applied_at\) VALUES \('0001_init.sql', \d+\);$/,
    );
    expect(applies[1]).toContain("VALUES ('0002_it''s.sql',");
  });

  it("refuses a migration too large for one request, sending none of it", async () => {
    fakeD1({});
    const statements = Array.from(
      { length: 30 },
      (_, i) => `INSERT INTO t VALUES (${i}, '${"x".repeat(5000)}');`,
    );

    await expect(
      applyReleaseMigrations(env, "db-1", [{ name: "0001_big.sql", statements }], () => {}),
    ).rejects.toThrow(/migration 0001_big.sql is \d+ KB; .* Split it/);
    expect(queries.some((q) => q.startsWith("INSERT INTO t"))).toBe(false);
    expect(MAX_MIGRATION_BYTES).toBe(90 * 1024);
  });

  it("moves on when a concurrent deploy applied the migration first", async () => {
    let recorded: string[] = [];
    fakeD1({
      recorded: () => recorded,
      onApply: () => {
        recorded = ["0001_init.sql"]; // the other deploy committed first
        return d1Error("table a already exists");
      },
    });
    const logs: string[] = [];

    const result = await applyReleaseMigrations(
      env,
      "db-1",
      [{ name: "0001_init.sql", statements: ["CREATE TABLE a (id INTEGER);"] }],
      (m) => logs.push(m),
    );

    expect(result.applied).toEqual([]);
    expect(logs).toContain("Migration 0001_init.sql was applied by a concurrent deploy");
  });

  it("fails naming the migration when it is still unrecorded, and stops there", async () => {
    fakeD1({ onApply: (sql) => (sql.includes("CREATE TABLE b") ? d1Error("syntax error") : null) });

    await expect(
      applyReleaseMigrations(
        env,
        "db-1",
        [
          { name: "0001_a.sql", statements: ["CREATE TABLE a (id INTEGER);"] },
          { name: "0002_b.sql", statements: ["CREATE TABLE b (id INTEGER);"] },
          { name: "0003_c.sql", statements: ["CREATE TABLE c (id INTEGER);"] },
        ],
        () => {},
      ),
    ).rejects.toThrow(/migration 0002_b.sql failed: .*syntax error/);
    expect(queries.some((q) => q.includes("CREATE TABLE c"))).toBe(false);
  });
});

describe("pickMigrationDatabase", () => {
  type Entry = [string, { bindingName: string; cfResourceId: string; cfType: string }];
  const d1 = (bindingName: string, id: string): Entry => [
    bindingName,
    { bindingName, cfResourceId: id, cfType: "d1" },
  ];
  const kv: Entry = ["KV", { bindingName: "KV", cfResourceId: "kv-1", cfType: "kv" }];

  it("prefers DATABASE, then its alias DB, then the only D1", () => {
    expect(pickMigrationDatabase(new Map([d1("DB", "b"), d1("DATABASE", "c")]))).toMatchObject({
      databaseId: "c",
    });
    expect(pickMigrationDatabase(new Map([d1("AUDIT", "a"), d1("DB", "b")]))).toMatchObject({
      databaseId: "b",
    });
    expect(pickMigrationDatabase(new Map([kv, d1("MAIN", "m")]))).toMatchObject({
      ok: true,
      bindingName: "MAIN",
      databaseId: "m",
    });
  });

  it("refuses with no D1, or several and none named DATABASE or DB", () => {
    expect(pickMigrationDatabase(new Map([kv]))).toMatchObject({ ok: false });
    expect(pickMigrationDatabase(new Map([d1("A", "a"), d1("B", "b")]))).toMatchObject({
      ok: false,
    });
  });
});
