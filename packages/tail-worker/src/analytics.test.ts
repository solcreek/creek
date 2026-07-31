/**
 * Analytics Engine writer tests — mock the AE binding and assert the
 * data point shape. The shape is the contract for SQL queries the
 * Dashboard metrics tab and `creek metrics` CLI will run; if it
 * changes, those break.
 *
 * Cardinality discipline is also tested here — statusBucket MUST
 * collapse status codes into the 5 standard buckets ("1xx" / "2xx"
 * / "3xx" / "4xx" / "5xx" / "n/a"). If a numeric status leaks into
 * a blob, AE row count explodes.
 */

import { describe, test, expect, beforeEach } from "vitest";
import { writeBatchToAnalytics } from "./analytics.js";
import type { LogEntry } from "./types.js";

interface DataPoint {
  blobs?: string[];
  doubles?: number[];
  indexes?: string[];
}

let points: DataPoint[];
const mockDataset = {
  writeDataPoint(dp: DataPoint) {
    points.push(dp);
  },
} as unknown as AnalyticsEngineDataset;

beforeEach(() => {
  points = [];
});

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    v: 1,
    timestamp: 1700000000000,
    team: "acme",
    project: "blog",
    scriptType: "production",
    outcome: "ok",
    request: { url: "https://x.com/", method: "GET", status: 200 },
    logs: [],
    exceptions: [],
    ...overrides,
  };
}

describe("writeBatchToAnalytics", () => {
  test("empty batch → no AE calls", () => {
    writeBatchToAnalytics({ ANALYTICS: mockDataset }, []);
    expect(points).toEqual([]);
  });

  test("one entry → one data point with full shape", () => {
    writeBatchToAnalytics({ ANALYTICS: mockDataset }, [entry()]);
    expect(points).toHaveLength(1);
    expect(points[0]).toEqual({
      indexes: ["acme"],
      blobs: ["acme", "blog", "production", "ok", "GET", "2xx"],
      doubles: [1, 0],
    });
  });

  test("error indicator: outcome != ok → isError=1", () => {
    writeBatchToAnalytics({ ANALYTICS: mockDataset }, [entry({ outcome: "exception" })]);
    expect(points[0].doubles).toEqual([1, 1]);
  });

  test("error indicator: 5xx response → isError=1 even when outcome=ok", () => {
    // Worker returned but the response itself was a server error.
    writeBatchToAnalytics({ ANALYTICS: mockDataset }, [
      entry({ outcome: "ok", request: { url: "/", method: "POST", status: 503 } }),
    ]);
    expect(points[0].doubles).toEqual([1, 1]);
  });

  test("error indicator: exception captured but outcome=ok (warn-only handler)", () => {
    writeBatchToAnalytics({ ANALYTICS: mockDataset }, [
      entry({
        outcome: "ok",
        exceptions: [{ name: "Warn", message: "non-fatal", timestamp: 0 }],
      }),
    ]);
    expect(points[0].doubles).toEqual([1, 1]);
  });

  test("4xx is NOT counted as error — client error, not server bug", () => {
    writeBatchToAnalytics({ ANALYTICS: mockDataset }, [
      entry({ request: { url: "/", method: "GET", status: 404 } }),
    ]);
    expect(points[0].doubles).toEqual([1, 0]);
    expect(points[0].blobs?.[5]).toBe("4xx");
  });

  test("statusBucket collapses status codes (cardinality discipline)", () => {
    const cases: Array<[number | undefined, string]> = [
      [100, "1xx"],
      [199, "1xx"],
      [200, "2xx"],
      [299, "2xx"],
      [301, "3xx"],
      [400, "4xx"],
      [499, "4xx"],
      [500, "5xx"],
      [599, "5xx"],
      [undefined, "n/a"],
    ];
    for (const [status, bucket] of cases) {
      points = [];
      writeBatchToAnalytics({ ANALYTICS: mockDataset }, [
        entry({
          request: { url: "/", method: "GET", ...(status !== undefined ? { status } : {}) },
        }),
      ]);
      expect(points[0].blobs?.[5], `status ${status} → bucket`).toBe(bucket);
    }
  });

  test("non-fetch event (no request) → method=n/a, status=n/a", () => {
    writeBatchToAnalytics({ ANALYTICS: mockDataset }, [entry({ request: undefined })]);
    expect(points[0].blobs?.[4]).toBe("n/a");
    expect(points[0].blobs?.[5]).toBe("n/a");
  });

  test("index column is team — used for tenant-scoped pre-filter at query time", () => {
    writeBatchToAnalytics({ ANALYTICS: mockDataset }, [
      entry({ team: "tenant-1" }),
      entry({ team: "tenant-2" }),
    ]);
    expect(points.map((p) => p.indexes?.[0])).toEqual(["tenant-1", "tenant-2"]);
  });

  test("multi-entry batch writes one point per entry", () => {
    writeBatchToAnalytics({ ANALYTICS: mockDataset }, [
      entry(),
      entry({ project: "shop" }),
      entry({ scriptType: "branch", branch: "feat" }),
    ]);
    expect(points).toHaveLength(3);
    expect(points.map((p) => p.blobs?.[2])).toEqual(["production", "production", "branch"]);
  });
});

/**
 * Mirror check for the write-side `isError`.
 *
 * Same cases as @solcreek/sdk's is-error.test.ts. This worker cannot
 * import the SDK, so the two copies are kept honest by driving both
 * through the same table — if either side is edited alone, its own suite
 * fails and the other file is named right here.
 *
 * The stakes: this function decides the AE column `creek metrics` sums,
 * and the SDK copy decides what `creek logs --errors` returns. They
 * disagreed once already — metrics reported 40 errors that logs could
 * not find (reported 2026-07-30).
 */
describe("isError parity with @solcreek/sdk (via the AE double2 column)", () => {
  const base = {
    v: 1 as const,
    timestamp: 0,
    team: "acme",
    project: "site",
    scriptType: "production" as const,
    logs: [],
  };
  const errFlag = (e: Record<string, unknown>): number => {
    const points: Array<{ doubles?: number[] }> = [];
    writeBatchToAnalytics(
      { ANALYTICS: { writeDataPoint: (dp: { doubles?: number[] }) => points.push(dp) } as never },
      [{ ...base, ...e } as never],
    );
    return points[0].doubles![1];
  };
  const EXC = { name: "Error", message: "Network connection lost.", timestamp: 0 };

  test("a clean ok request is not an error", () => {
    expect(
      errFlag({ outcome: "ok", exceptions: [], request: { url: "u", method: "GET", status: 200 } }),
    ).toBe(0);
  });

  test("any non-ok outcome is an error", () => {
    for (const outcome of [
      "exception",
      "exceededCpu",
      "exceededMemory",
      "canceled",
      "responseStreamDisconnected",
      "scriptNotFound",
      "unknown",
    ]) {
      expect(errFlag({ outcome, exceptions: [] })).toBe(1);
    }
  });

  test('an "ok" invocation that recorded an exception IS an error', () => {
    expect(errFlag({ outcome: "ok", exceptions: [EXC] })).toBe(1);
  });

  test('an "ok" invocation that returned 5xx IS an error', () => {
    expect(
      errFlag({ outcome: "ok", exceptions: [], request: { url: "u", method: "GET", status: 503 } }),
    ).toBe(1);
  });

  test("4xx is not an error", () => {
    expect(
      errFlag({ outcome: "ok", exceptions: [], request: { url: "u", method: "GET", status: 404 } }),
    ).toBe(0);
  });

  test("a missing status is not treated as 5xx", () => {
    expect(errFlag({ outcome: "ok", exceptions: [], request: { url: "u", method: "GET" } })).toBe(
      0,
    );
  });
});
