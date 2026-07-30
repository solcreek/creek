/**
 * Retention of erroring platform (non-tenant) traces.
 *
 * Background (reported 2026-07-30): a tenant hit a full-page Cloudflare
 * Error 1101 and gave us the Ray ID. There was no matching entry anywhere
 * in `creek logs` — the invocation that threw belonged to creek-dispatch,
 * and this Worker dropped every platform-script trace before it reached
 * R2. We were blind to our own outages.
 *
 * The invariants locked in here:
 *   - healthy platform traffic is STILL dropped (dispatch sees every
 *     request on the platform; retaining it would bury tenant logs)
 *   - a platform trace that threw is retained
 *   - retained traces land under a prefix the tenant logs API cannot
 *     address — they carry tenant hostnames in their request URLs
 *   - they never reach Analytics Engine or the realtime fan-out, both of
 *     which are keyed on a tenant tuple platform traces do not have
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import handler from "./index.js";
import type { TailEvent } from "./types.js";

let r2Puts: Array<{ key: string; body: string }>;
let aePoints: unknown[];
let realtimePosts: Array<{ url: string; body: string }>;

const TEAMS = [
  { slug: "acme", plan: "pro" },
  { slug: "eli-chen-f443", plan: "free" },
];

beforeEach(() => {
  realtimePosts = [];
  vi.stubGlobal("fetch", (input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    realtimePosts.push({ url, body: typeof init?.body === "string" ? init.body : "" });
    return Promise.resolve(new Response("", { status: 200 }));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeEnv() {
  r2Puts = [];
  aePoints = [];
  return {
    DB: {
      prepare() {
        return {
          all() {
            return Promise.resolve({ results: TEAMS });
          },
        };
      },
    } as unknown as D1Database,
    LOGS_BUCKET: {
      put(key: string, body: string) {
        r2Puts.push({ key, body });
        return Promise.resolve(null);
      },
    } as unknown as R2Bucket,
    ANALYTICS: {
      writeDataPoint(dp: unknown) {
        aePoints.push(dp);
      },
    } as unknown as AnalyticsEngineDataset,
    CREEK_DOMAIN: "bycreek.com",
    REALTIME_URL: "https://realtime.example.com",
    REALTIME_MASTER_KEY: "test-master-key",
  };
}

/** The trace shape that produced the reported 1101. */
function dispatchEvent(overrides: Partial<TailEvent> = {}): TailEvent {
  return {
    scriptName: "creek-dispatch",
    outcome: "exception",
    eventTimestamp: Date.UTC(2026, 6, 30, 3, 51, 14),
    event: {
      request: {
        url: "https://nii-course-system-eli-chen-f443.bycreek.com/dashboard",
        method: "GET",
        headers: {},
      },
    },
    logs: [],
    exceptions: [
      {
        name: "Error",
        message: "Network connection lost.",
        timestamp: Date.UTC(2026, 6, 30, 3, 51, 14),
      },
    ],
    ...overrides,
  };
}

function tenantEvent(): TailEvent {
  return {
    scriptName: "my-blog-acme",
    outcome: "ok",
    eventTimestamp: Date.UTC(2026, 6, 30, 3, 51, 14),
    event: {
      request: { url: "https://my-blog-acme.bycreek.com/", method: "GET", headers: {} },
      response: { status: 200 },
    },
    logs: [],
    exceptions: [],
  };
}

const platformPuts = () => r2Puts.filter((p) => p.key.startsWith("platform-logs/"));

describe("healthy platform traffic is still dropped", () => {
  test("dispatch trace with outcome ok and no exception → nothing written", async () => {
    const env = makeEnv();
    await handler.tail([dispatchEvent({ outcome: "ok", exceptions: [] })], env);
    expect(r2Puts).toEqual([]);
  });

  test("canceled dispatch trace → dropped (browser-aborted RSC prefetches)", async () => {
    // These are constant background noise on any Next.js tenant and carry
    // no exception. Retaining them would reintroduce the volume problem
    // that made dropping platform traces the default.
    const env = makeEnv();
    await handler.tail([dispatchEvent({ outcome: "canceled", exceptions: [] })], env);
    expect(r2Puts).toEqual([]);
  });

  test("control-plane trace with outcome ok → dropped", async () => {
    const env = makeEnv();
    await handler.tail(
      [dispatchEvent({ scriptName: "creek-control-plane", outcome: "ok", exceptions: [] })],
      env,
    );
    expect(r2Puts).toEqual([]);
  });
});

describe("erroring platform traces are retained", () => {
  test("the reported 1101 shape is persisted with its exception", async () => {
    const env = makeEnv();
    await handler.tail([dispatchEvent()], env);

    expect(platformPuts()).toHaveLength(1);
    const entry = JSON.parse(platformPuts()[0].body.trim());
    expect(entry).toMatchObject({
      v: 1,
      script: "creek-dispatch",
      outcome: "exception",
      request: {
        url: "https://nii-course-system-eli-chen-f443.bycreek.com/dashboard",
        method: "GET",
      },
      exceptions: [{ name: "Error", message: "Network connection lost." }],
    });
  });

  test("an exception recorded on an otherwise-ok invocation is retained", async () => {
    // The tenant's own traces showed exactly this: outcome "ok", no status
    // code, and a Network-connection-lost exception. Outcome alone is not a
    // sufficient signal.
    const env = makeEnv();
    await handler.tail([dispatchEvent({ outcome: "ok" })], env);
    expect(platformPuts()).toHaveLength(1);
    expect(JSON.parse(platformPuts()[0].body.trim()).outcome).toBe("ok");
  });

  test("outcome exception with an empty exceptions array is retained", async () => {
    const env = makeEnv();
    await handler.tail([dispatchEvent({ outcome: "exception", exceptions: [] })], env);
    expect(platformPuts()).toHaveLength(1);
  });

  test("a batch containing ONLY an erroring platform trace still writes", async () => {
    // Regression guard: the handler used to bail on `entries.length === 0`,
    // which would discard a platform-only batch — i.e. exactly the batch a
    // dispatch-layer outage produces.
    const env = makeEnv();
    await handler.tail([dispatchEvent()], env);
    expect(platformPuts()).toHaveLength(1);
  });

  test("key is partitioned by script, date and hour", async () => {
    const env = makeEnv();
    await handler.tail([dispatchEvent()], env);
    expect(platformPuts()[0].key).toMatch(
      /^platform-logs\/creek-dispatch\/2026-07-30\/03-[0-9a-f]{12}\.ndjson$/,
    );
  });

  test("a hostile script name collapses to a single key segment", async () => {
    // R2 keys are flat strings, so `..` is inert — what would actually be
    // dangerous is a script name smuggling in `/` and steering the object
    // under the tenant-readable `logs/` prefix. Separators must not survive.
    const env = makeEnv();
    await handler.tail([dispatchEvent({ scriptName: "../../logs/acme/my-blog" })], env);

    const key = r2Puts[0].key;
    expect(key.startsWith("platform-logs/")).toBe(true);
    // platform-logs / <script> / <date> / <file> — exactly four segments,
    // however many slashes the script name tried to contribute.
    expect(key.split("/")).toHaveLength(4);
    expect(key.split("/")[1]).toBe(".._.._logs_acme_my-blog");
  });
});

describe("platform traces stay out of tenant-facing surfaces", () => {
  test("never written under the logs/ prefix the tenant API reads", async () => {
    // The logs API derives its prefix as logs/{team}/{project}/ from the
    // authenticated team. A platform trace landing there would expose one
    // tenant's hostnames to whoever owns that prefix.
    const env = makeEnv();
    await handler.tail([dispatchEvent()], env);
    expect(r2Puts.every((p) => !p.key.startsWith("logs/"))).toBe(true);
  });

  test("not counted in Analytics Engine", async () => {
    const env = makeEnv();
    await handler.tail([dispatchEvent()], env);
    expect(aePoints).toEqual([]);
  });

  test("not pushed to the realtime fan-out", async () => {
    const env = makeEnv();
    await handler.tail([dispatchEvent()], env);
    expect(realtimePosts).toEqual([]);
  });
});

describe("mixed batches", () => {
  test("tenant and platform traces are written to their own prefixes", async () => {
    const env = makeEnv();
    await handler.tail([tenantEvent(), dispatchEvent(), tenantEvent()], env);

    const tenant = r2Puts.filter((p) => p.key.startsWith("logs/"));
    expect(tenant).toHaveLength(1);
    expect(tenant[0].key).toMatch(/^logs\/acme\/my-blog\//);
    expect(tenant[0].body.trim().split("\n")).toHaveLength(2);

    expect(platformPuts()).toHaveLength(1);
    expect(JSON.parse(platformPuts()[0].body.trim()).script).toBe("creek-dispatch");
  });

  test("tenant metrics and realtime are unaffected by a platform trace in the batch", async () => {
    const env = makeEnv();
    await handler.tail([tenantEvent(), dispatchEvent()], env);
    expect(aePoints).toHaveLength(1); // the tenant entry only
    expect(realtimePosts).toHaveLength(1);
  });
});
