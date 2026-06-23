import { describe, test, expect } from "vitest";
import { Hono } from "hono";
import { isAllowedOrigin, originGuard } from "./origin-guard.js";

// ============================================================================
// A. isAllowedOrigin — allowlist predicate
// ============================================================================

describe("isAllowedOrigin", () => {
  test.each([
    "https://creek.dev",
    "https://app.creek.dev",
    "https://api.creek.dev",
    "https://templates.creek.dev",
    "http://localhost:3000",
    "http://localhost:5173",
    "http://localhost",
  ])("allows %s", (origin) => {
    expect(isAllowedOrigin(origin)).toBe(true);
  });

  test.each([
    "https://evil.com",
    "https://notcreek.dev", // suffix without the dot must NOT match .creek.dev
    "https://creek.dev.evil.com", // creek.dev as a label, not the registrable domain
    "https://app.bycreek.com", // a tenant app — different registrable domain
    "https://localhost.evil.com",
    "not-a-url",
    "",
  ])("rejects %s", (origin) => {
    expect(isAllowedOrigin(origin)).toBe(false);
  });
});

// ============================================================================
// B. originGuard — middleware behavior (method x origin matrix)
// ============================================================================

describe("originGuard middleware", () => {
  function makeApp() {
    const app = new Hono();
    app.use("*", originGuard);
    app.all("/thing", (c) => c.json({ ok: true }));
    return app;
  }

  async function call(method: string, headers?: Record<string, string>) {
    const app = makeApp();
    return app.request("/thing", { method, headers });
  }

  test("state-changing POST with foreign Origin → 403", async () => {
    const res = await call("POST", { Origin: "https://evil.com" });
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe("forbidden");
  });

  test("state-changing POST with no Origin (CLI / webhook) → allowed", async () => {
    const res = await call("POST");
    expect(res.status).toBe(200);
  });

  test("state-changing POST with first-party Origin → allowed", async () => {
    const res = await call("POST", { Origin: "https://app.creek.dev" });
    expect(res.status).toBe(200);
  });

  test.each(["PUT", "PATCH", "DELETE"])(
    "%s with foreign Origin → 403",
    async (method) => {
      const res = await call(method, { Origin: "https://evil.com" });
      expect(res.status).toBe(403);
    },
  );

  test("GET with foreign Origin → allowed (safe method, not a write vector)", async () => {
    const res = await call("GET", { Origin: "https://evil.com" });
    expect(res.status).toBe(200);
  });

  test("HEAD with foreign Origin → allowed", async () => {
    const res = await call("HEAD", { Origin: "https://evil.com" });
    expect(res.status).toBe(200);
  });
});

// NOTE: The end-to-end regression that proves the guard is wired ahead of the
// real authenticated routes (cross-origin POST /projects/:id/env → 403, the
// SameSite=none CSRF gap) lives in env/routes.test.ts, which already owns the
// createTestApp harness. It is kept there to co-locate with the route it
// protects and to avoid a second module that pulls the Better Auth import
// chain.
