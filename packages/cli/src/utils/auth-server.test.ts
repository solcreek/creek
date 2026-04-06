import { describe, test, expect } from "vitest";
import { randomBytes } from "node:crypto";

describe("auth-server state generation", () => {
  test("randomBytes generates unique 32-char hex strings", () => {
    const a = randomBytes(16).toString("hex");
    const b = randomBytes(16).toString("hex");

    expect(a).toHaveLength(32);
    expect(b).toHaveLength(32);
    expect(a).not.toBe(b);
  });
});

// Full auth-server tests require localhost network.
// Run with: TEST_NETWORK=1 pnpm vitest run src/utils/auth-server.test.ts
describe.skipIf(!process.env.TEST_NETWORK)("auth-server network", () => {
  test("starts, receives callback, validates state", async () => {
    const { startAuthServer } = await import("./auth-server.js");
    const { port, state, waitForCallback, close } = startAuthServer();

    try {
      expect(port).toBeGreaterThan(0);

      const res = await fetch(
        `http://localhost:${port}/callback?key=creek_test&state=${state}`,
      );
      expect(res.status).toBe(200);

      const key = await waitForCallback();
      expect(key).toBe("creek_test");
    } finally {
      close();
    }
  });
});
