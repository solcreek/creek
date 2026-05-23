import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/test/mocks/server";

describe("detectApiMode", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns 'creekd' when VITE_API_MODE=creekd", async () => {
    vi.stubEnv("VITE_API_MODE", "creekd");
    const { detectApiMode } = await import("./adapter");
    expect(detectApiMode()).toBe("creekd");
    vi.unstubAllEnvs();
  });

  it("returns 'hosted' when VITE_API_MODE=hosted", async () => {
    vi.stubEnv("VITE_API_MODE", "hosted");
    const { detectApiMode } = await import("./adapter");
    expect(detectApiMode()).toBe("hosted");
    vi.unstubAllEnvs();
  });

  it("auto-detects creekd from localhost:9080 URL", async () => {
    vi.stubEnv("VITE_API_MODE", "");
    vi.stubEnv("VITE_API_URL", "http://localhost:9080");
    const { detectApiMode } = await import("./adapter");
    expect(detectApiMode()).toBe("creekd");
    vi.unstubAllEnvs();
  });

  it("auto-detects creekd from 127.0.0.1:9080 URL", async () => {
    vi.stubEnv("VITE_API_MODE", "");
    vi.stubEnv("VITE_API_URL", "http://127.0.0.1:9080");
    const { detectApiMode } = await import("./adapter");
    expect(detectApiMode()).toBe("creekd");
    vi.unstubAllEnvs();
  });

  it("defaults to 'hosted' for unknown URL", async () => {
    vi.stubEnv("VITE_API_MODE", "");
    vi.stubEnv("VITE_API_URL", "https://api.creek.dev");
    const { detectApiMode } = await import("./adapter");
    expect(detectApiMode()).toBe("hosted");
    vi.unstubAllEnvs();
  });

  it("defaults to 'hosted' when no env vars set", async () => {
    vi.stubEnv("VITE_API_MODE", "");
    vi.stubEnv("VITE_API_URL", "");
    const { detectApiMode } = await import("./adapter");
    expect(detectApiMode()).toBe("hosted");
    vi.unstubAllEnvs();
  });
});

describe("creekd adapter functions", () => {
  const CREEKD_URL = "http://localhost:9080";

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("VITE_API_MODE", "creekd");
    vi.stubEnv("VITE_API_URL", CREEKD_URL);
    vi.stubEnv("VITE_CREEKD_TOKEN", "test-token");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("listApps returns apps from spec-typed response", async () => {
    server.use(
      http.get(`${CREEKD_URL}/v1/apps`, () => {
        return HttpResponse.json({
          apps: [
            {
              id: "my-app",
              runtime: "bun",
              command: "bun run index.ts",
              args: [],
              env: [],
              port: 3001,
              status: "running",
              pid: 1234,
              uptime_ms: 60000,
              restart_count: 0,
              health_failures: 0,
            },
          ],
        });
      }),
    );

    const { listApps } = await import("./adapter");
    const apps = await listApps();

    expect(apps).toHaveLength(1);
    expect(apps[0].id).toBe("my-app");
    expect(apps[0].status).toBe("running");
    expect(apps[0].runtime).toBe("bun");
    expect(apps[0].uptime_ms).toBe(60000);
  });

  it("getApp returns spec-typed AppView", async () => {
    server.use(
      http.get(`${CREEKD_URL}/v1/apps/my-app`, () => {
        return HttpResponse.json({
          id: "my-app",
          runtime: "node",
          command: "node",
          args: ["server.js"],
          env: ["PORT=3001", "NODE_ENV=production"],
          port: 3001,
          status: "running",
          pid: 5678,
          uptime_ms: 120000,
          restart_count: 2,
          health_failures: 1,
        });
      }),
    );

    const { getApp } = await import("./adapter");
    const app = await getApp("my-app");

    expect(app.id).toBe("my-app");
    expect(app.command).toBe("node");
    expect(app.args).toEqual(["server.js"]);
    expect(app.env).toEqual(["PORT=3001", "NODE_ENV=production"]);
    expect(app.restart_count).toBe(2);
  });

  it("getAppStats returns spec-typed StatsView", async () => {
    server.use(
      http.get(`${CREEKD_URL}/v1/apps/my-app/stats`, () => {
        return HttpResponse.json({
          id: "my-app",
          cgroup_enabled: true,
          memory_current_bytes: 50_000_000,
          memory_max_bytes: 268_435_456,
          pids_current: 5,
          cpu_usage_usec: 1_500_000,
          oom_kills: 0,
        });
      }),
    );

    const { getAppStats } = await import("./adapter");
    const stats = await getAppStats("my-app");

    expect(stats.cgroup_enabled).toBe(true);
    expect(stats.memory_current_bytes).toBe(50_000_000);
    expect(stats.memory_max_bytes).toBe(268_435_456);
    expect(stats.pids_current).toBe(5);
    expect(stats.oom_kills).toBe(0);
  });

  it("getAppLogs returns plain text", async () => {
    server.use(
      http.get(`${CREEKD_URL}/v1/apps/my-app/logs`, () => {
        return new HttpResponse("line 1\nline 2\nline 3", {
          headers: { "Content-Type": "text/plain" },
        });
      }),
    );

    const { getAppLogs } = await import("./adapter");
    const logs = await getAppLogs("my-app", 50);
    expect(logs).toBe("line 1\nline 2\nline 3");
  });

  it("stopApp sends DELETE", async () => {
    let called = false;
    server.use(
      http.delete(`${CREEKD_URL}/v1/apps/my-app`, () => {
        called = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const { stopApp } = await import("./adapter");
    await stopApp("my-app");
    expect(called).toBe(true);
  });

  it("restartApp sends POST and returns updated app", async () => {
    server.use(
      http.post(`${CREEKD_URL}/v1/apps/my-app/restart`, () => {
        return HttpResponse.json({
          id: "my-app",
          runtime: "bun",
          command: "bun run index.ts",
          args: [],
          env: [],
          port: 3001,
          status: "running",
          pid: 9999,
          uptime_ms: 0,
          restart_count: 3,
          health_failures: 0,
        });
      }),
    );

    const { restartApp } = await import("./adapter");
    const app = await restartApp("my-app");
    expect(app.pid).toBe(9999);
    expect(app.restart_count).toBe(3);
  });

  it("sends Authorization header with token", async () => {
    let authHeader: string | null = null;
    server.use(
      http.get(`${CREEKD_URL}/v1/apps`, ({ request }) => {
        authHeader = request.headers.get("Authorization");
        return HttpResponse.json({ apps: [] });
      }),
    );

    const { listApps } = await import("./adapter");
    await listApps();
    expect(authHeader).toBe("Bearer test-token");
  });

  it("throws on non-OK response", async () => {
    server.use(
      http.get(`${CREEKD_URL}/v1/apps/bad-id`, () => {
        return HttpResponse.json(
          { code: "not_found", error: "app not found" },
          { status: 404 },
        );
      }),
    );

    const { getApp } = await import("./adapter");
    await expect(getApp("bad-id")).rejects.toThrow("app not found");
  });
});

describe("hosted adapter functions", () => {
  const API_URL = "http://localhost:8787";

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("VITE_API_MODE", "hosted");
    vi.stubEnv("VITE_API_URL", API_URL);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("listApps maps control-plane projects response", async () => {
    server.use(
      http.get(`${API_URL}/projects`, () => {
        return HttpResponse.json([
          { id: "proj-1", slug: "my-site", framework: "next", productionDeploymentId: "dep-1" },
        ]);
      }),
    );

    const { listApps } = await import("./adapter");
    const apps = await listApps();

    expect(apps).toHaveLength(1);
    expect(apps[0].id).toBe("proj-1");
    expect(apps[0].status).toBe("running");
    expect(apps[0].runtime).toBe("next");
  });

  it("getAppStats returns empty stats for hosted mode", async () => {
    const { getAppStats } = await import("./adapter");
    const stats = await getAppStats("proj-1");
    expect(stats.cgroup_enabled).toBe(false);
    expect(stats.memory_current_bytes).toBeUndefined();
  });
});
