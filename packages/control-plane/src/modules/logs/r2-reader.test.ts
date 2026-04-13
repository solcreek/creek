/**
 * R2 reader tests — mock R2Bucket with a key/value map and assert
 * the reader picks the right prefixes, applies the filter, honours
 * the limit, and reports truncation correctly.
 */

import { describe, test, expect } from "vitest";
import { hourPrefixes, readLogs } from "./r2-reader.js";
import { parseQuery } from "./query.js";
import type { LogEntry } from "./types.js";

const NOW = Date.UTC(2026, 3, 13, 18, 0, 0);

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    v: 1,
    timestamp: NOW - 60_000,
    team: "acme",
    project: "blog",
    scriptType: "production",
    outcome: "ok",
    request: { url: "/api/x", method: "GET", status: 200 },
    logs: [],
    exceptions: [],
    ...overrides,
  };
}

function makeBucket(initial: Record<string, LogEntry[]>): R2Bucket {
  const store = new Map<string, string>();
  for (const [key, entries] of Object.entries(initial)) {
    store.set(key, entries.map((e) => JSON.stringify(e)).join("\n"));
  }
  return {
    async list(opts?: R2ListOptions) {
      const prefix = opts?.prefix ?? "";
      const matched = [...store.keys()].filter((k) => k.startsWith(prefix));
      return {
        objects: matched.map((key) => ({ key, size: 0, uploaded: new Date() })),
        truncated: false,
      } as unknown as R2Objects;
    },
    async get(key: string) {
      const body = store.get(key);
      if (body === undefined) return null;
      return { text: () => Promise.resolve(body) } as R2ObjectBody;
    },
  } as unknown as R2Bucket;
}

describe("hourPrefixes", () => {
  test("single hour window → one prefix", () => {
    const start = Date.UTC(2026, 3, 13, 17, 0, 0);
    const end = Date.UTC(2026, 3, 13, 17, 59, 0);
    expect(hourPrefixes("acme", "blog", start, end)).toEqual([
      "logs/acme/blog/2026-04-13/17-",
    ]);
  });

  test("range spanning 3 hours → 3 prefixes", () => {
    const start = Date.UTC(2026, 3, 13, 16, 30, 0);
    const end = Date.UTC(2026, 3, 13, 18, 30, 0);
    const prefixes = hourPrefixes("acme", "blog", start, end);
    expect(prefixes).toEqual([
      "logs/acme/blog/2026-04-13/16-",
      "logs/acme/blog/2026-04-13/17-",
      "logs/acme/blog/2026-04-13/18-",
    ]);
  });

  test("range crossing day boundary → multi-day prefixes", () => {
    const start = Date.UTC(2026, 3, 13, 23, 0, 0);
    const end = Date.UTC(2026, 3, 14, 1, 0, 0);
    const prefixes = hourPrefixes("acme", "blog", start, end);
    expect(prefixes).toEqual([
      "logs/acme/blog/2026-04-13/23-",
      "logs/acme/blog/2026-04-14/00-",
    ]);
  });

  test("zero-padded month/day/hour", () => {
    const start = Date.UTC(2026, 0, 5, 7, 0, 0);
    expect(hourPrefixes("a", "p", start, start + 1)).toEqual([
      "logs/a/p/2026-01-05/07-",
    ]);
  });
});

describe("readLogs", () => {
  test("reads matching entries from R2", async () => {
    const bucket = makeBucket({
      "logs/acme/blog/2026-04-13/17-production-aaa.ndjson": [
        entry({ timestamp: NOW - 30 * 60_000 }),
        entry({ timestamp: NOW - 25 * 60_000, outcome: "exception" }),
      ],
    });
    const query = parseQuery(new URLSearchParams({ since: "1h" }), NOW);
    const result = await readLogs({ bucket, team: "acme", project: "blog", query });
    expect(result.entries).toHaveLength(2);
    expect(result.truncated).toBe(false);
  });

  test("filter narrows results: outcome=exception only", async () => {
    const bucket = makeBucket({
      "logs/acme/blog/2026-04-13/17-production-aaa.ndjson": [
        entry({ timestamp: NOW - 30 * 60_000, outcome: "ok" }),
        entry({ timestamp: NOW - 25 * 60_000, outcome: "exception" }),
        entry({ timestamp: NOW - 20 * 60_000, outcome: "ok" }),
      ],
    });
    const query = parseQuery(
      new URLSearchParams({ since: "1h", outcome: "exception" }),
      NOW,
    );
    const result = await readLogs({ bucket, team: "acme", project: "blog", query });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].outcome).toBe("exception");
  });

  test("limit caps results, truncated=true when more available", async () => {
    const bucket = makeBucket({
      "logs/acme/blog/2026-04-13/17-production-aaa.ndjson": Array.from(
        { length: 10 },
        (_, i) => entry({ timestamp: NOW - (i + 1) * 60_000 }),
      ),
    });
    const query = parseQuery(
      new URLSearchParams({ since: "1h", limit: "3" }),
      NOW,
    );
    const result = await readLogs({ bucket, team: "acme", project: "blog", query });
    expect(result.entries).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  test("walks newest hour first — most recent entries returned when truncated", async () => {
    const bucket = makeBucket({
      "logs/acme/blog/2026-04-13/16-production-aaa.ndjson": [
        entry({ timestamp: Date.UTC(2026, 3, 13, 16, 30, 0) }),
      ],
      "logs/acme/blog/2026-04-13/17-production-bbb.ndjson": [
        entry({ timestamp: Date.UTC(2026, 3, 13, 17, 30, 0) }),
      ],
    });
    const query = parseQuery(
      new URLSearchParams({ since: "3h", limit: "1" }),
      NOW,
    );
    const result = await readLogs({ bucket, team: "acme", project: "blog", query });
    expect(result.entries).toHaveLength(1);
    // Newest (17:30) wins, not 16:30
    expect(result.entries[0].timestamp).toBe(Date.UTC(2026, 3, 13, 17, 30, 0));
  });

  test("empty bucket → empty result, no error", async () => {
    const bucket = makeBucket({});
    const query = parseQuery(new URLSearchParams(), NOW);
    const result = await readLogs({ bucket, team: "acme", project: "blog", query });
    expect(result.entries).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  test("malformed ndjson lines are skipped, not crashed", async () => {
    const bucket = {
      async list() {
        return {
          objects: [{ key: "logs/acme/blog/2026-04-13/17-production-x.ndjson" }],
          truncated: false,
        } as unknown as R2Objects;
      },
      async get() {
        return {
          text: () =>
            Promise.resolve(
              [
                "{not json",
                JSON.stringify(entry()),
                "",
                "another bad line",
              ].join("\n"),
            ),
        } as R2ObjectBody;
      },
    } as unknown as R2Bucket;
    const query = parseQuery(new URLSearchParams(), NOW);
    const result = await readLogs({ bucket, team: "acme", project: "blog", query });
    expect(result.entries).toHaveLength(1);
  });

  test("tenant prefix is enforced — bucket keys outside logs/{team}/{project}/ ignored", async () => {
    const bucket = makeBucket({
      "logs/other-team/blog/2026-04-13/17-production-x.ndjson": [
        entry({ team: "other-team" }),
      ],
      "logs/acme/blog/2026-04-13/17-production-y.ndjson": [entry()],
    });
    const query = parseQuery(new URLSearchParams(), NOW);
    const result = await readLogs({ bucket, team: "acme", project: "blog", query });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].team).toBe("acme");
  });
});
