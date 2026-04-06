import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WebSocket } from "ws";
import {
  LocalRealtimeServer,
  parseRealtimePath,
  getDoName,
} from "./local-realtime.js";

// ─── URL Routing (matches realtime-worker/src/parse.test.ts contract) ────────

describe("parseRealtimePath", () => {
  it("parses room-scoped broadcast", () => {
    expect(parseRealtimePath("/my-project/rooms/room1/broadcast")).toEqual({
      slug: "my-project",
      roomId: "room1",
      action: "/broadcast",
    });
  });

  it("parses room-scoped ws", () => {
    expect(parseRealtimePath("/my-project/rooms/room1/ws")).toEqual({
      slug: "my-project",
      roomId: "room1",
      action: "/ws",
    });
  });

  it("parses room-scoped status", () => {
    expect(parseRealtimePath("/my-project/rooms/room1/status")).toEqual({
      slug: "my-project",
      roomId: "room1",
      action: "/status",
    });
  });

  it("parses legacy project-wide broadcast", () => {
    expect(parseRealtimePath("/my-project/broadcast")).toEqual({
      slug: "my-project",
      roomId: null,
      action: "/broadcast",
    });
  });

  it("parses legacy project-wide ws", () => {
    expect(parseRealtimePath("/my-project/ws")).toEqual({
      slug: "my-project",
      roomId: null,
      action: "/ws",
    });
  });

  it("returns null for root path", () => {
    expect(parseRealtimePath("/")).toBeNull();
  });

  it("returns null for single segment", () => {
    expect(parseRealtimePath("/my-project")).toBeNull();
  });

  it("returns null for invalid action", () => {
    expect(parseRealtimePath("/my-project/invalid")).toBeNull();
  });

  it("returns null for incomplete room path", () => {
    expect(parseRealtimePath("/my-project/rooms/room1")).toBeNull();
  });
});

describe("getDoName", () => {
  it("returns slug for project-wide route", () => {
    expect(getDoName({ slug: "proj", roomId: null, action: "/ws" })).toBe(
      "proj",
    );
  });

  it("returns slug:roomId for room-scoped route", () => {
    expect(getDoName({ slug: "proj", roomId: "r1", action: "/ws" })).toBe(
      "proj:r1",
    );
  });
});

// ─── Unit Tests (mock WebSocket objects) ──────────────────────────────────────

describe("LocalRealtimeServer unit", () => {
  let server: LocalRealtimeServer;

  beforeEach(() => {
    server = new LocalRealtimeServer();
  });

  function mockWs(readyState = WebSocket.OPEN) {
    return {
      readyState,
      send: vi.fn(),
      on: vi.fn(),
      close: vi.fn(),
    } as unknown as WebSocket;
  }

  it("broadcasts to all open sockets in room", () => {
    const ws1 = mockWs();
    const ws2 = mockWs();
    server._testAddSocket("proj:room1", ws1);
    server._testAddSocket("proj:room1", ws2);

    server.broadcast("proj:room1", { type: "db_changed", table: "todos" });

    expect((ws1.send as any).mock.calls[0][0]).toBe(
      '{"type":"db_changed","table":"todos"}',
    );
    expect((ws2.send as any).mock.calls[0][0]).toBe(
      '{"type":"db_changed","table":"todos"}',
    );
  });

  it("skips closed sockets", () => {
    const open = mockWs(WebSocket.OPEN);
    const closed = mockWs(WebSocket.CLOSED);
    server._testAddSocket("proj:r1", open);
    server._testAddSocket("proj:r1", closed);

    server.broadcast("proj:r1", { type: "db_changed", table: "x" });

    expect(open.send).toHaveBeenCalled();
    expect(closed.send).not.toHaveBeenCalled();
  });

  it("rooms are isolated", () => {
    const ws1 = mockWs();
    const ws2 = mockWs();
    server._testAddSocket("proj:room-a", ws1);
    server._testAddSocket("proj:room-b", ws2);

    server.broadcast("proj:room-a", { type: "db_changed", table: "t" });

    expect(ws1.send).toHaveBeenCalled();
    expect(ws2.send).not.toHaveBeenCalled();
  });

  it("getRoomCount returns 0 for unknown room", () => {
    expect(server.getRoomCount("nonexistent")).toBe(0);
  });

  it("getRoomCount returns correct count", () => {
    server._testAddSocket("proj:r1", mockWs());
    server._testAddSocket("proj:r1", mockWs());
    server._testAddSocket("proj:r2", mockWs());

    expect(server.getRoomCount("proj:r1")).toBe(2);
    expect(server.getRoomCount("proj:r2")).toBe(1);
  });

  it("broadcast does nothing for unknown room", () => {
    // Should not throw
    server.broadcast("nonexistent", { type: "test" });
  });
});

// ─── Integration Tests (real HTTP + WebSocket) ───────────────────────────────

describe("LocalRealtimeServer integration", () => {
  let server: LocalRealtimeServer;
  let port: number;

  beforeEach(async () => {
    server = new LocalRealtimeServer({ port: 0 });
    ({ port } = await server.start());
  });

  afterEach(async () => {
    await server.stop();
  });

  /** Connect and immediately start buffering messages. */
  function connectWs(path: string): Promise<WebSocket & { messages: any[] }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`) as WebSocket & { messages: any[] };
      ws.messages = [];
      ws.on("message", (data) => {
        ws.messages.push(JSON.parse(data.toString()));
      });
      ws.on("open", () => resolve(ws));
      ws.on("error", reject);
    });
  }

  /** Wait until a WebSocket has received at least `count` messages. */
  function waitForMessages(ws: WebSocket & { messages: any[] }, count: number): Promise<any[]> {
    return new Promise((resolve) => {
      const check = () => {
        if (ws.messages.length >= count) {
          resolve(ws.messages.slice(0, count));
        } else {
          ws.on("message", check);
        }
      };
      check();
    });
  }

  it("health check returns ok", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    const body = await res.json();
    expect(body).toEqual({ service: "creek-realtime-local", status: "ok" });
  });

  it("returns 404 for unknown routes", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/proj/unknown`);
    expect(res.status).toBe(404);
  });

  it("status returns 0 clients for empty room", async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/proj/rooms/r1/status`,
    );
    const body = await res.json();
    expect(body).toEqual({ clients: 0 });
  });

  it("broadcasts db_changed to connected WebSocket clients", async () => {
    const ws = await connectWs("/proj/rooms/r1/ws");

    // Wait for initial peers message
    await waitForMessages(ws, 1);

    // POST broadcast
    const res = await fetch(
      `http://127.0.0.1:${port}/proj/rooms/r1/broadcast`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ table: "todos", operation: "INSERT" }),
      },
    );

    const broadcastResult = await res.json();
    expect(broadcastResult).toEqual({ ok: true, clients: 1 });

    // Wait for db_changed message
    await waitForMessages(ws, 2);

    expect(ws.messages).toContainEqual({ type: "peers", count: 1 });
    expect(ws.messages).toContainEqual({
      type: "db_changed",
      table: "todos",
      operation: "INSERT",
    });

    ws.close();
  });

  it("broadcasts peer count on connect and disconnect", async () => {
    const ws1 = await connectWs("/proj/rooms/r1/ws");

    // First client gets peers: 1
    await waitForMessages(ws1, 1);
    expect(ws1.messages[0]).toEqual({ type: "peers", count: 1 });

    // Second client connects → both get peers: 2
    const ws2 = await connectWs("/proj/rooms/r1/ws");
    await waitForMessages(ws1, 2); // peers:1 + peers:2
    await waitForMessages(ws2, 1); // peers:2

    expect(ws1.messages[1]).toEqual({ type: "peers", count: 2 });
    expect(ws2.messages[0]).toEqual({ type: "peers", count: 2 });

    // Disconnect ws2 → ws1 gets peers: 1
    const countBefore = ws1.messages.length;
    ws2.close();
    await waitForMessages(ws1, countBefore + 1);

    expect(ws1.messages[ws1.messages.length - 1]).toEqual({
      type: "peers",
      count: 1,
    });

    ws1.close();
  });

  it("isolates rooms — broadcast to room-a does not reach room-b", async () => {
    const wsA = await connectWs("/proj/rooms/room-a/ws");
    const wsB = await connectWs("/proj/rooms/room-b/ws");

    // Wait for initial peers messages
    await waitForMessages(wsA, 1);
    await waitForMessages(wsB, 1);

    const bCountBefore = wsB.messages.length;

    // Broadcast to room-a only
    await fetch(`http://127.0.0.1:${port}/proj/rooms/room-a/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ table: "items", operation: "UPDATE" }),
    });

    await waitForMessages(wsA, 2);
    expect(wsA.messages[1]).toEqual({
      type: "db_changed",
      table: "items",
      operation: "UPDATE",
    });

    // room-b should not have received anything extra
    // Give a small window to ensure no stray messages arrive
    await new Promise((r) => setTimeout(r, 50));
    expect(wsB.messages.length).toBe(bCountBefore);

    wsA.close();
    wsB.close();
  });

  it("returns 400 for malformed JSON in broadcast", async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/proj/rooms/r1/broadcast`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: "invalid JSON" });
  });

  it("legacy project-wide broadcast works", async () => {
    const ws = await connectWs("/proj/ws");
    await waitForMessages(ws, 1); // peers

    await fetch(`http://127.0.0.1:${port}/proj/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ table: "events", operation: "DELETE" }),
    });

    await waitForMessages(ws, 2); // peers + db_changed
    expect(ws.messages).toContainEqual({ type: "peers", count: 1 });
    expect(ws.messages).toContainEqual({
      type: "db_changed",
      table: "events",
      operation: "DELETE",
    });

    ws.close();
  });

  it("peer count decreases correctly through multiple disconnects", async () => {
    const ws1 = await connectWs("/proj/rooms/lobby/ws");
    const ws2 = await connectWs("/proj/rooms/lobby/ws");
    const ws3 = await connectWs("/proj/rooms/lobby/ws");

    // All three should eventually see peers: 3
    await waitForMessages(ws1, 3); // peers:1, peers:2, peers:3
    await waitForMessages(ws3, 1); // peers:3

    expect(ws1.messages[ws1.messages.length - 1]).toEqual({
      type: "peers",
      count: 3,
    });

    // Disconnect ws3 → remaining clients get peers: 2
    const ws1CountBefore = ws1.messages.length;
    const ws2CountBefore = ws2.messages.length;
    ws3.close();
    await waitForMessages(ws1, ws1CountBefore + 1);
    expect(ws1.messages[ws1.messages.length - 1]).toEqual({
      type: "peers",
      count: 2,
    });

    // Disconnect ws2 → ws1 gets peers: 1
    const ws1CountBefore2 = ws1.messages.length;
    ws2.close();
    await waitForMessages(ws1, ws1CountBefore2 + 1);
    expect(ws1.messages[ws1.messages.length - 1]).toEqual({
      type: "peers",
      count: 1,
    });

    ws1.close();
  });

  it("cleans up empty rooms after disconnect", async () => {
    const ws = await connectWs("/proj/rooms/temp/ws");
    await waitForMessages(ws, 1);

    expect(server.getRoomCount("proj:temp")).toBe(1);

    ws.close();
    // Wait for close event processing
    await new Promise((r) => setTimeout(r, 100));

    expect(server.getRoomCount("proj:temp")).toBe(0);
  });

  it("stop() closes all connections", async () => {
    const ws = await connectWs("/proj/rooms/r1/ws");
    await waitForMessages(ws, 1);

    const closePromise = new Promise<void>((resolve) => {
      ws.on("close", () => resolve());
    });

    await server.stop();
    await closePromise;

    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });

  it("status reflects correct client count", async () => {
    const ws1 = await connectWs("/proj/rooms/r1/ws");
    const ws2 = await connectWs("/proj/rooms/r1/ws");
    await waitForMessages(ws1, 2); // peers:1, peers:2
    await waitForMessages(ws2, 1); // peers:2

    const res = await fetch(
      `http://127.0.0.1:${port}/proj/rooms/r1/status`,
    );
    const body = await res.json();
    expect(body).toEqual({ clients: 2 });

    ws1.close();
    ws2.close();
  });

  it("rejects WebSocket upgrade on non-ws paths", async () => {
    // Attempting WS upgrade on /broadcast should fail
    await expect(
      connectWs("/proj/rooms/r1/broadcast"),
    ).rejects.toThrow();
  });
});
