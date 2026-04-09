import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import {
  _runRequest,
  _setEnv,
  _setCtx,
  db,
  queue,
  notifyRealtime,
  generateWsToken,
} from "./index.js";
import type { CreekDatabase } from "./index.js";

// ── Mock fetch for broadcast ──

const originalFetch = globalThis.fetch;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn().mockResolvedValue(new Response("ok"));
  globalThis.fetch = fetchSpy;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  _setEnv(null as any);
});

// ── Helpers ──

function createMockD1() {
  const mockRun = vi.fn().mockResolvedValue({
    meta: { changes: 1, last_row_id: 1 },
  });
  const mockAll = vi.fn().mockResolvedValue({
    results: [{ id: "1" }],
    meta: {},
  });
  const mockStatement = {
    bind: vi.fn().mockReturnThis(),
    run: mockRun,
    all: mockAll,
    first: vi.fn(),
    raw: vi.fn(),
  };
  const mockDb = {
    prepare: vi.fn().mockReturnValue({
      ...mockStatement,
      bind: vi.fn().mockReturnValue(mockStatement),
    }),
    batch: vi.fn().mockResolvedValue([]),
    exec: vi.fn(),
    dump: vi.fn(),
  };
  return { mockDb, mockRun };
}

// ── _runRequest basic behavior ──

describe("_runRequest", () => {
  test("makes env available to db proxy", () => {
    const { mockDb } = createMockD1();

    _runRequest({ DB: mockDb }, null, () => {
      const stmt = db.prepare("SELECT 1");
      expect(stmt).toBeDefined();
      expect(mockDb.prepare).toHaveBeenCalledWith("SELECT 1");
    });
  });

  test("makes env available to notifyRealtime", async () => {
    await _runRequest(
      {
        CREEK_REALTIME_URL: "https://rt.example.com",
        CREEK_PROJECT_SLUG: "my-app",
      },
      null,
      async () => {
        notifyRealtime("todos", "INSERT");
        // fetch is fire-and-forget, give it a tick
        await new Promise((r) => setTimeout(r, 10));
      },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://rt.example.com/my-app/broadcast");
  });

  test("makes env available to generateWsToken", async () => {
    const token = await _runRequest(
      {
        CREEK_REALTIME_SECRET: "test-secret",
        CREEK_PROJECT_SLUG: "my-app",
      },
      null,
      () => generateWsToken(),
    );

    expect(token).not.toBeNull();
    expect(token).toMatch(/^\d+\.[a-f0-9]{64}$/);
  });

  test("makes ctx.waitUntil available for broadcast", async () => {
    const waitUntil = vi.fn();

    await _runRequest(
      {
        CREEK_REALTIME_URL: "https://rt.example.com",
        CREEK_PROJECT_SLUG: "test",
      },
      { waitUntil },
      () => {
        notifyRealtime("todos", "INSERT");
      },
    );

    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(waitUntil.mock.calls[0][0]).toBeInstanceOf(Promise);
  });

  test("returns the function's return value", () => {
    const result = _runRequest({}, null, () => 42);
    expect(result).toBe(42);
  });

  test("supports async functions", async () => {
    const result = await _runRequest({}, null, async () => {
      await new Promise((r) => setTimeout(r, 1));
      return "async-result";
    });
    expect(result).toBe("async-result");
  });
});

// ── Concurrent request isolation ──

describe("concurrent request isolation", () => {
  test("env is isolated between concurrent _runRequest calls", async () => {
    const dbA = createMockD1();
    const dbB = createMockD1();

    const results: string[] = [];

    const requestA = _runRequest(
      {
        DB: dbA.mockDb,
        CREEK_REALTIME_URL: "https://rt.example.com",
        CREEK_PROJECT_SLUG: "project-A",
      },
      null,
      async () => {
        // Simulate async work — yield control
        await new Promise((r) => setTimeout(r, 20));
        // After yielding, env should still be project-A
        notifyRealtime("todos", "INSERT");
        await new Promise((r) => setTimeout(r, 10));
        results.push("A");
      },
    );

    // Start request B while A is awaiting
    const requestB = _runRequest(
      {
        DB: dbB.mockDb,
        CREEK_REALTIME_URL: "https://rt.example.com",
        CREEK_PROJECT_SLUG: "project-B",
      },
      null,
      async () => {
        // B starts immediately, A is still suspended
        notifyRealtime("items", "UPDATE");
        await new Promise((r) => setTimeout(r, 10));
        results.push("B");
      },
    );

    await Promise.all([requestA, requestB]);

    // Both requests should have completed
    expect(results).toContain("A");
    expect(results).toContain("B");

    // Verify broadcasts went to correct projects
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const urls = fetchSpy.mock.calls.map(([url]: [string]) => url);
    expect(urls).toContain(
      "https://rt.example.com/project-A/broadcast",
    );
    expect(urls).toContain(
      "https://rt.example.com/project-B/broadcast",
    );
  });

  test("ctx.waitUntil is isolated between concurrent requests", async () => {
    const waitUntilA = vi.fn();
    const waitUntilB = vi.fn();

    const requestA = _runRequest(
      {
        CREEK_REALTIME_URL: "https://rt.example.com",
        CREEK_PROJECT_SLUG: "test",
      },
      { waitUntil: waitUntilA },
      async () => {
        await new Promise((r) => setTimeout(r, 20));
        notifyRealtime("a", "INSERT");
      },
    );

    const requestB = _runRequest(
      {
        CREEK_REALTIME_URL: "https://rt.example.com",
        CREEK_PROJECT_SLUG: "test",
      },
      { waitUntil: waitUntilB },
      async () => {
        notifyRealtime("b", "INSERT");
      },
    );

    await Promise.all([requestA, requestB]);

    // Each request's broadcast should use its own ctx.waitUntil
    expect(waitUntilA).toHaveBeenCalledTimes(1);
    expect(waitUntilB).toHaveBeenCalledTimes(1);
  });

  test("db binding is isolated between concurrent requests", async () => {
    const dbA = createMockD1();
    const dbB = createMockD1();

    const requestA = _runRequest({ DB: dbA.mockDb }, null, async () => {
      await new Promise((r) => setTimeout(r, 20));
      // After yielding, db should still use dbA
      await (db as CreekDatabase).query("SELECT * FROM table_a");
    });

    const requestB = _runRequest({ DB: dbB.mockDb }, null, async () => {
      await (db as CreekDatabase).query("SELECT * FROM table_b");
    });

    await Promise.all([requestA, requestB]);

    expect(dbA.mockDb.prepare).toHaveBeenCalledWith("SELECT * FROM table_a");
    expect(dbB.mockDb.prepare).toHaveBeenCalledWith("SELECT * FROM table_b");
    // Ensure no cross-contamination
    expect(dbA.mockDb.prepare).not.toHaveBeenCalledWith(
      "SELECT * FROM table_b",
    );
    expect(dbB.mockDb.prepare).not.toHaveBeenCalledWith(
      "SELECT * FROM table_a",
    );
  });
});

// ── Queue binding inside _runRequest ──

describe("queue inside _runRequest", () => {
  test("queue.send() works inside _runRequest context", async () => {
    const mockSend = vi.fn().mockResolvedValue(undefined);

    await _runRequest(
      { QUEUE: { send: mockSend, sendBatch: vi.fn() } },
      null,
      async () => {
        await queue.send({ type: "job", payload: "data" });
      },
    );

    expect(mockSend).toHaveBeenCalledWith({ type: "job", payload: "data" });
  });

  test("queue binding is isolated between concurrent requests", async () => {
    const sendA = vi.fn().mockResolvedValue(undefined);
    const sendB = vi.fn().mockResolvedValue(undefined);

    const reqA = _runRequest(
      { QUEUE: { send: sendA, sendBatch: vi.fn() } },
      null,
      async () => {
        await new Promise((r) => setTimeout(r, 10));
        await queue.send("from-A");
      },
    );

    const reqB = _runRequest(
      { QUEUE: { send: sendB, sendBatch: vi.fn() } },
      null,
      async () => {
        await queue.send("from-B");
      },
    );

    await Promise.all([reqA, reqB]);

    expect(sendA).toHaveBeenCalledWith("from-A");
    expect(sendB).toHaveBeenCalledWith("from-B");
    expect(sendA).not.toHaveBeenCalledWith("from-B");
  });
});

// ── Fallback compatibility ──

describe("_setEnv/_setCtx fallback", () => {
  test("_setEnv still works as fallback outside _runRequest", () => {
    const { mockDb } = createMockD1();
    _setEnv({ DB: mockDb });

    const stmt = db.prepare("SELECT 1");
    expect(stmt).toBeDefined();
  });

  test("_runRequest takes precedence over _setEnv", () => {
    const dbFallback = createMockD1();
    const dbContext = createMockD1();

    _setEnv({ DB: dbFallback.mockDb });

    _runRequest({ DB: dbContext.mockDb }, null, () => {
      db.prepare("SELECT 1");
    });

    // Should have used the context db, not the fallback
    expect(dbContext.mockDb.prepare).toHaveBeenCalledWith("SELECT 1");
    expect(dbFallback.mockDb.prepare).not.toHaveBeenCalled();
  });

  test("_setCtx still works as fallback outside _runRequest", () => {
    const waitUntil = vi.fn();
    _setEnv({
      CREEK_REALTIME_URL: "https://rt.example.com",
      CREEK_PROJECT_SLUG: "test",
    });
    _setCtx({ waitUntil });

    notifyRealtime("t", "INSERT");

    expect(waitUntil).toHaveBeenCalledTimes(1);
  });
});
