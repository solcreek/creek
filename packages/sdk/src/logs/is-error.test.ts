/**
 * The predicate `creek metrics` counts with and `creek logs --errors`
 * filters by. These MUST agree — a tenant reported seeing "40 errors" in
 * metrics and getting an empty list from logs (2026-07-30).
 *
 * The table below is the contract. tail-worker/src/analytics.ts holds a
 * mirror of this function (it has no dependencies and cannot import the
 * SDK); its own test drives the same cases, so a divergence shows up as
 * a failure on whichever side was edited.
 */

import { describe, it, expect } from "vitest";
import { isError, type ErrorClassifiable } from "./is-error";

function entry(over: Partial<ErrorClassifiable> = {}): ErrorClassifiable {
  return { outcome: "ok", exceptions: [], ...over };
}

const EXCEPTION = { name: "Error", message: "Network connection lost.", timestamp: 0 };

describe("isError", () => {
  it("a clean ok request is not an error", () => {
    expect(isError(entry({ request: { status: 200 } }))).toBe(false);
  });

  it("any non-ok outcome is an error", () => {
    for (const outcome of [
      "exception",
      "exceededCpu",
      "exceededMemory",
      "canceled",
      "responseStreamDisconnected",
      "scriptNotFound",
      "unknown",
    ] as const) {
      expect(isError(entry({ outcome }))).toBe(true);
    }
  });

  it('an "ok" invocation that recorded an exception IS an error', () => {
    // The exact shape the tenant's failing requests had, and the one
    // `--outcome exception` could never match. An exception thrown after
    // the response started streaming leaves outcome "ok".
    expect(isError(entry({ outcome: "ok", exceptions: [EXCEPTION] }))).toBe(true);
  });

  it('an "ok" invocation that returned 5xx IS an error', () => {
    expect(isError(entry({ outcome: "ok", request: { status: 503 } }))).toBe(true);
  });

  it("4xx is not an error — that is the client's fault, not the worker's", () => {
    expect(isError(entry({ request: { status: 404 } }))).toBe(false);
  });

  it("a missing status is not treated as 5xx", () => {
    // The tenant's `/dashboard` entry had no status code at all. Reading
    // `undefined >= 500` as true would be wrong for a different reason.
    expect(isError(entry({ outcome: "ok", request: {} }))).toBe(false);
  });
});
