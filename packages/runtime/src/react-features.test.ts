// @vitest-environment jsdom
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { LiveRoom, useLiveQuery } from "./react.js";
import type { MutateRequest } from "./react.js";

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
    setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0);
  }
  send() {}
  close() { this.readyState = 3; }
  _receiveMessage(data: object) { this.onmessage?.({ data: JSON.stringify(data) }); }
}
const originalWebSocket = globalThis.WebSocket;
beforeEach(() => { MockWebSocket.instances = []; globalThis.WebSocket = MockWebSocket as any; });
afterEach(() => { globalThis.WebSocket = originalWebSocket; });

function createWrapper(roomId: string, wsUrl: string) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(LiveRoom, { id: roomId, realtimeUrl: wsUrl, children });
  };
}

// ── Tests ──

describe("mutate with request descriptor", () => {
  test("POST with body auto-sets Content-Type and JSON.stringify", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve([]) });
    const wrapper = createWrapper("r1", "wss://rt/test/rooms/r1/ws");

    const { result } = renderHook(() => useLiveQuery("/api/todos", { initialData: [] }), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.mutate(
        { method: "POST", path: "/api/items", body: { text: "hello" } },
        (prev) => [...prev, { text: "hello" }] as any,
      );
    });

    const postCalls = fetchMock.mock.calls.filter(
      ([url]: [string]) => url === "/api/items",
    );
    expect(postCalls.length).toBe(1);
    const [, init] = postCalls[0];
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"text":"hello"}');
    const ct = init.headers instanceof Headers ? init.headers.get("Content-Type") : init.headers["Content-Type"];
    expect(ct).toBe("application/json");
  });

  test("DELETE without body sends no Content-Type", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve([]) });
    const wrapper = createWrapper("r1", "wss://rt/test/rooms/r1/ws");

    const { result } = renderHook(() => useLiveQuery("/api/todos", { initialData: [] }), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.mutate(
        { method: "DELETE", path: "/api/items/1" },
        (prev) => prev,
      );
    });

    const delCalls = fetchMock.mock.calls.filter(
      ([url]: [string]) => url === "/api/items/1",
    );
    expect(delCalls.length).toBe(1);
    expect(delCalls[0][1].method).toBe("DELETE");
    expect(delCalls[0][1].body).toBeUndefined();
  });
});

describe("onChange callback", () => {
  test("called when data changes from refetch", async () => {
    const onChange = vi.fn();
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([{ id: 1 }]) })  // config
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([{ id: 1 }]) })  // initial
      .mockResolvedValue({ ok: true, json: () => Promise.resolve([{ id: 1 }, { id: 2 }]) }); // refetch

    const wrapper = createWrapper("r1", "wss://rt/test/rooms/r1/ws");
    const { result } = renderHook(
      () => useLiveQuery("/api/items", { onChange }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // onChange should have been called with initial data
    expect(onChange).toHaveBeenCalled();
  });
});

describe("onMutationError callback", () => {
  test("called on mutation failure instead of throwing", async () => {
    const onError = vi.fn();
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve([]) });
    const wrapper = createWrapper("r1", "wss://rt/test/rooms/r1/ws");

    const { result } = renderHook(
      () => useLiveQuery("/api/items", { initialData: [], onMutationError: onError }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      // This should NOT throw because onMutationError is set
      await result.current.mutate(
        () => Promise.reject(new Error("fail")),
        (prev) => [...prev, "optimistic"] as any,
      );
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    // Data should be rolled back
    expect(result.current.data).toEqual([]);
  });
});

describe("select option", () => {
  test("transforms data via select function", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([
        { id: 1, completed: true },
        { id: 2, completed: false },
        { id: 3, completed: true },
      ]),
    });

    const wrapper = createWrapper("r1", "wss://rt/test/rooms/r1/ws");
    const { result } = renderHook(
      () => useLiveQuery("/api/items", {
        select: (items: any[]) => items.filter((i: any) => i.completed),
      }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toEqual([
      { id: 1, completed: true },
      { id: 3, completed: true },
    ]);
  });
});
