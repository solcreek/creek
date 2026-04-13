/**
 * R2 writer tests — mock R2Bucket and assert the key shape, body
 * format, and grouping behavior. The key shape is the contract for
 * the future log query reader; if it changes, the reader breaks.
 */

import { describe, test, expect, beforeEach } from "vitest";
import { writeBatchToR2 } from "./r2-writer.js";
import type { LogEntry } from "./types.js";

interface PutCall {
  key: string;
  body: string;
  contentType?: string;
}

let puts: PutCall[];
const mockBucket = {
  put(key: string, body: string, opts?: R2PutOptions) {
    puts.push({
      key,
      body,
      contentType: opts?.httpMetadata
        ? (opts.httpMetadata as { contentType?: string }).contentType
        : undefined,
    });
    return Promise.resolve(null);
  },
} as unknown as R2Bucket;

beforeEach(() => {
  puts = [];
});

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    v: 1,
    timestamp: Date.UTC(2026, 3, 13, 14, 30, 0), // 2026-04-13T14:30Z
    team: "acme",
    project: "my-blog",
    scriptType: "production",
    outcome: "ok",
    logs: [],
    exceptions: [],
    ...overrides,
  };
}

describe("writeBatchToR2", () => {
  test("no entries → no R2 call", async () => {
    await writeBatchToR2({ LOGS_BUCKET: mockBucket }, []);
    expect(puts).toEqual([]);
  });

  test("single entry → one R2 object with correct key shape", async () => {
    await writeBatchToR2({ LOGS_BUCKET: mockBucket }, [entry()]);
    expect(puts).toHaveLength(1);
    expect(puts[0].key).toMatch(
      /^logs\/acme\/my-blog\/2026-04-13\/14-production-[0-9a-f]{12}\.ndjson$/,
    );
    expect(puts[0].contentType).toBe("application/x-ndjson");
  });

  test("body is ndjson — one JSON object per line, terminated with newline", async () => {
    await writeBatchToR2({ LOGS_BUCKET: mockBucket }, [
      entry({ timestamp: 1700000000000 }),
      entry({ timestamp: 1700000001000 }),
    ]);
    expect(puts).toHaveLength(1);
    const lines = puts[0].body.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).timestamp).toBe(1700000000000);
    expect(JSON.parse(lines[1]).timestamp).toBe(1700000001000);
    expect(puts[0].body.endsWith("\n")).toBe(true);
  });

  test("entries split across (team, project, hour, scriptType) → separate R2 objects", async () => {
    const t = Date.UTC(2026, 3, 13, 14, 0, 0);
    await writeBatchToR2({ LOGS_BUCKET: mockBucket }, [
      entry({ team: "acme", project: "blog", timestamp: t }),
      entry({ team: "acme", project: "blog", timestamp: t + 1000 }), // same group
      entry({ team: "acme", project: "shop", timestamp: t }), // different project
      entry({ team: "bob", project: "blog", timestamp: t }), // different team
      entry({
        team: "acme",
        project: "blog",
        scriptType: "branch",
        branch: "feat",
        timestamp: t,
      }), // different scriptType
      entry({
        team: "acme",
        project: "blog",
        timestamp: Date.UTC(2026, 3, 13, 15, 0, 0),
      }), // different hour
    ]);
    expect(puts).toHaveLength(5);

    const keys = puts.map((p) => p.key.replace(/-[0-9a-f]{12}\.ndjson$/, ""));
    expect(keys.sort()).toEqual([
      "logs/acme/blog/2026-04-13/14-branch",
      "logs/acme/blog/2026-04-13/14-production",
      "logs/acme/blog/2026-04-13/15-production",
      "logs/acme/shop/2026-04-13/14-production",
      "logs/bob/blog/2026-04-13/14-production",
    ]);
  });

  test("date components are zero-padded (single-digit month / day / hour)", async () => {
    await writeBatchToR2({ LOGS_BUCKET: mockBucket }, [
      entry({ timestamp: Date.UTC(2026, 0, 5, 7, 0, 0) }), // Jan 5, 07:00 UTC
    ]);
    expect(puts[0].key).toMatch(/2026-01-05\/07-/);
  });

  test("UTC, not local time", async () => {
    // 2026-04-13T23:59:59.999Z is still 2026-04-13 hour 23 in UTC
    await writeBatchToR2({ LOGS_BUCKET: mockBucket }, [
      entry({ timestamp: Date.UTC(2026, 3, 13, 23, 59, 59, 999) }),
    ]);
    expect(puts[0].key).toMatch(/2026-04-13\/23-/);
  });
});
