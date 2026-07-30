/**
 * Sink failures must be visible, and must not cost us the durable write.
 *
 * Two defects in the same block, both found on 2026-07-30 while verifying
 * a creek-tail deploy:
 *
 *   1. `Promise.allSettled`'s results were discarded, so a rejected R2 /
 *      realtime write left no trace at all — outcome "ok", no logs. A
 *      live tail showed 106 invocations, every one "ok", with no way to
 *      tell whether a single object had landed.
 *
 *   2. `writeBatchToAnalytics` is SYNCHRONOUS and ran unguarded before
 *      the awaited writes. A throw from Analytics Engine therefore
 *      aborted the handler before R2 was touched — trading a metrics
 *      blip for permanent log loss.
 *
 * The handler stays best-effort throughout: a dead sink is logged, never
 * rethrown, because a tail handler that fails helps nobody.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import handler from "./index.js";
import type { TailEvent } from "./types.js";

const TEAMS = [{ slug: "acme", plan: "pro" }];

let r2Puts: string[];
let aePoints: number;
let errorLogs: string[];
let warnLogs: string[];

interface EnvOptions {
  /** Reject R2 puts whose key starts with this prefix. */
  failR2Prefix?: string;
  failRealtime?: boolean;
  failAnalytics?: boolean;
}

function makeEnv(opts: EnvOptions = {}) {
  r2Puts = [];
  aePoints = 0;
  return {
    DB: {
      prepare() {
        return { all: () => Promise.resolve({ results: TEAMS }) };
      },
    } as unknown as D1Database,
    LOGS_BUCKET: {
      put(key: string) {
        if (opts.failR2Prefix && key.startsWith(opts.failR2Prefix)) {
          return Promise.reject(new Error("R2 unavailable"));
        }
        r2Puts.push(key);
        return Promise.resolve(null);
      },
    } as unknown as R2Bucket,
    ANALYTICS: {
      writeDataPoint() {
        if (opts.failAnalytics) throw new Error("AE quota exceeded");
        aePoints++;
      },
    } as unknown as AnalyticsEngineDataset,
    CREEK_DOMAIN: "bycreek.com",
    REALTIME_URL: "https://realtime.example.com",
    REALTIME_MASTER_KEY: "test-master-key",
  };
}

function tenantEvent(): TailEvent {
  return {
    scriptName: "my-blog-acme",
    outcome: "ok",
    eventTimestamp: Date.UTC(2026, 6, 30, 14, 0, 0),
    event: {
      request: { url: "https://my-blog-acme.bycreek.com/", method: "GET", headers: {} },
      response: { status: 200 },
    },
    logs: [],
    exceptions: [],
  };
}

function erroringPlatformEvent(): TailEvent {
  return {
    scriptName: "creek-dispatch",
    outcome: "exception",
    eventTimestamp: Date.UTC(2026, 6, 30, 14, 0, 0),
    event: {
      request: { url: "https://my-blog-acme.bycreek.com/", method: "GET", headers: {} },
    },
    logs: [],
    exceptions: [{ name: "Error", message: "Network connection lost.", timestamp: 0 }],
  };
}

let realtimeShouldFail = false;

beforeEach(() => {
  errorLogs = [];
  warnLogs = [];
  realtimeShouldFail = false;
  vi.stubGlobal("fetch", () =>
    realtimeShouldFail
      ? Promise.reject(new Error("realtime unreachable"))
      : Promise.resolve(new Response("", { status: 200 })),
  );
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errorLogs.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnLogs.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a failing sink is reported, not swallowed", () => {
  test("R2 rejection is logged and named", async () => {
    const env = makeEnv({ failR2Prefix: "logs/" });
    await handler.tail([tenantEvent()], env);

    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0]).toContain("r2 sink failed");
    expect(errorLogs[0]).toContain("R2 unavailable");
  });

  test("platform-logs rejection is reported under its own sink name", async () => {
    // Distinguishable from the tenant R2 sink so an operator can tell
    // which write path is broken.
    const env = makeEnv({ failR2Prefix: "platform-logs/" });
    await handler.tail([erroringPlatformEvent()], env);

    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0]).toContain("platform-r2 sink failed");
  });

  test("realtime failures were already self-reported by the realtime module", async () => {
    // `pushBatchToRealtime` swallows its own rejections and warns, so it
    // never reaches `reportSinkFailures`. That sink was never silent —
    // it stays in SINKS only as a backstop for a throw raised before the
    // module's internal allSettled. Asserted so a future refactor that
    // removes the module's own logging doesn't quietly reintroduce a
    // blind spot.
    realtimeShouldFail = true;
    const env = makeEnv();
    await handler.tail([tenantEvent()], env);

    expect(warnLogs.some((l) => l.includes("[tail/realtime] push failed"))).toBe(true);
    expect(errorLogs).toEqual([]);
  });

  test("a broken realtime sink does not stop the R2 write", async () => {
    realtimeShouldFail = true;
    const env = makeEnv();
    await handler.tail([tenantEvent()], env);

    expect(r2Puts).toHaveLength(1);
  });

  test("R2 and realtime failing together are each surfaced", async () => {
    realtimeShouldFail = true;
    const env = makeEnv({ failR2Prefix: "logs/" });
    await handler.tail([tenantEvent()], env);

    expect(errorLogs.some((l) => l.includes("r2 sink failed"))).toBe(true);
    expect(warnLogs.some((l) => l.includes("[tail/realtime] push failed"))).toBe(true);
  });

  test("a healthy batch logs nothing", async () => {
    const env = makeEnv();
    await handler.tail([tenantEvent()], env);

    expect(errorLogs).toEqual([]);
    expect(r2Puts).toHaveLength(1);
  });

  test("a failing sink never fails the handler", async () => {
    // A tail handler that throws helps nobody — the producer Worker
    // can't act on it and the batch is lost either way.
    realtimeShouldFail = true;
    const env = makeEnv({ failR2Prefix: "logs/" });
    await expect(handler.tail([tenantEvent()], env)).resolves.toBeUndefined();
  });
});

describe("Analytics Engine cannot take down the durable write", () => {
  test("a synchronous AE throw still leaves the R2 object written", async () => {
    // The actual data-loss bug: writeDataPoint is synchronous and ran
    // unguarded *before* the awaited R2 write, so an AE failure discarded
    // the batch entirely.
    const env = makeEnv({ failAnalytics: true });
    await handler.tail([tenantEvent()], env);

    expect(r2Puts).toHaveLength(1);
    expect(r2Puts[0]).toMatch(/^logs\/acme\/my-blog\//);
  });

  test("the AE failure itself is reported", async () => {
    const env = makeEnv({ failAnalytics: true });
    await handler.tail([tenantEvent()], env);

    expect(errorLogs.some((l) => l.includes("analytics sink failed"))).toBe(true);
    expect(errorLogs.some((l) => l.includes("AE quota exceeded"))).toBe(true);
  });

  test("AE still receives healthy batches", async () => {
    const env = makeEnv();
    await handler.tail([tenantEvent(), tenantEvent()], env);

    expect(aePoints).toBe(2);
    expect(errorLogs).toEqual([]);
  });
});
