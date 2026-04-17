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

// Full auth-server tests require loopback TCP. Some sandboxed
// environments (certain CI runners, Claude Code's tool sandbox)
// block even localhost binds — gate on TEST_NETWORK so default
// `pnpm test` stays green, and real dev/CI runs the tests.
describe.skipIf(!process.env.TEST_NETWORK)("auth-server loopback", () => {
  test("starts, receives callback, validates state", async () => {
    const { startAuthServer } = await import("./auth-server.js");
    const { port, state, waitForCallback, close } = await startAuthServer();

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

  test("rejects callback with mismatched state", async () => {
    const { startAuthServer } = await import("./auth-server.js");
    const { port, waitForCallback, close } = await startAuthServer();

    // Observe the rejection to prevent unhandled-rejection warning —
    // state mismatch rejects the waitForCallback promise.
    const observed = waitForCallback().catch((err) => err);

    try {
      const res = await fetch(
        `http://localhost:${port}/callback?key=creek_test&state=wrong`,
      );
      expect(res.status).toBe(400);

      const err = await observed;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/state mismatch/i);
    } finally {
      close();
    }
  });
});
