// @vitest-environment jsdom
import { describe, test, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useRoomId } from "../src/hooks/useRoomId.js";

beforeEach(() => {
  // Reset URL
  window.history.replaceState({}, "", "/");
});

describe("useRoomId", () => {
  test("generates a random room ID when none in URL", () => {
    const { result } = renderHook(() => useRoomId());
    expect(result.current).toBeTruthy();
    expect(result.current.length).toBe(8);
  });

  test("updates the URL with generated room ID", () => {
    const { result } = renderHook(() => useRoomId());
    const params = new URLSearchParams(window.location.search);
    expect(params.get("room")).toBe(result.current);
  });

  test("reads room from URL ?room= param", () => {
    window.history.replaceState({}, "", "/?room=my-room-123");
    const { result } = renderHook(() => useRoomId());
    expect(result.current).toBe("my-room-123");
  });

  test("returns same value on re-render", () => {
    const { result, rerender } = renderHook(() => useRoomId());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
