import { describe, test, expect } from "vitest";
import { parseRealtimePath, getDoName } from "./parse.js";

describe("parseRealtimePath", () => {
  // ── Legacy (project-wide) routes ──

  test("parses /{slug}/broadcast", () => {
    expect(parseRealtimePath("/my-project/broadcast")).toEqual({
      slug: "my-project",
      roomId: null,
      action: "/broadcast",
    });
  });

  test("parses /{slug}/ws", () => {
    expect(parseRealtimePath("/my-project/ws")).toEqual({
      slug: "my-project",
      roomId: null,
      action: "/ws",
    });
  });

  test("parses /{slug}/status", () => {
    expect(parseRealtimePath("/my-project/status")).toEqual({
      slug: "my-project",
      roomId: null,
      action: "/status",
    });
  });

  // ── Room-scoped routes ──

  test("parses /{slug}/rooms/{roomId}/broadcast", () => {
    expect(parseRealtimePath("/my-project/rooms/abc123/broadcast")).toEqual({
      slug: "my-project",
      roomId: "abc123",
      action: "/broadcast",
    });
  });

  test("parses /{slug}/rooms/{roomId}/ws", () => {
    expect(parseRealtimePath("/my-project/rooms/room-42/ws")).toEqual({
      slug: "my-project",
      roomId: "room-42",
      action: "/ws",
    });
  });

  test("parses /{slug}/rooms/{roomId}/status", () => {
    expect(parseRealtimePath("/my-project/rooms/xyz/status")).toEqual({
      slug: "my-project",
      roomId: "xyz",
      action: "/status",
    });
  });

  // ── Edge cases ──

  test("slug with hyphens", () => {
    expect(parseRealtimePath("/my-cool-app/broadcast")).toEqual({
      slug: "my-cool-app",
      roomId: null,
      action: "/broadcast",
    });
  });

  test("roomId with hyphens", () => {
    expect(parseRealtimePath("/app/rooms/room-with-hyphens/ws")).toEqual({
      slug: "app",
      roomId: "room-with-hyphens",
      action: "/ws",
    });
  });

  test("roomId that is a UUID", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    expect(parseRealtimePath(`/app/rooms/${uuid}/broadcast`)).toEqual({
      slug: "app",
      roomId: uuid,
      action: "/broadcast",
    });
  });

  // ── Invalid paths ──

  test("returns null for root path", () => {
    expect(parseRealtimePath("/")).toBeNull();
  });

  test("returns null for slug only", () => {
    expect(parseRealtimePath("/my-project")).toBeNull();
  });

  test("returns null for invalid action", () => {
    expect(parseRealtimePath("/my-project/invalid")).toBeNull();
  });

  test("returns null for /rooms without roomId", () => {
    expect(parseRealtimePath("/my-project/rooms")).toBeNull();
  });

  test("returns null for /rooms/{roomId} without action", () => {
    expect(parseRealtimePath("/my-project/rooms/abc")).toBeNull();
  });

  test("returns null for /rooms/{roomId}/invalid", () => {
    expect(parseRealtimePath("/my-project/rooms/abc/invalid")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseRealtimePath("")).toBeNull();
  });
});

describe("getDoName", () => {
  test("project-wide: returns slug", () => {
    expect(getDoName({ slug: "my-project", roomId: null, action: "/ws" })).toBe(
      "my-project",
    );
  });

  test("room-scoped: returns slug:roomId", () => {
    expect(
      getDoName({ slug: "my-project", roomId: "abc123", action: "/ws" }),
    ).toBe("my-project:abc123");
  });
});
