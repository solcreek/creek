import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CreekdClient, CreekdApiError } from "./creekd-client.js";

const BASE = "http://127.0.0.1:9080";

function mockFetch(response: { status: number; body: unknown; contentType?: string }) {
  return vi.fn().mockResolvedValue({
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    statusText: "OK",
    json: () => Promise.resolve(response.body),
    text: () => Promise.resolve(JSON.stringify(response.body)),
  });
}

describe("CreekdClient", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("listApps returns apps array", async () => {
    globalThis.fetch = mockFetch({
      status: 200,
      body: {
        apps: [
          {
            id: "app1",
            command: "node",
            port: 3000,
            status: "running",
            pid: 123,
            uptime_ms: 5000,
            restart_count: 0,
            health_failures: 0,
          },
        ],
      },
    });

    const client = new CreekdClient(BASE, "");
    const apps = await client.listApps();
    expect(apps).toHaveLength(1);
    expect(apps[0].id).toBe("app1");
    expect(apps[0].status).toBe("running");
  });

  it("getStats returns cgroup stats", async () => {
    globalThis.fetch = mockFetch({
      status: 200,
      body: {
        id: "app1",
        cgroup_enabled: true,
        memory_current_bytes: 50_000_000,
        memory_max_bytes: 256_000_000,
        pids_current: 5,
        cpu_usage_usec: 1_500_000,
        oom_kills: 0,
      },
    });

    const client = new CreekdClient(BASE, "");
    const stats = await client.getStats("app1");
    expect(stats.cgroup_enabled).toBe(true);
    expect(stats.memory_current_bytes).toBe(50_000_000);
  });

  it("sends bearer token when provided", async () => {
    const fetchMock = mockFetch({ status: 200, body: { apps: [] } });
    globalThis.fetch = fetchMock;

    const client = new CreekdClient(BASE, "my-token");
    await client.listApps();

    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE}/v1/apps`,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer my-token",
        }),
      }),
    );
  });

  it("throws CreekdApiError on 404", async () => {
    globalThis.fetch = mockFetch({
      status: 404,
      body: { code: "not_found", error: "app not found" },
    });

    const client = new CreekdClient(BASE, "");
    await expect(client.getApp("ghost")).rejects.toThrow(CreekdApiError);
  });

  it("stopApp sends DELETE", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      json: () => Promise.resolve(null),
    });
    globalThis.fetch = fetchMock;

    const client = new CreekdClient(BASE, "");
    await client.stopApp("app1");

    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE}/v1/apps/app1`,
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("restartApp sends POST and returns app", async () => {
    globalThis.fetch = mockFetch({
      status: 200,
      body: {
        id: "app1",
        command: "node",
        port: 3000,
        status: "running",
        pid: 999,
        uptime_ms: 0,
        restart_count: 3,
        health_failures: 0,
      },
    });

    const client = new CreekdClient(BASE, "");
    const app = await client.restartApp("app1");
    expect(app.pid).toBe(999);
    expect(app.restart_count).toBe(3);
  });
});
