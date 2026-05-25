import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CreekdClient, CreekdApiError } from "../utils/creekd-client.js";

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
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("spawnApp creates a new app", async () => {
    globalThis.fetch = mockFetchOk({
      id: "my-app", command: "bun", port: 3000, status: "running",
      pid: 1234, uptime_ms: 0, restart_count: 0, health_failures: 0,
    }, 201);

    const client = new CreekdClient(BASE, "");
    const app = await client.spawnApp({
      id: "my-app", runtime: "bun", entry: "dist/index.js", port: 3000,
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
      id: "my-app", command: "bun", port: 3001, status: "running",
      pid: 5678, uptime_ms: 0, restart_count: 0, health_failures: 0,
    });

    const client = new CreekdClient(BASE, "tok");
    const app = await client.deployApp("my-app", {
      runtime: "bun", entry: "dist/index.js", port: 3001,
    });

    expect(app.pid).toBe(5678);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      `${BASE}/v1/apps/my-app/deploy`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("deployApp sends If-Match header when provided", async () => {
    globalThis.fetch = mockFetchOk({ id: "my-app", status: "running", pid: 1, port: 3000, command: "", uptime_ms: 0, restart_count: 0, health_failures: 0 });

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
      { ok: true, status: 200, body: { id: "my-app", command: "bun", port: 3001, status: "running", pid: 9999, uptime_ms: 0, restart_count: 0, health_failures: 0 } },
    ]);

    const client = new CreekdClient(BASE, "");

    // Simulate the deploy flow from deploy.ts
    await client.listApps(); // reachability check

    let app;
    try {
      app = await client.spawnApp({ id: "my-app", runtime: "bun", entry: "dist/index.js", port: 3001 });
    } catch (e: any) {
      if (e.code === "already_running") {
        app = await client.deployApp("my-app", { runtime: "bun", entry: "dist/index.js", port: 3001 });
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
      json: () => Promise.resolve({ code: "deploy_unhealthy", error: "new version failed health check" }),
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
});
