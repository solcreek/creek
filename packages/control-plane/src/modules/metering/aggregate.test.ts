import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  utcDateString,
  yesterdayUTC,
  buildAggregateSql,
  aggregateYesterday,
} from "./aggregate.js";

describe("utcDateString", () => {
  test("formats UTC date as YYYY-MM-DD", () => {
    expect(utcDateString(new Date("2026-04-17T00:00:00Z"))).toBe("2026-04-17");
    expect(utcDateString(new Date("2026-04-17T23:59:59Z"))).toBe("2026-04-17");
  });

  test("ignores local timezone — always UTC", () => {
    // 2026-04-17T00:30:00Z is 2026-04-16 20:30 in US/Eastern. We want
    // "2026-04-17" regardless of where the Worker happens to run.
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

  test("excludes empty team/project blobs — dispatch-worker traces", () => {
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
  let batched: unknown[][];
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    batched = [];
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  function makeEnv(aeData: Array<Record<string, unknown>>) {
    const stmt = {
      bind: (...args: unknown[]) => {
        batched.push(args);
        return { /* D1PreparedStatement */ };
      },
    };
    return {
      DB: {
        prepare: () => stmt,
        batch: async (list: unknown[]) => ({ list }),
      } as unknown as D1Database,
      CLOUDFLARE_API_TOKEN: "tok",
      CLOUDFLARE_ACCOUNT_ID: "acct",
      __setAe(data: Array<Record<string, unknown>>) {
        fetchMock.mockResolvedValue({
          ok: true,
          json: async () => ({
            meta: [],
            data,
            rows: data.length,
          }),
        });
      },
    };
  }

  test("writes one upsert per team+project row", async () => {
    const env = makeEnv([]);
    env.__setAe([
      { team: "acme", project: "site", requests: 1234, errors: 5 },
      { team: "acme", project: "api", requests: 777, errors: 0 },
      { team: "other-team", project: "landing", requests: 12, errors: 0 },
    ]);

    const res = await aggregateYesterday(env, new Date("2026-04-17T00:05:00Z"));
    expect(res.date).toBe("2026-04-16");
    expect(res.rows).toBe(3);
    expect(batched).toHaveLength(3);

    const [row0] = batched;
    expect(row0[0]).toBe("acme");
    expect(row0[1]).toBe("site");
    expect(row0[2]).toBe("2026-04-16");
    expect(row0[3]).toBe(1234);
    expect(row0[4]).toBe(5);
  });

  test("rounds fractional AE values — _sample_interval can push non-integers", async () => {
    const env = makeEnv([]);
    env.__setAe([
      { team: "t", project: "p", requests: 1023.7, errors: 0.3 },
    ]);

    await aggregateYesterday(env, new Date("2026-04-17T00:05:00Z"));
    expect(batched[0][3]).toBe(1024);
    expect(batched[0][4]).toBe(0);
  });

  test("handles AE nulls — projects with no traffic aren't missing, they're just zero", async () => {
    const env = makeEnv([]);
    env.__setAe([
      { team: "t", project: "p", requests: null, errors: null },
    ]);

    await aggregateYesterday(env, new Date("2026-04-17T00:05:00Z"));
    expect(batched[0][3]).toBe(0);
    expect(batched[0][4]).toBe(0);
  });

  test("empty AE response writes nothing and returns rows:0", async () => {
    const env = makeEnv([]);
    env.__setAe([]);

    const res = await aggregateYesterday(env, new Date("2026-04-17T00:05:00Z"));
    expect(res.rows).toBe(0);
    expect(batched).toHaveLength(0);
  });
});
