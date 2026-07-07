import { describe, it, expect, vi, afterEach } from "vitest";

describe("creek top --json output schema", () => {
  it("snapshot matches expected agent-consumable shape", async () => {
    const mockApps = [
      {
        id: "api",
        command: "node",
        port: 3000,
        status: "running" as const,
        pid: 1234,
        uptime_ms: 60000,
        restart_count: 0,
        health_failures: 0,
        runtime: "node",
      },
      {
        id: "worker",
        command: "bun",
        port: 3001,
        status: "crash_loop" as const,
        pid: 0,
        uptime_ms: 0,
        restart_count: 5,
        health_failures: 3,
      },
    ];

    const mockStats = new Map([
      [
        "api",
        {
          id: "api",
          cgroup_enabled: true,
          memory_current_bytes: 50_000_000,
          memory_max_bytes: 256_000_000,
          pids_current: 8,
          cpu_usage_usec: 1_000_000,
          oom_kills: 0,
        },
      ],
      [
        "worker",
        {
          id: "worker",
          cgroup_enabled: false,
        },
      ],
    ]);

    // Dynamically import to get the types
    const { fmtBytes, fmtDuration } = await import("../utils/top-format.js");

    // Simulate what collectSnapshot produces
    const rows = mockApps.map((app) => {
      const stats = mockStats.get(app.id);
      return {
        id: app.id,
        status: app.status,
        cpu: "—",
        mem: stats?.memory_current_bytes != null ? fmtBytes(stats.memory_current_bytes) : "—",
        memLimit:
          stats?.memory_max_bytes != null && stats.memory_max_bytes > 0
            ? fmtBytes(stats.memory_max_bytes)
            : "—",
        pids: stats?.pids_current != null ? String(stats.pids_current) : "—",
        restarts: app.restart_count,
        uptime: fmtDuration(app.uptime_ms),
      };
    });

    const snapshot = {
      ok: true,
      apps: rows,
      summary: {
        total: mockApps.length,
        running: mockApps.filter((a) => a.status === "running").length,
        crashed: mockApps.filter((a) => a.status === "crash_loop").length,
      },
      timestamp: new Date().toISOString(),
    };

    // Validate shape — these are the fields agents rely on
    expect(snapshot.ok).toBe(true);
    expect(snapshot.apps).toHaveLength(2);
    expect(snapshot.summary.total).toBe(2);
    expect(snapshot.summary.running).toBe(1);
    expect(snapshot.summary.crashed).toBe(1);

    const api = snapshot.apps[0];
    expect(api).toEqual(
      expect.objectContaining({
        id: "api",
        status: "running",
        mem: "47.7M",
        memLimit: "244.1M",
        pids: "8",
        restarts: 0,
        uptime: "1m",
      }),
    );

    const worker = snapshot.apps[1];
    expect(worker).toEqual(
      expect.objectContaining({
        id: "worker",
        status: "crash_loop",
        mem: "—",
        memLimit: "—",
        pids: "—",
        restarts: 5,
        uptime: "0s",
      }),
    );

    // JSON round-trip: agents parse this
    const json = JSON.stringify(snapshot);
    const parsed = JSON.parse(json);
    expect(parsed.ok).toBe(true);
    expect(parsed.apps).toHaveLength(2);
    expect(typeof parsed.timestamp).toBe("string");
  });
});
