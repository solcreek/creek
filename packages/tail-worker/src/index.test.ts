/**
 * Integration tests for the tail() handler.
 *
 * Mock D1 (returns a fixed team list) and R2 (collects writes), then
 * pass synthetic TailEvent batches and assert what got persisted.
 *
 * Coverage targets the seams that production traffic actually hits:
 *   - non-tenant scripts (dispatch-worker, control-plane) are dropped
 *   - tenant scripts are tagged correctly across (production / branch
 *     / deployment) variants
 *   - mixed batches with both tenants and non-tenants partial-write
 *   - exception capture flows through to the LogEntry
 *   - team list is cached across calls (no second D1 hit)
 */

import { describe, test, expect, beforeEach } from "vitest";
import handler from "./index.js";
import type { TailEvent } from "./types.js";

let r2Puts: Array<{ key: string; body: string }>;
let dbQueryCount: number;

const TEAMS = [
  { slug: "acme-corp", plan: "pro" },
  { slug: "acme", plan: "pro" },
  { slug: "bob", plan: "free" },
];

function makeEnv() {
  r2Puts = [];
  dbQueryCount = 0;
  return {
    DB: {
      prepare(_sql: string) {
        return {
          all() {
            dbQueryCount++;
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
    CREEK_DOMAIN: "bycreek.com",
  };
}

function makeTailEvent(overrides: Partial<TailEvent> = {}): TailEvent {
  return {
    scriptName: "my-blog-acme",
    outcome: "ok",
    eventTimestamp: Date.UTC(2026, 3, 13, 14, 0, 0),
    event: {
      request: {
        url: "https://my-blog-acme.bycreek.com/",
        method: "GET",
        headers: {},
      },
      response: { status: 200 },
    },
    logs: [],
    exceptions: [],
    ...overrides,
  };
}

describe("creek-tail handler", () => {
  let env: ReturnType<typeof makeEnv>;

  beforeEach(() => {
    env = makeEnv();
  });

  test("empty batch → no R2 writes, no DB query", async () => {
    await handler.tail([], env);
    expect(r2Puts).toEqual([]);
    expect(dbQueryCount).toBe(0);
  });

  test("non-tenant script dropped — dispatch-worker traces are not persisted", async () => {
    await handler.tail([makeTailEvent({ scriptName: "creek-dispatch" })], env);
    expect(r2Puts).toEqual([]);
  });

  test("production tenant trace persisted with correct tagging", async () => {
    await handler.tail([makeTailEvent({ scriptName: "my-blog-acme" })], env);
    expect(r2Puts).toHaveLength(1);
    const entry = JSON.parse(r2Puts[0].body.trim());
    expect(entry).toMatchObject({
      v: 1,
      team: "acme",
      project: "my-blog",
      scriptType: "production",
      outcome: "ok",
      request: { url: "https://my-blog-acme.bycreek.com/", method: "GET", status: 200 },
    });
    expect(entry.branch).toBeUndefined();
    expect(entry.deployId).toBeUndefined();
  });

  test("branch preview trace tagged with branch name", async () => {
    await handler.tail(
      [
        makeTailEvent({
          scriptName: "checkout-git-feature-x-acme-corp",
        }),
      ],
      env,
    );
    expect(r2Puts).toHaveLength(1);
    const entry = JSON.parse(r2Puts[0].body.trim());
    expect(entry).toMatchObject({
      team: "acme-corp",
      project: "checkout",
      scriptType: "branch",
      branch: "feature-x",
    });
  });

  test("deployment preview trace tagged with deployId", async () => {
    await handler.tail(
      [
        makeTailEvent({
          scriptName: "vite-react-drizzle-13452d26-acme",
        }),
      ],
      env,
    );
    expect(r2Puts).toHaveLength(1);
    const entry = JSON.parse(r2Puts[0].body.trim());
    expect(entry).toMatchObject({
      team: "acme",
      project: "vite-react-drizzle",
      scriptType: "deployment",
      deployId: "13452d26",
    });
  });

  test("mixed batch — tenants persisted, non-tenants dropped", async () => {
    await handler.tail(
      [
        makeTailEvent({ scriptName: "my-blog-acme" }),
        makeTailEvent({ scriptName: "creek-dispatch" }),
        makeTailEvent({ scriptName: "shop-bob" }),
        makeTailEvent({ scriptName: "creek-control-plane" }),
      ],
      env,
    );
    // Two tenant entries → split across (acme, blog) and (bob, shop)
    expect(r2Puts).toHaveLength(2);
    const teams = r2Puts
      .map((p) => JSON.parse(p.body.trim()).team)
      .sort();
    expect(teams).toEqual(["acme", "bob"]);
  });

  test("exceptions and console logs flow through to the LogEntry", async () => {
    await handler.tail(
      [
        makeTailEvent({
          outcome: "exception",
          logs: [
            { level: "log", message: ["hello"], timestamp: 1700000000000 },
            { level: "error", message: ["oops"], timestamp: 1700000001000 },
          ],
          exceptions: [
            { name: "TypeError", message: "x is not a function", timestamp: 1700000001500 },
          ],
        }),
      ],
      env,
    );
    const entry = JSON.parse(r2Puts[0].body.trim());
    expect(entry.outcome).toBe("exception");
    expect(entry.logs).toHaveLength(2);
    expect(entry.logs[1].level).toBe("error");
    expect(entry.exceptions).toHaveLength(1);
    expect(entry.exceptions[0].name).toBe("TypeError");
  });

  test("fetch event with no response (e.g. canceled) — request kept, status omitted", async () => {
    await handler.tail(
      [
        makeTailEvent({
          outcome: "canceled",
          event: {
            request: { url: "https://x.bycreek.com/", method: "POST", headers: {} },
          },
        }),
      ],
      env,
    );
    const entry = JSON.parse(r2Puts[0].body.trim());
    expect(entry.request).toEqual({
      url: "https://x.bycreek.com/",
      method: "POST",
    });
    expect(entry.outcome).toBe("canceled");
  });

  test("non-fetch event (event === null, e.g. scheduled) — no request field", async () => {
    await handler.tail([makeTailEvent({ event: null })], env);
    const entry = JSON.parse(r2Puts[0].body.trim());
    expect(entry.request).toBeUndefined();
  });

  test("team list cached — second batch within TTL doesn't re-query D1", async () => {
    await handler.tail([makeTailEvent()], env);
    const queriesAfterFirst = dbQueryCount;
    await handler.tail([makeTailEvent()], env);
    expect(dbQueryCount).toBe(queriesAfterFirst);
  });
});
