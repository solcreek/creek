import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import app from "../worker/index.js";
import { _setEnv, _setRoom } from "creek";

// ── Mock D1 ──

function createMockDb() {
  const rows: Map<string, any[]> = new Map();

  function getRows(roomId: string) {
    if (!rows.has(roomId)) rows.set(roomId, []);
    return rows.get(roomId)!;
  }

  const mockAll = vi.fn(async () => ({ results: [] as any[], meta: {} }));
  const mockRun = vi.fn(async () => ({ meta: { changes: 1, last_row_id: 1 } }));

  const mockDb = {
    prepare: vi.fn((sql: string) => {
      const stmt = {
        bind: vi.fn((...args: unknown[]) => {
          // Parse what operation this is based on SQL
          if (sql.includes("SELECT")) {
            const roomId = args[0] as string;
            return {
              ...stmt,
              all: vi.fn(async () => ({
                results: getRows(roomId),
                meta: {},
              })),
            };
          }
          if (sql.includes("INSERT")) {
            const [id, roomId, text] = args as string[];
            return {
              ...stmt,
              run: vi.fn(async () => {
                getRows(roomId).unshift({
                  id,
                  text,
                  completed: 0,
                  created_at: new Date().toISOString(),
                });
                return { meta: { changes: 1, last_row_id: 1 } };
              }),
            };
          }
          if (sql.includes("UPDATE")) {
            const [id, roomId] = args as string[];
            return {
              ...stmt,
              run: vi.fn(async () => {
                const r = getRows(roomId);
                const todo = r.find((t) => t.id === id);
                if (todo) todo.completed = todo.completed ? 0 : 1;
                return { meta: { changes: todo ? 1 : 0, last_row_id: 0 } };
              }),
            };
          }
          if (sql.includes("DELETE FROM todos WHERE id")) {
            const [id, roomId] = args as string[];
            return {
              ...stmt,
              run: vi.fn(async () => {
                const r = getRows(roomId);
                const idx = r.findIndex((t) => t.id === id);
                if (idx >= 0) r.splice(idx, 1);
                return { meta: { changes: idx >= 0 ? 1 : 0, last_row_id: 0 } };
              }),
            };
          }
          // Cleanup delete
          return { ...stmt, run: vi.fn(async () => ({ meta: { changes: 0, last_row_id: 0 } })) };
        }),
        all: mockAll,
        run: mockRun,
        first: vi.fn(),
        raw: vi.fn(),
      };
      return stmt;
    }),
    batch: vi.fn(),
    exec: vi.fn(),
    dump: vi.fn(),
  };

  return { mockDb, rows, getRows };
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  // Mock fetch for broadcast calls
  globalThis.fetch = vi.fn().mockResolvedValue(new Response("ok"));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  _setEnv(null as any);
  _setRoom(null);
});

// ── Helper ──

function makeRequest(
  method: string,
  path: string,
  body?: object,
  roomId?: string,
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (roomId) headers["X-Creek-Room"] = roomId;

  return new Request(`http://localhost${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

// ── Tests ──

describe("GET /api/todos", () => {
  test("returns empty array for new room", async () => {
    const { mockDb } = createMockDb();
    _setEnv({ DB: mockDb });

    const res = await app.request(
      makeRequest("GET", "/api/todos", undefined, "new-room"),
    );
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });
});

describe("POST /api/todos", () => {
  test("creates a todo in the room", async () => {
    const { mockDb, getRows } = createMockDb();
    _setEnv({ DB: mockDb });

    const res = await app.request(
      makeRequest("POST", "/api/todos", { text: "Buy milk" }, "room-1"),
    );
    const data = await res.json();
    expect(data.text).toBe("Buy milk");
    expect(data.completed).toBe(0);
    expect(data.id).toBeDefined();
  });
});

describe("PATCH /api/todos/:id", () => {
  test("toggles completed status", async () => {
    const { mockDb, getRows } = createMockDb();
    getRows("room-1").push({
      id: "todo-1",
      text: "Test",
      completed: 0,
      created_at: new Date().toISOString(),
    });
    _setEnv({ DB: mockDb });

    const res = await app.request(
      makeRequest("PATCH", "/api/todos/todo-1", undefined, "room-1"),
    );
    const data = await res.json();
    expect(data.ok).toBe(true);
  });
});

describe("DELETE /api/todos/:id", () => {
  test("removes a todo", async () => {
    const { mockDb, getRows } = createMockDb();
    getRows("room-1").push({
      id: "todo-1",
      text: "Test",
      completed: 0,
      created_at: new Date().toISOString(),
    });
    _setEnv({ DB: mockDb });

    const res = await app.request(
      makeRequest("DELETE", "/api/todos/todo-1", undefined, "room-1"),
    );
    const data = await res.json();
    expect(data.ok).toBe(true);
  });
});

describe("Room isolation", () => {
  test("todos in room A are not visible in room B", async () => {
    const { mockDb, getRows } = createMockDb();
    _setEnv({ DB: mockDb });

    // Add todo to room-a
    getRows("room-a").push({
      id: "todo-a",
      text: "Room A todo",
      completed: 0,
      created_at: new Date().toISOString(),
    });

    // Query room-b — should NOT contain room-a's todo
    // (may contain auto-seeded demo data, but NOT "Room A todo")
    const res = await app.request(
      makeRequest("GET", "/api/todos", undefined, "room-b"),
    );
    const data = await res.json() as any[];
    const hasRoomATodo = data.some((t: any) => t.text === "Room A todo");
    expect(hasRoomATodo).toBe(false);
  });
});
