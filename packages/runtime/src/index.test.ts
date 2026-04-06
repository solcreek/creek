import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { db, _setEnv, _setRoom, notifyRealtime } from "./index.js";
import type { CreekDatabase } from "./index.js";

// ── Mock D1 binding ──

function createMockD1() {
  const mockRun = vi.fn().mockResolvedValue({
    meta: { changes: 1, last_row_id: 42 },
  });
  const mockAll = vi.fn().mockResolvedValue({
    results: [{ id: "1", text: "hello" }],
    meta: {},
  });
  const mockFirst = vi.fn().mockResolvedValue({ id: "1", text: "hello" });

  const mockStatement = {
    bind: vi.fn().mockReturnThis(),
    run: mockRun,
    all: mockAll,
    first: mockFirst,
    raw: vi.fn().mockResolvedValue([]),
  };

  const mockDb = {
    prepare: vi.fn().mockReturnValue({ ...mockStatement, bind: vi.fn().mockReturnValue(mockStatement) }),
    batch: vi.fn().mockResolvedValue([]),
    exec: vi.fn().mockResolvedValue({ count: 0 }),
    dump: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
  };

  return { mockDb, mockStatement, mockRun, mockAll };
}

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
  _setRoom(null);
});

// ── Tests ──

describe("db.query()", () => {
  test("returns results array directly", async () => {
    const { mockDb } = createMockD1();
    _setEnv({ DB: mockDb });

    const rows = await (db as CreekDatabase).query("SELECT * FROM todos");
    expect(rows).toEqual([{ id: "1", text: "hello" }]);
    expect(mockDb.prepare).toHaveBeenCalledWith("SELECT * FROM todos");
  });

  test("passes params via bind", async () => {
    const mockAll = vi.fn().mockResolvedValue({ results: [{ id: "1" }], meta: {} });
    const mockBound = { all: mockAll, run: vi.fn(), first: vi.fn(), raw: vi.fn(), bind: vi.fn() };
    const mockStmt = { bind: vi.fn().mockReturnValue(mockBound), all: mockAll, run: vi.fn(), first: vi.fn(), raw: vi.fn() };
    const mockDb = { prepare: vi.fn().mockReturnValue(mockStmt), batch: vi.fn(), exec: vi.fn(), dump: vi.fn() };
    _setEnv({ DB: mockDb });

    await (db as CreekDatabase).query("SELECT * FROM todos WHERE room_id = ?", "room1");
    expect(mockStmt.bind).toHaveBeenCalledWith("room1");
  });

  test("does not trigger broadcast", async () => {
    const { mockDb } = createMockD1();
    _setEnv({
      DB: mockDb,
      CREEK_REALTIME_URL: "https://rt.example.com",
      CREEK_PROJECT_SLUG: "test-project",
    });

    await (db as CreekDatabase).query("SELECT * FROM todos");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("db.mutate()", () => {
  test("returns changes and lastRowId", async () => {
    const mockRun = vi.fn().mockResolvedValue({ meta: { changes: 1, last_row_id: 42 } });
    const mockBound = { run: mockRun, all: vi.fn(), first: vi.fn(), raw: vi.fn(), bind: vi.fn() };
    const mockStmt = { bind: vi.fn().mockReturnValue(mockBound), run: mockRun, all: vi.fn(), first: vi.fn(), raw: vi.fn() };
    const mockDb = { prepare: vi.fn().mockReturnValue(mockStmt), batch: vi.fn(), exec: vi.fn(), dump: vi.fn() };
    _setEnv({ DB: mockDb });

    const result = await (db as CreekDatabase).mutate(
      "INSERT INTO todos (text) VALUES (?)",
      "hello",
    );
    expect(result).toEqual({ changes: 1, lastRowId: 42 });
  });

  test("triggers broadcast", async () => {
    const mockRun = vi.fn().mockResolvedValue({ meta: { changes: 1, last_row_id: 1 } });
    const mockBound = { run: mockRun, all: vi.fn(), first: vi.fn(), raw: vi.fn(), bind: vi.fn() };
    const mockStmt = { bind: vi.fn().mockReturnValue(mockBound), run: mockRun, all: vi.fn(), first: vi.fn(), raw: vi.fn() };
    const mockDb = { prepare: vi.fn().mockReturnValue(mockStmt), batch: vi.fn(), exec: vi.fn(), dump: vi.fn() };
    _setEnv({
      DB: mockDb,
      CREEK_REALTIME_URL: "https://rt.example.com",
      CREEK_PROJECT_SLUG: "test-project",
    });

    await (db as CreekDatabase).mutate("INSERT INTO todos (text) VALUES (?)", "hello");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://rt.example.com/test-project/broadcast");
    expect(JSON.parse(opts.body)).toEqual({ table: "todos", operation: "INSERT" });
  });
});

describe("db.prepare().run() broadcast", () => {
  test("always broadcasts on .run() (no regex check)", async () => {
    const mockRun = vi.fn().mockResolvedValue({ meta: { changes: 1, last_row_id: 1 } });
    const mockStmt = {
      bind: vi.fn().mockReturnThis(),
      run: mockRun,
      all: vi.fn(),
      first: vi.fn(),
      raw: vi.fn(),
    };
    const mockDb = { prepare: vi.fn().mockReturnValue(mockStmt), batch: vi.fn(), exec: vi.fn(), dump: vi.fn() };
    _setEnv({
      DB: mockDb,
      CREEK_REALTIME_URL: "https://rt.example.com",
      CREEK_PROJECT_SLUG: "test-project",
    });

    // Even a weird ORM-generated SQL should broadcast on .run()
    await db.prepare("WITH cte AS (...) UPDATE todos SET x = 1").run();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("room-scoped broadcast", () => {
  test("_setRoom changes broadcast URL to room-scoped", async () => {
    const mockRun = vi.fn().mockResolvedValue({ meta: { changes: 1, last_row_id: 1 } });
    const mockBound = { run: mockRun, all: vi.fn(), first: vi.fn(), raw: vi.fn(), bind: vi.fn() };
    const mockStmt = { bind: vi.fn().mockReturnValue(mockBound), run: mockRun, all: vi.fn(), first: vi.fn(), raw: vi.fn() };
    const mockDb = { prepare: vi.fn().mockReturnValue(mockStmt), batch: vi.fn(), exec: vi.fn(), dump: vi.fn() };
    _setEnv({
      DB: mockDb,
      CREEK_REALTIME_URL: "https://rt.example.com",
      CREEK_PROJECT_SLUG: "my-app",
    });

    _setRoom("room-42");
    await (db as CreekDatabase).mutate("INSERT INTO todos (text) VALUES (?)", "hello");

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://rt.example.com/my-app/rooms/room-42/broadcast");
  });

  test("_setRoom(null) reverts to project-wide broadcast", async () => {
    const mockRun = vi.fn().mockResolvedValue({ meta: { changes: 1, last_row_id: 1 } });
    const mockBound = { run: mockRun, all: vi.fn(), first: vi.fn(), raw: vi.fn(), bind: vi.fn() };
    const mockStmt = { bind: vi.fn().mockReturnValue(mockBound), run: mockRun, all: vi.fn(), first: vi.fn(), raw: vi.fn() };
    const mockDb = { prepare: vi.fn().mockReturnValue(mockStmt), batch: vi.fn(), exec: vi.fn(), dump: vi.fn() };
    _setEnv({
      DB: mockDb,
      CREEK_REALTIME_URL: "https://rt.example.com",
      CREEK_PROJECT_SLUG: "my-app",
    });

    _setRoom("room-42");
    _setRoom(null);
    await (db as CreekDatabase).mutate("INSERT INTO todos (text) VALUES (?)", "hello");

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://rt.example.com/my-app/broadcast");
  });
});

describe("notifyRealtime", () => {
  test("silent no-op when realtime is not configured", async () => {
    _setEnv({});
    await notifyRealtime("todos", "INSERT");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("includes auth header when secret is set", async () => {
    _setEnv({
      CREEK_REALTIME_URL: "https://rt.example.com",
      CREEK_PROJECT_SLUG: "test",
      CREEK_REALTIME_SECRET: "my-secret",
    });

    await notifyRealtime("todos", "INSERT");

    const [, opts] = fetchSpy.mock.calls[0];
    expect(opts.headers.Authorization).toBe("Bearer my-secret");
  });

  test("no auth header when no secret", async () => {
    _setEnv({
      CREEK_REALTIME_URL: "https://rt.example.com",
      CREEK_PROJECT_SLUG: "test",
    });

    await notifyRealtime("todos", "INSERT");

    const [, opts] = fetchSpy.mock.calls[0];
    expect(opts.headers.Authorization).toBeUndefined();
  });

  test("does not throw if fetch fails", async () => {
    _setEnv({
      CREEK_REALTIME_URL: "https://rt.example.com",
      CREEK_PROJECT_SLUG: "test",
    });
    fetchSpy.mockRejectedValue(new Error("network error"));

    // Should not throw
    await notifyRealtime("todos", "INSERT");
  });
});

describe("D1Database interface compatibility", () => {
  test("db.prepare() returns a wrapped statement", () => {
    const mockStmt = { bind: vi.fn(), run: vi.fn(), all: vi.fn(), first: vi.fn(), raw: vi.fn() };
    const mockDb = { prepare: vi.fn().mockReturnValue(mockStmt), batch: vi.fn(), exec: vi.fn(), dump: vi.fn() };
    _setEnv({ DB: mockDb });

    const stmt = db.prepare("SELECT 1");
    expect(stmt).toBeDefined();
    expect(typeof stmt.bind).toBe("function");
    expect(typeof stmt.run).toBe("function");
    expect(typeof stmt.all).toBe("function");
  });

  test("db.batch() triggers single broadcast", async () => {
    const mockDb = {
      prepare: vi.fn(),
      batch: vi.fn().mockResolvedValue([]),
      exec: vi.fn(),
      dump: vi.fn(),
    };
    _setEnv({
      DB: mockDb,
      CREEK_REALTIME_URL: "https://rt.example.com",
      CREEK_PROJECT_SLUG: "test",
    });

    await db.batch([]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body).toEqual({ table: "*", operation: "BATCH" });
  });

  test("throws when DB is not configured", () => {
    _setEnv({});
    expect(() => db.prepare("SELECT 1")).toThrow("Database (D1) is not enabled");
  });
});

describe("extractTable", () => {
  test("extracts from INSERT INTO", async () => {
    const mockRun = vi.fn().mockResolvedValue({ meta: { changes: 1, last_row_id: 1 } });
    const mockStmt = { bind: vi.fn().mockReturnThis(), run: mockRun, all: vi.fn(), first: vi.fn(), raw: vi.fn() };
    const mockDb = { prepare: vi.fn().mockReturnValue(mockStmt), batch: vi.fn(), exec: vi.fn(), dump: vi.fn() };
    _setEnv({
      DB: mockDb,
      CREEK_REALTIME_URL: "https://rt.example.com",
      CREEK_PROJECT_SLUG: "test",
    });

    await db.prepare('INSERT INTO "users" (name) VALUES (?)').run();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.table).toBe("users");
  });

  test("extracts from UPDATE", async () => {
    const mockRun = vi.fn().mockResolvedValue({ meta: { changes: 1, last_row_id: 1 } });
    const mockStmt = { bind: vi.fn().mockReturnThis(), run: mockRun, all: vi.fn(), first: vi.fn(), raw: vi.fn() };
    const mockDb = { prepare: vi.fn().mockReturnValue(mockStmt), batch: vi.fn(), exec: vi.fn(), dump: vi.fn() };
    _setEnv({
      DB: mockDb,
      CREEK_REALTIME_URL: "https://rt.example.com",
      CREEK_PROJECT_SLUG: "test",
    });

    await db.prepare("UPDATE todos SET completed = 1").run();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.table).toBe("todos");
  });

  test("extracts from DELETE FROM", async () => {
    const mockRun = vi.fn().mockResolvedValue({ meta: { changes: 1, last_row_id: 1 } });
    const mockStmt = { bind: vi.fn().mockReturnThis(), run: mockRun, all: vi.fn(), first: vi.fn(), raw: vi.fn() };
    const mockDb = { prepare: vi.fn().mockReturnValue(mockStmt), batch: vi.fn(), exec: vi.fn(), dump: vi.fn() };
    _setEnv({
      DB: mockDb,
      CREEK_REALTIME_URL: "https://rt.example.com",
      CREEK_PROJECT_SLUG: "test",
    });

    await db.prepare("DELETE FROM sessions WHERE expired = 1").run();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.table).toBe("sessions");
  });
});

describe("db.define()", () => {
  test("exposes define as a function on the db proxy", () => {
    const mockDb = { prepare: vi.fn(), batch: vi.fn(), exec: vi.fn(), dump: vi.fn() };
    _setEnv({ DB: mockDb });

    expect(typeof db.define).toBe("function");
  });
});
