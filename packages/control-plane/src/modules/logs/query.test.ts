/**
 * parseQuery + matchesQuery — pure logic, table-driven.
 *
 * Time parser tests pin `now` so relative durations are deterministic.
 * Filter tests cover the (intended-to-narrow) cross-product of
 * (time × outcome × scriptType × deployId × branch × levels × search).
 */

import { describe, test, expect } from "vitest";
import { parseQuery, matchesQuery } from "./query.js";
import type { LogEntry } from "./types.js";

const NOW = Date.UTC(2026, 3, 13, 18, 0, 0); // 2026-04-13T18:00Z

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    v: 1,
    timestamp: NOW - 60_000, // 1 min ago by default
    team: "acme",
    project: "blog",
    scriptType: "production",
    outcome: "ok",
    request: { url: "https://x.com/api/todos", method: "GET", status: 200 },
    logs: [],
    exceptions: [],
    ...overrides,
  };
}

describe("parseQuery", () => {
  test("defaults: 1h window, limit 100, no filters", () => {
    const q = parseQuery(new URLSearchParams(), NOW);
    expect(q.untilMs).toBe(NOW);
    expect(q.sinceMs).toBe(NOW - 60 * 60 * 1000);
    expect(q.limit).toBe(100);
    expect(q.outcomes.size).toBe(0);
    expect(q.scriptTypes.size).toBe(0);
    expect(q.levels.size).toBe(0);
    expect(q.deployId).toBeNull();
    expect(q.branch).toBeNull();
    expect(q.search).toBe("");
  });

  test("relative since: 30m / 2h / 1d / 90s", () => {
    const cases: Array<[string, number]> = [
      ["30m", NOW - 30 * 60_000],
      ["2h", NOW - 2 * 3_600_000],
      ["1d", NOW - 86_400_000],
      ["90s", NOW - 90_000],
    ];
    for (const [input, expected] of cases) {
      const q = parseQuery(new URLSearchParams({ since: input }), NOW);
      expect(q.sinceMs).toBe(expected);
    }
  });

  test("ISO since/until are honoured", () => {
    const q = parseQuery(
      new URLSearchParams({
        since: "2026-04-13T17:00:00Z",
        until: "2026-04-13T17:30:00Z",
      }),
      NOW,
    );
    expect(q.sinceMs).toBe(Date.UTC(2026, 3, 13, 17, 0, 0));
    expect(q.untilMs).toBe(Date.UTC(2026, 3, 13, 17, 30, 0));
  });

  test("range > 7 days is clamped to 7 days back from until", () => {
    const q = parseQuery(new URLSearchParams({ since: "30d" }), NOW);
    expect(q.untilMs - q.sinceMs).toBe(7 * 24 * 3_600_000);
  });

  test("invalid since falls back to default 1h", () => {
    const q = parseQuery(new URLSearchParams({ since: "garbage" }), NOW);
    expect(q.sinceMs).toBe(NOW - 60 * 60 * 1000);
  });

  test("multiple outcome / scriptType / level params accumulate", () => {
    const q = parseQuery(
      new URLSearchParams([
        ["outcome", "exception"],
        ["outcome", "exceededCpu"],
        ["scriptType", "production"],
        ["scriptType", "branch"],
        ["level", "error"],
        ["level", "warn"],
      ]),
      NOW,
    );
    expect([...q.outcomes].sort()).toEqual(["exceededCpu", "exception"]);
    expect([...q.scriptTypes].sort()).toEqual(["branch", "production"]);
    expect([...q.levels].sort()).toEqual(["error", "warn"]);
  });

  test("invalid enum values are dropped (no error)", () => {
    const q = parseQuery(
      new URLSearchParams([
        ["outcome", "garbage"],
        ["outcome", "ok"],
        ["scriptType", "invalid"],
        ["level", "trace"],
      ]),
      NOW,
    );
    expect([...q.outcomes]).toEqual(["ok"]);
    expect(q.scriptTypes.size).toBe(0);
    expect(q.levels.size).toBe(0);
  });

  test("limit: clamped to [1, 1000], default 100, NaN → default", () => {
    expect(parseQuery(new URLSearchParams({ limit: "50" }), NOW).limit).toBe(50);
    expect(parseQuery(new URLSearchParams({ limit: "5000" }), NOW).limit).toBe(1000);
    expect(parseQuery(new URLSearchParams({ limit: "0" }), NOW).limit).toBe(100);
    expect(parseQuery(new URLSearchParams({ limit: "abc" }), NOW).limit).toBe(100);
  });

  test("until=now is treated as current time", () => {
    const q = parseQuery(new URLSearchParams({ until: "now" }), NOW);
    expect(q.untilMs).toBe(NOW);
  });
});

describe("matchesQuery", () => {
  const baseQuery = parseQuery(new URLSearchParams(), NOW);

  test("entry within time range matches", () => {
    expect(matchesQuery(entry(), baseQuery)).toBe(true);
  });

  test("entry before sinceMs is filtered out", () => {
    expect(
      matchesQuery(entry({ timestamp: NOW - 2 * 60 * 60 * 1000 }), baseQuery),
    ).toBe(false);
  });

  test("outcome filter: only matching outcomes pass", () => {
    const q = parseQuery(new URLSearchParams({ outcome: "exception" }), NOW);
    expect(matchesQuery(entry({ outcome: "ok" }), q)).toBe(false);
    expect(matchesQuery(entry({ outcome: "exception" }), q)).toBe(true);
  });

  test("scriptType filter", () => {
    const q = parseQuery(new URLSearchParams({ scriptType: "branch" }), NOW);
    expect(matchesQuery(entry({ scriptType: "production" }), q)).toBe(false);
    expect(matchesQuery(entry({ scriptType: "branch", branch: "x" }), q)).toBe(true);
  });

  test("deployment filter — only entries with that deployId match", () => {
    const q = parseQuery(new URLSearchParams({ deployment: "a1b2c3d4" }), NOW);
    expect(matchesQuery(entry({ scriptType: "production" }), q)).toBe(false);
    expect(
      matchesQuery(
        entry({ scriptType: "deployment", deployId: "deadbeef" }),
        q,
      ),
    ).toBe(false);
    expect(
      matchesQuery(
        entry({ scriptType: "deployment", deployId: "a1b2c3d4" }),
        q,
      ),
    ).toBe(true);
  });

  test("branch filter", () => {
    const q = parseQuery(new URLSearchParams({ branch: "feat-x" }), NOW);
    expect(matchesQuery(entry({ scriptType: "production" }), q)).toBe(false);
    expect(
      matchesQuery(entry({ scriptType: "branch", branch: "main" }), q),
    ).toBe(false);
    expect(
      matchesQuery(entry({ scriptType: "branch", branch: "feat-x" }), q),
    ).toBe(true);
  });

  test("level filter — entry needs a log line at one of the levels", () => {
    const q = parseQuery(new URLSearchParams({ level: "error" }), NOW);
    expect(matchesQuery(entry({ logs: [] }), q)).toBe(false);
    expect(
      matchesQuery(
        entry({
          logs: [{ level: "log", message: ["x"], timestamp: 0 }],
        }),
        q,
      ),
    ).toBe(false);
    expect(
      matchesQuery(
        entry({
          logs: [{ level: "error", message: ["oops"], timestamp: 0 }],
        }),
        q,
      ),
    ).toBe(true);
  });

  test("search matches console.log message text (case-insensitive)", () => {
    const q = parseQuery(new URLSearchParams({ search: "OOPS" }), NOW);
    expect(
      matchesQuery(
        entry({
          logs: [{ level: "log", message: ["oops something"], timestamp: 0 }],
        }),
        q,
      ),
    ).toBe(true);
  });

  test("search matches exception name or message", () => {
    const q = parseQuery(new URLSearchParams({ search: "TypeError" }), NOW);
    expect(
      matchesQuery(
        entry({
          exceptions: [{ name: "TypeError", message: "x", timestamp: 0 }],
        }),
        q,
      ),
    ).toBe(true);
  });

  test("search matches request URL", () => {
    const q = parseQuery(new URLSearchParams({ search: "/api/checkout" }), NOW);
    expect(
      matchesQuery(
        entry({ request: { url: "/api/checkout/123", method: "POST" } }),
        q,
      ),
    ).toBe(true);
  });

  test("search miss → false", () => {
    const q = parseQuery(new URLSearchParams({ search: "needle" }), NOW);
    expect(matchesQuery(entry(), q)).toBe(false);
  });
});
