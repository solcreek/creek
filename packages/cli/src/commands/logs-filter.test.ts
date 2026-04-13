/**
 * matchesClientSide tests — the live-tail filter that must mirror
 * control-plane's matchesQuery server-side. If these drift, --follow
 * shows different entries than --since for the same flags.
 *
 * Coverage matches the control-plane filter test rows
 * (control-plane/src/modules/logs/query.test.ts > matchesQuery).
 */

import { describe, test, expect } from "vitest";
import { matchesClientSide, describeFilters } from "./logs-filter.js";
import type { LogEntry, LogQueryFilters } from "@solcreek/sdk";

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    v: 1,
    timestamp: 1700000000000,
    team: "acme",
    project: "blog",
    scriptType: "production",
    outcome: "ok",
    request: { url: "https://x.com/api/x", method: "GET", status: 200 },
    logs: [],
    exceptions: [],
    ...overrides,
  };
}

describe("matchesClientSide", () => {
  test("no filters → match", () => {
    expect(matchesClientSide(entry(), {})).toBe(true);
  });

  test("outcome filter passes match", () => {
    expect(
      matchesClientSide(entry({ outcome: "exception" }), { outcomes: ["exception"] }),
    ).toBe(true);
  });

  test("outcome filter rejects non-match", () => {
    expect(
      matchesClientSide(entry({ outcome: "ok" }), { outcomes: ["exception"] }),
    ).toBe(false);
  });

  test("multiple outcomes — entry matches any in the set", () => {
    expect(
      matchesClientSide(entry({ outcome: "exceededCpu" }), {
        outcomes: ["exception", "exceededCpu"],
      }),
    ).toBe(true);
  });

  test("scriptType filter", () => {
    expect(
      matchesClientSide(entry({ scriptType: "branch", branch: "x" }), {
        scriptTypes: ["branch"],
      }),
    ).toBe(true);
    expect(
      matchesClientSide(entry({ scriptType: "production" }), {
        scriptTypes: ["branch"],
      }),
    ).toBe(false);
  });

  test("deployment filter scopes to that deploy", () => {
    expect(
      matchesClientSide(
        entry({ scriptType: "deployment", deployId: "a1b2c3d4" }),
        { deployment: "a1b2c3d4" },
      ),
    ).toBe(true);
    expect(matchesClientSide(entry(), { deployment: "a1b2c3d4" })).toBe(false);
  });

  test("branch filter scopes to that branch", () => {
    expect(
      matchesClientSide(entry({ scriptType: "branch", branch: "feat-x" }), {
        branch: "feat-x",
      }),
    ).toBe(true);
    expect(matchesClientSide(entry(), { branch: "feat-x" })).toBe(false);
  });

  test("level filter — entry needs at least one log line at one of the levels", () => {
    expect(
      matchesClientSide(
        entry({
          logs: [{ level: "error", message: ["x"], timestamp: 0 }],
        }),
        { levels: ["error"] },
      ),
    ).toBe(true);
    expect(
      matchesClientSide(
        entry({
          logs: [{ level: "log", message: ["x"], timestamp: 0 }],
        }),
        { levels: ["error"] },
      ),
    ).toBe(false);
    expect(matchesClientSide(entry(), { levels: ["error"] })).toBe(false);
  });

  test("search hits console message (case-insensitive)", () => {
    expect(
      matchesClientSide(
        entry({
          logs: [{ level: "log", message: ["TypeError oh no"], timestamp: 0 }],
        }),
        { search: "typeerror" },
      ),
    ).toBe(true);
  });

  test("search hits exception name and message", () => {
    expect(
      matchesClientSide(
        entry({
          exceptions: [{ name: "TypeError", message: "x is undefined", timestamp: 0 }],
        }),
        { search: "TypeError" },
      ),
    ).toBe(true);
    expect(
      matchesClientSide(
        entry({
          exceptions: [{ name: "Boom", message: "request to /checkout failed", timestamp: 0 }],
        }),
        { search: "checkout" },
      ),
    ).toBe(true);
  });

  test("search hits request URL", () => {
    expect(
      matchesClientSide(
        entry({ request: { url: "https://x.com/api/checkout", method: "POST" } }),
        { search: "checkout" },
      ),
    ).toBe(true);
  });

  test("search miss returns false", () => {
    expect(matchesClientSide(entry(), { search: "needle-not-found" })).toBe(false);
  });

  test("non-string console message is JSON-stringified for search", () => {
    expect(
      matchesClientSide(
        entry({
          logs: [{ level: "log", message: [{ orderId: 12345 }], timestamp: 0 }],
        }),
        { search: "12345" },
      ),
    ).toBe(true);
  });

  test("compound filters: ALL must match", () => {
    const e = entry({
      outcome: "exception",
      scriptType: "deployment",
      deployId: "a1b2c3d4",
      logs: [{ level: "error", message: ["fail"], timestamp: 0 }],
    });
    expect(
      matchesClientSide(e, {
        outcomes: ["exception"],
        scriptTypes: ["deployment"],
        deployment: "a1b2c3d4",
        levels: ["error"],
      }),
    ).toBe(true);
    expect(
      matchesClientSide(e, {
        outcomes: ["exception"],
        scriptTypes: ["deployment"],
        deployment: "deadbeef", // different deploy → reject
      }),
    ).toBe(false);
  });
});

describe("describeFilters", () => {
  test("empty filters → '(none)'", () => {
    expect(describeFilters({})).toBe("(none)");
  });

  test("renders all set filters", () => {
    expect(
      describeFilters({
        outcomes: ["exception"],
        scriptTypes: ["production"],
        deployment: "a1b2c3d4",
        branch: "main",
        levels: ["error"],
        search: "TypeError",
      }),
    ).toBe(
      'outcome=exception scriptType=production deployment=a1b2c3d4 branch=main level=error search="TypeError"',
    );
  });
});
