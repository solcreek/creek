// @vitest-environment jsdom
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import {
  LiveRoom,
  useRoom,
  useQuery,
  useLiveQuery,
  usePresence,
} from "./react.js";

// ── Mock fetch ──

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── Mock WebSocket ──

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    // Auto-connect after next tick
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
    }, 0);
  }

  send(_data: string) {}
  close() {
    this.readyState = 3;
  }

  // Test helper: simulate server message
  _receiveMessage(data: object) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

const originalWebSocket = globalThis.WebSocket;
beforeEach(() => {
  MockWebSocket.instances = [];
  globalThis.WebSocket = MockWebSocket as any;
});
afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
});

// ── Helper: LiveRoom wrapper ──

function createRoomWrapper(roomId: string, realtimeUrl?: string) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(LiveRoom, { id: roomId, realtimeUrl, children });
  };
}

// ── Tests ──

describe("useQuery", () => {
  test("fetches data on mount", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ id: 1 }]),
    });

    const { result } = renderHook(() => useQuery("/api/todos"));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.data).toEqual([{ id: 1 }]);
    expect(result.current.error).toBeNull();
  });

  test("handles fetch errors", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });

    const { result } = renderHook(() => useQuery("/api/todos"));

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });
    expect(result.current.error?.message).toBe("HTTP 500");
  });

  test("refetch reloads data", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([{ id: 1 }]),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([{ id: 1 }, { id: 2 }]),
      });

    const { result } = renderHook(() => useQuery("/api/todos"));

    await waitFor(() => expect(result.current.data).toEqual([{ id: 1 }]));

    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.data).toEqual([{ id: 1 }, { id: 2 }]);
  });
});

describe("useRoom", () => {
  test("returns room context inside LiveRoom", async () => {
    // Mock config fetch
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          realtimeUrl: "https://rt.example.com",
          projectSlug: "test",
        }),
    });

    const wrapper = createRoomWrapper("room-42", "wss://rt.example.com/test/rooms/room-42/ws");

    const { result } = renderHook(() => useRoom(), { wrapper });

    expect(result.current.roomId).toBe("room-42");
    expect(typeof result.current.isConnected).toBe("boolean");
    expect(typeof result.current.peers).toBe("number");
  });

  test("throws outside LiveRoom", () => {
    const { result } = renderHook(() => {
      try {
        useRoom();
        return { error: null };
      } catch (e) {
        return { error: (e as Error).message };
      }
    });

    expect(result.current.error).toBe(
      "useRoom must be used within <LiveRoom>",
    );
  });
});

describe("useLiveQuery inside LiveRoom", () => {
  test("adds X-Creek-Room header to fetch", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ id: 1 }]),
    });

    const wrapper = createRoomWrapper("room-42", "wss://rt.example.com/test/rooms/room-42/ws");

    const { result } = renderHook(() => useLiveQuery("/api/todos"), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // Check that fetch was called with the room header
    const fetchCalls = fetchMock.mock.calls.filter(
      ([url]: [string]) => url === "/api/todos",
    );
    expect(fetchCalls.length).toBeGreaterThan(0);
    const [, opts] = fetchCalls[0];
    // Headers may be a Headers object or a plain object
    const headers = opts?.headers instanceof Headers
      ? opts.headers.get("x-creek-room")
      : opts?.headers?.["x-creek-room"];
    expect(headers).toBe("room-42");
  });

  test("subscribes to shared WS instead of creating own", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ id: 1 }]),
    });

    const wrapper = createRoomWrapper("room-42", "wss://rt.example.com/test/rooms/room-42/ws");

    renderHook(() => useLiveQuery("/api/todos"), { wrapper });

    await waitFor(() => {
      // Only the LiveRoom should create a WebSocket, not useLiveQuery
      // LiveRoom creates 1 WS
      expect(MockWebSocket.instances.length).toBe(1);
      expect(MockWebSocket.instances[0].url).toBe(
        "wss://rt.example.com/test/rooms/room-42/ws",
      );
    });
  });

  test("refetches when room WS receives db_changed", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ id: 1 }]),
    });

    const wrapper = createRoomWrapper("room-42", "wss://rt.example.com/test/rooms/room-42/ws");

    const { result } = renderHook(() => useLiveQuery("/api/todos"), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // Clear fetch mock to track the refetch
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ id: 1 }, { id: 2 }]),
    });

    // Simulate server sending db_changed
    await act(async () => {
      const ws = MockWebSocket.instances[0];
      ws._receiveMessage({ type: "db_changed", table: "todos" });
      // Wait for refetch
      await new Promise((r) => setTimeout(r, 10));
    });

    await waitFor(() => {
      const fetchCalls = fetchMock.mock.calls.filter(
        ([url]: [string]) => url === "/api/todos",
      );
      expect(fetchCalls.length).toBeGreaterThan(0);
    });
  });
});

describe("useLiveQuery standalone (outside LiveRoom)", () => {
  test("without realtimeUrl: no WebSocket, just fetch", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ id: 1 }]),
    });

    const { result } = renderHook(() => useLiveQuery("/api/todos"));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // No WebSocket should be created
    expect(MockWebSocket.instances.length).toBe(0);
    // Data should be fetched
    expect(result.current.data).toEqual([{ id: 1 }]);
  });

  test("with realtimeUrl: creates own WebSocket", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });

    renderHook(() =>
      useLiveQuery("/api/todos", { realtimeUrl: "wss://custom.example.com/ws" }),
    );

    await waitFor(() => {
      expect(MockWebSocket.instances.length).toBe(1);
      expect(MockWebSocket.instances[0].url).toBe(
        "wss://custom.example.com/ws",
      );
    });
  });
});

describe("useLiveQuery mutate with optimistic updates", () => {
  test("applies optimistic update immediately, then refetches", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([{ id: 1, text: "old" }]),
      })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) }) // action
      .mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve([
            { id: 1, text: "old" },
            { id: 2, text: "new" },
          ]),
      });

    const originalLocation = globalThis.location;
    Object.defineProperty(globalThis, "location", {
      value: { protocol: "https:", host: "app.example.com" },
      writable: true,
    });

    const { result } = renderHook(() => useLiveQuery("/api/todos"));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toEqual([{ id: 1, text: "old" }]);

    await act(async () => {
      await result.current.mutate(
        () => fetch("/api/todos", { method: "POST" }),
        (prev) => [...(prev ?? []), { id: 2, text: "new" }],
      );
    });

    // After mutate, data should be the refetched version
    await waitFor(() => {
      expect((result.current.data as any[])?.length).toBe(2);
    });

    Object.defineProperty(globalThis, "location", {
      value: originalLocation,
      writable: true,
    });
  });

  test("rolls back optimistic update on action failure", async () => {
    const originalData = [{ id: 1, text: "original" }];
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(originalData),
    });

    const wrapper = createRoomWrapper("room-rollback", "wss://rt.example.com/test/rooms/room-rollback/ws");

    const { result } = renderHook(() => useLiveQuery("/api/todos"), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toEqual(originalData);

    // Mutate with an action that fails
    await act(async () => {
      try {
        await result.current.mutate(
          () => Promise.reject(new Error("Network error")),
          (prev) => [...(prev ?? []), { id: 2, text: "optimistic" }],
        );
      } catch {
        // Expected
      }
    });

    // Data should be rolled back to original
    expect(result.current.data).toEqual(originalData);
  });
});

// ─── usePresence ──────────────────────────────────────────────────────────────

describe("usePresence", () => {
  test("connects to WebSocket with provided realtimeUrl", async () => {
    const { result } = renderHook(() =>
      usePresence("public-homepage", {
        realtimeUrl: "https://rt.example.com",
        projectSlug: "www",
      }),
    );

    await waitFor(() => {
      expect(MockWebSocket.instances.length).toBe(1);
      expect(MockWebSocket.instances[0].url).toBe(
        "wss://rt.example.com/www/rooms/public-homepage/ws",
      );
      expect(result.current.isConnected).toBe(true);
    });

    expect(result.current.count).toBe(0);
  });

  test("updates count on peers message", async () => {
    const { result } = renderHook(() =>
      usePresence("public-homepage", {
        realtimeUrl: "https://rt.example.com",
        projectSlug: "www",
      }),
    );

    await waitFor(() => expect(result.current.isConnected).toBe(true));

    act(() => {
      MockWebSocket.instances[0]._receiveMessage({ type: "peers", count: 5 });
    });

    expect(result.current.count).toBe(5);
  });

  test("updates count when peers change", async () => {
    const { result } = renderHook(() =>
      usePresence("public-lobby", {
        realtimeUrl: "https://rt.example.com",
        projectSlug: "app",
      }),
    );

    await waitFor(() => expect(result.current.isConnected).toBe(true));

    act(() => {
      MockWebSocket.instances[0]._receiveMessage({ type: "peers", count: 3 });
    });
    expect(result.current.count).toBe(3);

    act(() => {
      MockWebSocket.instances[0]._receiveMessage({ type: "peers", count: 2 });
    });
    expect(result.current.count).toBe(2);
  });

  test("ignores non-peers messages", async () => {
    const { result } = renderHook(() =>
      usePresence("public-test", {
        realtimeUrl: "https://rt.example.com",
        projectSlug: "app",
      }),
    );

    await waitFor(() => expect(result.current.isConnected).toBe(true));

    act(() => {
      MockWebSocket.instances[0]._receiveMessage({ type: "db_changed", table: "todos" });
    });

    // count should remain 0 — db_changed is not a peers message
    expect(result.current.count).toBe(0);
  });

  test("uses http:// → ws:// protocol conversion", async () => {
    renderHook(() =>
      usePresence("public-test", {
        realtimeUrl: "http://localhost:8788",
        projectSlug: "dev",
      }),
    );

    await waitFor(() => {
      expect(MockWebSocket.instances[0].url).toBe(
        "ws://localhost:8788/dev/rooms/public-test/ws",
      );
    });
  });

  test("count decreases when peers disconnect (simulated server messages)", async () => {
    const { result } = renderHook(() =>
      usePresence("public-lobby", {
        realtimeUrl: "https://rt.example.com",
        projectSlug: "app",
      }),
    );

    await waitFor(() => expect(result.current.isConnected).toBe(true));

    // Simulate: 3 peers connect
    act(() => {
      MockWebSocket.instances[0]._receiveMessage({ type: "peers", count: 3 });
    });
    expect(result.current.count).toBe(3);

    // Simulate: one disconnects → server sends peers: 2
    act(() => {
      MockWebSocket.instances[0]._receiveMessage({ type: "peers", count: 2 });
    });
    expect(result.current.count).toBe(2);

    // Simulate: another disconnects → peers: 1
    act(() => {
      MockWebSocket.instances[0]._receiveMessage({ type: "peers", count: 1 });
    });
    expect(result.current.count).toBe(1);
  });

  test("auto-discovers config when no options provided", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          realtimeUrl: "https://rt.creek.dev",
          projectSlug: "my-app",
          wsToken: "abc.123",
        }),
    });

    renderHook(() => usePresence("my-room"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/__creek/config");
      expect(MockWebSocket.instances.length).toBe(1);
      expect(MockWebSocket.instances[0].url).toBe(
        "wss://rt.creek.dev/my-app/rooms/my-room/ws?token=abc.123",
      );
    });
  });
});
