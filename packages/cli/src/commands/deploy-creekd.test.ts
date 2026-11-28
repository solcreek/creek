import { describe, it, expect, vi, afterEach } from "vitest";
import { resolve } from "node:path";
import type { ResolvedConfig } from "@solcreek/sdk";
import { CreekdClient, CreekdApiError } from "../utils/creekd-client.js";
import { deployHandlers } from "./deploy.js";

const BASE = "http://127.0.0.1:9080";

function mockFetchOk(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

function mockFetchSeq(responses: Array<{ ok: boolean; status: number; body: unknown }>) {
  let idx = 0;
  return vi.fn().mockImplementation(() => {
    const r = responses[idx] ?? responses[responses.length - 1];
    idx++;
    return Promise.resolve({
      ok: r.ok,
      status: r.status,
      json: () => Promise.resolve(r.body),
      text: () => Promise.resolve(JSON.stringify(r.body)),
    });
  });
}

describe("CreekdClient deploy flow", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("spawnApp creates a new app", async () => {
    globalThis.fetch = mockFetchOk(
      {
        id: "my-app",
        command: "bun",
        port: 3000,
        status: "running",
        pid: 1234,
        uptime_ms: 0,
        restart_count: 0,
        health_failures: 0,
      },
      201,
    );

    const client = new CreekdClient(BASE, "");
    const app = await client.spawnApp({
      id: "my-app",
      runtime: "bun",
      entry: "dist/index.js",
      port: 3000,
    });

    expect(app.id).toBe("my-app");
    expect(app.status).toBe("running");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      `${BASE}/v1/apps`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("spawnApp throws already_running for duplicate", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: () => Promise.resolve({ code: "already_running", error: "app already running" }),
    });

    const client = new CreekdClient(BASE, "");
    await expect(client.spawnApp({ id: "dup", port: 3000 })).rejects.toThrow(CreekdApiError);
  });

  it("deployApp sends POST to /v1/apps/{id}/deploy", async () => {
    globalThis.fetch = mockFetchOk({
      id: "my-app",
      command: "bun",
      port: 3001,
      status: "running",
      pid: 5678,
      uptime_ms: 0,
      restart_count: 0,
      health_failures: 0,
    });

    const client = new CreekdClient(BASE, "tok");
    const app = await client.deployApp("my-app", {
      runtime: "bun",
      entry: "dist/index.js",
      port: 3001,
    });

    expect(app.pid).toBe(5678);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      `${BASE}/v1/apps/my-app/deploy`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("deployApp sends If-Match header when provided", async () => {
    globalThis.fetch = mockFetchOk({
      id: "my-app",
      status: "running",
      pid: 1,
      port: 3000,
      command: "",
      uptime_ms: 0,
      restart_count: 0,
      health_failures: 0,
    });

    const client = new CreekdClient(BASE, "tok");
    await client.deployApp("my-app", { port: 3001 }, { ifMatch: "rv-42" });

    const callHeaders = (globalThis.fetch as any).mock.calls[0][1].headers;
    expect(callHeaders["If-Match"]).toBe("rv-42");
  });

  it("idempotent deploy: spawn → already_running → deploy", async () => {
    globalThis.fetch = mockFetchSeq([
      // listApps (reachability check)
      { ok: true, status: 200, body: { apps: [] } },
      // spawnApp → 409 already_running
      { ok: false, status: 409, body: { code: "already_running", error: "already running" } },
      // deployApp → success
      {
        ok: true,
        status: 200,
        body: {
          id: "my-app",
          command: "bun",
          port: 3001,
          status: "running",
          pid: 9999,
          uptime_ms: 0,
          restart_count: 0,
          health_failures: 0,
        },
      },
    ]);

    const client = new CreekdClient(BASE, "");

    // Simulate the deploy flow from deploy.ts
    await client.listApps(); // reachability check

    let app;
    try {
      app = await client.spawnApp({
        id: "my-app",
        runtime: "bun",
        entry: "dist/index.js",
        port: 3001,
      });
    } catch (e: any) {
      if (e.code === "already_running") {
        app = await client.deployApp("my-app", {
          runtime: "bun",
          entry: "dist/index.js",
          port: 3001,
        });
      } else {
        throw e;
      }
    }

    expect(app!.id).toBe("my-app");
    expect(app!.pid).toBe(9999);
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it("unreachable creekd throws on listApps", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const client = new CreekdClient(BASE, "");
    await expect(client.listApps()).rejects.toThrow();
  });

  it("deploy 502 (unhealthy) throws CreekdApiError", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: () =>
        Promise.resolve({ code: "deploy_unhealthy", error: "new version failed health check" }),
    });

    const client = new CreekdClient(BASE, "");
    try {
      await client.deployApp("my-app", { port: 3001 });
      expect.unreachable();
    } catch (e: any) {
      expect(e).toBeInstanceOf(CreekdApiError);
      expect(e.status).toBe(502);
      expect(e.code).toBe("deploy_unhealthy");
    }
  });

  it("deployCreekd resolves relative entry against subproject cwd on spawn and emits timing", async () => {
    const subCwd = "/repo/apps/self-hosted";
    const capturedBodies: Array<{ url: string; body?: Record<string, unknown> }> = [];
    globalThis.fetch = vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      const parsedBody = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : undefined;
      capturedBodies.push({ url: String(input), body: parsedBody });
      if (String(input).endsWith("/v1/apps") && (!init?.method || init.method === "GET")) {
        return new Response(JSON.stringify({ apps: [] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          id: "self-hosted",
          command: "bun",
          port: 3000,
          status: "running",
          pid: 123,
          uptime_ms: 0,
          restart_count: 0,
          health_failures: 0,
        }),
        { status: 201 },
      );
    });

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      await deployHandlers.deployCreekd(
        subCwd,
        {
          projectName: "self-hosted",
          framework: null,
          buildCommand: "",
          buildOutput: "dist",
        } as ResolvedConfig,
        true,
        true,
      );

      const spawnCall = capturedBodies.find((c) => c.url.endsWith("/v1/apps") && c.body);
      expect(spawnCall?.body).toMatchObject({
        id: "self-hosted",
        entry: resolve(subCwd, "dist/index.js"),
      });

      const out = stdout.mock.calls.map((c) => String(c[0])).join("");
      const payload = JSON.parse(out.slice(out.indexOf("{")));
      expect(payload).toMatchObject({
        ok: true,
        target: "creekd",
        buildSkipped: true,
        buildTimeS: null,
      });
      expect(typeof payload.deployTimeS).toBe("number");
    } finally {
      stdout.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("deployCreekd resolves workerEntry against subproject cwd on already_running redeploy", async () => {
    const subCwd = "/repo/apps/api";
    const capturedBodies: Array<{ url: string; body?: Record<string, unknown> }> = [];
    globalThis.fetch = vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      const url = String(input);
      const parsedBody = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : undefined;
      capturedBodies.push({ url, body: parsedBody });
      if (url.endsWith("/v1/apps") && (!init?.method || init.method === "GET")) {
        return new Response(JSON.stringify({ apps: [] }), { status: 200 });
      }
      if (url.endsWith("/v1/apps") && init?.method === "POST") {
        return new Response(JSON.stringify({ code: "already_running", error: "already running" }), {
          status: 409,
        });
      }
      return new Response(
        JSON.stringify({
          id: "api",
          command: "bun",
          port: 3000,
          status: "running",
          pid: 456,
          uptime_ms: 0,
          restart_count: 0,
          health_failures: 0,
        }),
        { status: 200 },
      );
    });

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      await deployHandlers.deployCreekd(
        subCwd,
        {
          projectName: "api",
          framework: null,
          buildCommand: "",
          buildOutput: "dist",
          workerEntry: "server.js",
        } as ResolvedConfig,
        true,
        true,
      );

      const deployCall = capturedBodies.find((c) => c.url.endsWith("/v1/apps/api/deploy"));
      expect(deployCall?.body).toMatchObject({
        entry: resolve(subCwd, "server.js"),
      });
    } finally {
      stdout.mockRestore();
      exitSpy.mockRestore();
    }
  });
});
