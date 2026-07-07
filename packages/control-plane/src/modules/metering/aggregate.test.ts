import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { utcDateString, yesterdayUTC, buildAggregateSql, aggregateYesterday } from "./aggregate.js";
import { createLocalTestEnv, type LocalTestEnv } from "../../local/test-env.js";

describe("utcDateString", () => {
  test("formats UTC date as YYYY-MM-DD", () => {
    expect(utcDateString(new Date("2026-04-17T00:00:00Z"))).toBe("2026-04-17");
    expect(utcDateString(new Date("2026-04-17T23:59:59Z"))).toBe("2026-04-17");
  });

  test("ignores local timezone — always UTC", () => {
    expect(utcDateString(new Date("2026-04-17T00:30:00Z"))).toBe("2026-04-17");
  });
});

describe("yesterdayUTC", () => {
  test("returns the UTC day before now", () => {
    expect(yesterdayUTC(new Date("2026-04-17T12:00:00Z"))).toBe("2026-04-16");
  });

  test("handles month boundary", () => {
    expect(yesterdayUTC(new Date("2026-05-01T00:00:00Z"))).toBe("2026-04-30");
  });

  test("handles year boundary", () => {
    expect(yesterdayUTC(new Date("2026-01-01T00:00:00Z"))).toBe("2025-12-31");
  });
});

describe("buildAggregateSql", () => {
  test("half-open interval covers exactly one UTC day", () => {
    const sql = buildAggregateSql("2026-04-16");
    expect(sql).toContain("timestamp >= toDateTime('2026-04-16 00:00:00')");
    expect(sql).toContain("INTERVAL '1' DAY");
  });

  test("excludes empty team/project blobs", () => {
    const sql = buildAggregateSql("2026-04-16");
    expect(sql).toContain("blob1 != ''");
    expect(sql).toContain("blob2 != ''");
  });

  test("groups by team and project", () => {
    const sql = buildAggregateSql("2026-04-16");
    expect(sql).toContain("GROUP BY team, project");
  });
});

describe("aggregateYesterday", () => {
  let testEnv: LocalTestEnv;
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    testEnv = createLocalTestEnv();
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    testEnv.cleanup();
    globalThis.fetch = originalFetch;
  });

  function makeEnv(aeData: Array<Record<string, unknown>>) {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ meta: [], data: aeData, rows: aeData.length }),
    });
    return {
      ...testEnv.env,
      CLOUDFLARE_API_TOKEN: "tok",
      CLOUDFLARE_ACCOUNT_ID: "acct",
    };
  }

  test("writes one upsert per team+project row into usage_daily", async () => {
    const env = makeEnv([
      { team: "acme", project: "site", requests: 1234, errors: 5 },
      { team: "acme", project: "api", requests: 777, errors: 0 },
      { team: "other-team", project: "landing", requests: 12, errors: 0 },
    ]);

    const res = await aggregateYesterday(env as any, new Date("2026-04-17T00:05:00Z"));
    expect(res.date).toBe("2026-04-16");
    expect(res.rows).toBe(3);

    // Verify data in real SQLite
    const rows = (await testEnv.env.DB.prepare(
      "SELECT * FROM usage_daily ORDER BY teamSlug, projectSlug",
    ).all()) as any;
    expect(rows.results).toHaveLength(3);
    expect(rows.results[0].teamSlug).toBe("acme");
    expect(rows.results[0].projectSlug).toBe("api");
    expect(rows.results[0].requests).toBe(777);
  });

  test("rounds fractional AE values", async () => {
    const env = makeEnv([{ team: "t", project: "p", requests: 1023.7, errors: 0.3 }]);

    await aggregateYesterday(env as any, new Date("2026-04-17T00:05:00Z"));

    const row = (await testEnv.env.DB.prepare(
      "SELECT requests, errors FROM usage_daily WHERE teamSlug = 't'",
    ).first()) as any;
    expect(row.requests).toBe(1024);
    expect(row.errors).toBe(0);
  });

  test("handles AE nulls as zero", async () => {
    const env = makeEnv([{ team: "t", project: "p", requests: null, errors: null }]);

    await aggregateYesterday(env as any, new Date("2026-04-17T00:05:00Z"));

    const row = (await testEnv.env.DB.prepare(
      "SELECT requests, errors FROM usage_daily WHERE teamSlug = 't'",
    ).first()) as any;
    expect(row.requests).toBe(0);
    expect(row.errors).toBe(0);
  });

  test("empty AE response writes nothing", async () => {
    const env = makeEnv([]);

    const res = await aggregateYesterday(env as any, new Date("2026-04-17T00:05:00Z"));
    expect(res.rows).toBe(0);

    const count = (await testEnv.env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM usage_daily",
    ).first()) as any;
    expect(count.cnt).toBe(0);
  });
});
