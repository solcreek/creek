import { describe, test, expect } from "vitest";
import { deriveRealtimeSecret } from "./hmac.js";

describe("deriveRealtimeSecret", () => {
  test("returns a hex string", async () => {
    const secret = await deriveRealtimeSecret("master-key", "my-project");
    expect(secret).toMatch(/^[0-9a-f]{64}$/); // SHA-256 = 64 hex chars
  });

  test("same inputs produce same output (deterministic)", async () => {
    const a = await deriveRealtimeSecret("master-key", "my-project");
    const b = await deriveRealtimeSecret("master-key", "my-project");
    expect(a).toBe(b);
  });

  test("different slugs produce different secrets", async () => {
    const a = await deriveRealtimeSecret("master-key", "project-a");
    const b = await deriveRealtimeSecret("master-key", "project-b");
    expect(a).not.toBe(b);
  });

  test("different master keys produce different secrets", async () => {
    const a = await deriveRealtimeSecret("key-1", "my-project");
    const b = await deriveRealtimeSecret("key-2", "my-project");
    expect(a).not.toBe(b);
  });
});
