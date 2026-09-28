import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import type { Env } from "../../types.js";
import { applyReleaseMigrations, pickMigrationDatabase } from "./release-migrations.js";

const queries: string[] = [];
const server = setupServer(
  http.post(
    "https://api.cloudflare.com/client/v4/accounts/:acc/d1/database/:id/query",
    async ({ request }) => {
      const { sql } = (await request.json()) as { sql: string };
      queries.push(sql);
      return HttpResponse.json({ success: true, result: [{ results: [] }], errors: [] });
    },
  ),
);
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  queries.length = 0;
  server.resetHandlers();
});
afterAll(() => server.close());

const env = { CLOUDFLARE_ACCOUNT_ID: "acc", CLOUDFLARE_API_TOKEN: "t" } as unknown as Env;

describe("applyReleaseMigrations", () => {
  it("splits a large migration into requests under the size cap, tracking insert last", async () => {
    // 30 statements of ~5 KB each: ~150 KB, over the ~90 KB request cap.
    const statements = Array.from(
      { length: 30 },
      (_, i) => `INSERT INTO t VALUES (${i}, '${"x".repeat(5000)}');`,
    );

    const result = await applyReleaseMigrations(
      env,
      "db-1",
      [{ name: "0001_big.sql", statements }],
      () => {},
    );

    expect(result.applied).toEqual(["0001_big.sql"]);
    const migrationRequests = queries.slice(2); // after CREATE TABLE + SELECT
    expect(migrationRequests.length).toBeGreaterThan(1);
    for (const sql of migrationRequests) {
      expect(new TextEncoder().encode(sql).byteLength).toBeLessThanOrEqual(90 * 1024);
    }
    // Every statement sent exactly once, in order, with the tracking insert last.
    const sent = migrationRequests.join("\n").split("\n");
    expect(sent.slice(0, 30)).toEqual(statements);
    expect(sent[30]).toMatch(
      /^INSERT INTO _creek_migrations \(name, applied_at\) VALUES \('0001_big.sql', \d+\);$/,
    );
    expect(migrationRequests.at(-1)).toContain("INSERT INTO _creek_migrations");
  });
});

describe("pickMigrationDatabase", () => {
  type Entry = [string, { bindingName: string; cfResourceId: string; cfType: string }];
  const d1 = (bindingName: string, id: string): Entry => [
    bindingName,
    { bindingName, cfResourceId: id, cfType: "d1" },
  ];
  const kv: Entry = ["KV", { bindingName: "KV", cfResourceId: "kv-1", cfType: "kv" }];

  it("prefers DB, then the deprecated DATABASE alias, then the only D1", () => {
    expect(pickMigrationDatabase(new Map([d1("AUDIT", "a"), d1("DB", "b")]))).toMatchObject({
      databaseId: "b",
    });
    expect(pickMigrationDatabase(new Map([d1("AUDIT", "a"), d1("DATABASE", "c")]))).toMatchObject({
      databaseId: "c",
    });
    expect(pickMigrationDatabase(new Map([kv, d1("MAIN", "m")]))).toMatchObject({
      ok: true,
      bindingName: "MAIN",
      databaseId: "m",
    });
  });

  it("refuses with no D1, or several and none named DB", () => {
    expect(pickMigrationDatabase(new Map([kv]))).toMatchObject({ ok: false });
    expect(pickMigrationDatabase(new Map([d1("A", "a"), d1("B", "b")]))).toMatchObject({
      ok: false,
    });
  });
});
