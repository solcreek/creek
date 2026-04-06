import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { generateWsToken, _setEnv } from "./index.js";

afterEach(() => {
  _setEnv(null as any);
});

describe("generateWsToken", () => {
  test("returns null when secret is not configured", async () => {
    _setEnv({});
    const token = await generateWsToken();
    expect(token).toBeNull();
  });

  test("returns null when slug is not configured", async () => {
    _setEnv({ CREEK_REALTIME_SECRET: "test-secret" });
    const token = await generateWsToken();
    expect(token).toBeNull();
  });

  test("generates token in timestamp.hmac format", async () => {
    _setEnv({
      CREEK_REALTIME_SECRET: "test-secret",
      CREEK_PROJECT_SLUG: "my-project",
    });
    const token = await generateWsToken();
    expect(token).not.toBeNull();
    expect(token).toMatch(/^\d+\.[a-f0-9]{64}$/);
  });

  test("timestamp is current (within 2 seconds)", async () => {
    _setEnv({
      CREEK_REALTIME_SECRET: "test-secret",
      CREEK_PROJECT_SLUG: "my-project",
    });
    const token = await generateWsToken();
    const timestamp = parseInt(token!.split(".")[0], 10);
    const now = Math.floor(Date.now() / 1000);
    expect(Math.abs(now - timestamp)).toBeLessThanOrEqual(2);
  });

  test("different secrets produce different tokens", async () => {
    _setEnv({
      CREEK_REALTIME_SECRET: "secret-a",
      CREEK_PROJECT_SLUG: "my-project",
    });
    const tokenA = await generateWsToken();

    _setEnv({
      CREEK_REALTIME_SECRET: "secret-b",
      CREEK_PROJECT_SLUG: "my-project",
    });
    const tokenB = await generateWsToken();

    // HMAC parts should differ (timestamps may be same)
    expect(tokenA!.split(".")[1]).not.toBe(tokenB!.split(".")[1]);
  });

  test("same inputs produce same HMAC (deterministic)", async () => {
    _setEnv({
      CREEK_REALTIME_SECRET: "test-secret",
      CREEK_PROJECT_SLUG: "my-project",
    });
    const tokenA = await generateWsToken();
    const tokenB = await generateWsToken();

    // Same second = same token
    if (tokenA!.split(".")[0] === tokenB!.split(".")[0]) {
      expect(tokenA).toBe(tokenB);
    }
  });
});
