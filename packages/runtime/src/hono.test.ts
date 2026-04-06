import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { room, broadcast } from "./hono.js";
import { _setEnv, _setRoom } from "./index.js";

const originalFetch = globalThis.fetch;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn().mockResolvedValue(new Response("ok"));
  globalThis.fetch = fetchSpy;
  _setEnv({
    CREEK_REALTIME_URL: "https://rt.example.com",
    CREEK_PROJECT_SLUG: "test-project",
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  _setEnv(null as any);
  _setRoom(null);
});

describe("room() middleware", () => {
  test("reads X-Creek-Room header and sets c.var.room", async () => {
    const app = new Hono();
    app.use("*", room());
    app.get("/test", (c) => {
      return c.json({ room: c.get("room") });
    });

    const res = await app.request("/test", {
      headers: { "X-Creek-Room": "my-room-42" },
    });
    const data = await res.json();
    expect(data.room).toBe("my-room-42");
  });

  test("c.var.room is undefined when no header", async () => {
    const app = new Hono();
    app.use("*", room());
    app.get("/test", (c) => {
      return c.json({ room: c.get("room") ?? null });
    });

    const res = await app.request("/test");
    const data = await res.json();
    expect(data.room).toBeNull();
  });

  test("cleans up _roomId after request completes", async () => {
    const app = new Hono();
    app.use("*", room());
    app.get("/test", (c) => c.text("ok"));

    await app.request("/test", {
      headers: { "X-Creek-Room": "temp-room" },
    });

    // After the request, _roomId should be null (project-wide broadcast)
    // We verify by calling notifyRealtime and checking the URL
    await (await import("./index.js")).notifyRealtime("test", "TEST");
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://rt.example.com/test-project/broadcast");
    expect(url).not.toContain("rooms");
  });

  test("cleans up _roomId even if handler throws", async () => {
    const app = new Hono();
    app.use("*", room());
    app.get("/test", () => {
      throw new Error("handler error");
    });
    // Hono catches errors, so the middleware finally block should still run
    app.onError((err, c) => c.text("error", 500));

    await app.request("/test", {
      headers: { "X-Creek-Room": "temp-room" },
    });

    await (await import("./index.js")).notifyRealtime("test", "TEST");
    const [url] = fetchSpy.mock.calls[0];
    expect(url).not.toContain("rooms");
  });
});

describe("broadcast()", () => {
  test("sends manual broadcast with defaults", async () => {
    _setRoom("my-room");
    await broadcast();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe(
      "https://rt.example.com/test-project/rooms/my-room/broadcast",
    );
    const body = JSON.parse(opts.body);
    expect(body).toEqual({ table: "_manual", operation: "NOTIFY" });
  });

  test("sends manual broadcast with custom event", async () => {
    await broadcast({ table: "users", operation: "SYNC" });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body).toEqual({ table: "users", operation: "SYNC" });
  });
});
