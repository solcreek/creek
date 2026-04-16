import { describe, test, expect } from "vitest";
import { hashAsset } from "./assets.js";

describe("hashAsset", () => {
  test("returns a 32-char hex string", async () => {
    const content = new TextEncoder().encode("hello world").buffer;
    const hash = await hashAsset(content, "team-123");
    expect(hash).toHaveLength(32);
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
  });

  test("same content + same salt = same hash", async () => {
    const content = new TextEncoder().encode("hello").buffer;
    const a = await hashAsset(content, "salt");
    const b = await hashAsset(content, "salt");
    expect(a).toBe(b);
  });

  test("same content + different salt = different hash", async () => {
    const content = new TextEncoder().encode("hello").buffer;
    const a = await hashAsset(content, "team-a");
    const b = await hashAsset(content, "team-b");
    expect(a).not.toBe(b);
  });

  test("different content + same salt = different hash", async () => {
    const a = await hashAsset(new TextEncoder().encode("file-a").buffer, "salt");
    const b = await hashAsset(new TextEncoder().encode("file-b").buffer, "salt");
    expect(a).not.toBe(b);
  });

  test("handles empty content", async () => {
    const hash = await hashAsset(new ArrayBuffer(0), "salt");
    expect(hash).toHaveLength(32);
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
  });
});
