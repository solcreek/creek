import { describe, test, expect, vi } from "vitest";
import { deployToCreek } from "./creek-api.js";

/**
 * Tests for the remote builder's Creek API client.
 * The Worker + Container integration is tested via E2E (real deployment).
 */

describe("deployToCreek", () => {
  test("creates project when not found", async () => {
    const calls: string[] = [];

    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      calls.push(`${init?.method || "GET"} ${urlStr}`);

      // GET project → 404
      if (urlStr.includes("/projects/test-app") && (!init || init.method === "GET" || !init.method)) {
        return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
      }
      // POST create project
      if (urlStr.endsWith("/projects") && init?.method === "POST") {
        return Response.json({ project: { id: "proj-1" } });
      }
      // POST create deployment
      if (urlStr.includes("/deployments") && init?.method === "POST" && !urlStr.includes("/bundle")) {
        return Response.json({ deployment: { id: "deploy-1" } });
      }
      // PUT upload bundle
      if (urlStr.includes("/bundle") && init?.method === "PUT") {
        return new Response(null, { status: 202 });
      }
      // GET deployment status
      if (urlStr.includes("/deployments/deploy-1") && (!init?.method || init.method === "GET")) {
        return Response.json({
          deployment: { status: "active" },
          url: "https://test-app.bycreek.com",
          previewUrl: "https://test-app-deploy-1.bycreek.com",
        });
      }
      return new Response("Not found", { status: 404 });
    }) as any;

    const result = await deployToCreek(
      "https://api.creek.dev",
      "test-token",
      "test-app",
      "nuxt",
      { manifest: {}, assets: {}, serverFiles: {} },
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.url).toBe("https://test-app.bycreek.com");
      expect(result.deploymentId).toBe("deploy-1");
    }

    // Verify API call sequence
    expect(calls[0]).toContain("GET");
    expect(calls[0]).toContain("/projects/test-app");
    expect(calls[1]).toContain("POST");
    expect(calls[1]).toContain("/projects");
    expect(calls[2]).toContain("POST");
    expect(calls[2]).toContain("/deployments");
    expect(calls[3]).toContain("PUT");
    expect(calls[3]).toContain("/bundle");
  });

  test("uses existing project when found", async () => {
    const calls: string[] = [];

    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      calls.push(`${init?.method || "GET"} ${urlStr}`);

      // GET project → found
      if (urlStr.includes("/projects/existing") && (!init || !init.method || init.method === "GET")) {
        return Response.json({ id: "proj-existing" });
      }
      if (urlStr.includes("/deployments") && init?.method === "POST" && !urlStr.includes("/bundle")) {
        return Response.json({ deployment: { id: "d-1" } });
      }
      if (urlStr.includes("/bundle") && init?.method === "PUT") {
        return new Response(null, { status: 202 });
      }
      if (urlStr.includes("/deployments/d-1") && (!init?.method || init.method === "GET")) {
        return Response.json({
          deployment: { status: "active" },
          url: "https://existing.bycreek.com",
          previewUrl: "https://existing-d-1.bycreek.com",
        });
      }
      return new Response("Not found", { status: 404 });
    }) as any;

    const result = await deployToCreek(
      "https://api.creek.dev",
      "token",
      "existing",
      undefined,
      { manifest: {}, assets: {} },
    );

    expect(result.success).toBe(true);
    // Should NOT have a POST /projects call (project already exists)
    const createCalls = calls.filter(c => c === "POST https://api.creek.dev/projects");
    expect(createCalls).toHaveLength(0);
  });

  test("returns failed status on deploy failure", async () => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/projects/app") && (!init || !init.method || init.method === "GET")) {
        return Response.json({ id: "p-1" });
      }
      if (urlStr.includes("/deployments") && init?.method === "POST" && !urlStr.includes("/bundle")) {
        return Response.json({ deployment: { id: "d-fail" } });
      }
      if (urlStr.includes("/bundle") && init?.method === "PUT") {
        return new Response(null, { status: 202 });
      }
      if (urlStr.includes("/deployments/d-fail") && (!init?.method || init.method === "GET")) {
        return Response.json({
          deployment: {
            status: "failed",
            failedStep: "provisioning",
            errorMessage: "D1 limit exceeded",
          },
        });
      }
      return new Response("Not found", { status: 404 });
    }) as any;

    const result = await deployToCreek(
      "https://api.creek.dev",
      "token",
      "app",
      undefined,
      { manifest: {}, assets: {} },
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.status).toBe("failed");
      expect(result.failedStep).toBe("provisioning");
      expect(result.errorMessage).toBe("D1 limit exceeded");
    }
  });
});
