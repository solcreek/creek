import { describe, it, expect } from "vitest";
import type { StatsView } from "./creekd-client";

// Test the ring buffer logic without React hooks — extract pure function
function appendSnapshot(
  history: Array<{ ts: number; memoryBytes: number; cpuPercent: number }>,
  stats: StatsView,
  prevCpu: { usec: number; ts: number } | null,
  now: number,
  maxPoints: number,
): {
  history: Array<{ ts: number; memoryBytes: number; cpuPercent: number }>;
  prevCpu: { usec: number; ts: number } | null;
} {
  if (!stats.cgroup_enabled) return { history, prevCpu };

  let cpuPercent = 0;
  let newPrevCpu = prevCpu;
  if (stats.cpu_usage_usec != null) {
    if (prevCpu) {
      const dtUs = stats.cpu_usage_usec - prevCpu.usec;
      const dtMs = now - prevCpu.ts;
      if (dtMs > 0) cpuPercent = (dtUs / 1000 / dtMs) * 100;
    }
    newPrevCpu = { usec: stats.cpu_usage_usec, ts: now };
  }

  const next = [...history, { ts: now, memoryBytes: stats.memory_current_bytes ?? 0, cpuPercent }];
  return {
    history: next.length > maxPoints ? next.slice(-maxPoints) : next,
    prevCpu: newPrevCpu,
  };
}

describe("stats ring buffer", () => {
  const baseStats: StatsView = {
    id: "app1",
    cgroup_enabled: true,
    memory_current_bytes: 50_000_000,
    memory_max_bytes: 256_000_000,
    pids_current: 5,
    cpu_usage_usec: 1_000_000,
    oom_kills: 0,
  };

  it("appends snapshot to history", () => {
    const result = appendSnapshot([], baseStats, null, 1000, 150);
    expect(result.history).toHaveLength(1);
    expect(result.history[0].memoryBytes).toBe(50_000_000);
    expect(result.history[0].cpuPercent).toBe(0); // no prev → 0%
  });

  it("calculates CPU% from delta", () => {
    const prev = { usec: 0, ts: 0 };
    // 1_000_000 usec over 1000ms = 100%
    const result = appendSnapshot([], { ...baseStats, cpu_usage_usec: 1_000_000 }, prev, 1000, 150);
    expect(result.history[0].cpuPercent).toBeCloseTo(100);
  });

  it("calculates partial CPU%", () => {
    const prev = { usec: 1_000_000, ts: 1000 };
    // 200_000 usec over 2000ms = 10%
    const result = appendSnapshot([], { ...baseStats, cpu_usage_usec: 1_200_000 }, prev, 3000, 150);
    expect(result.history[0].cpuPercent).toBeCloseTo(10);
  });

  it("caps history at maxPoints", () => {
    let history: Array<{ ts: number; memoryBytes: number; cpuPercent: number }> = [];
    let prevCpu: { usec: number; ts: number } | null = null;

    for (let i = 0; i < 200; i++) {
      const result = appendSnapshot(history, {
        ...baseStats,
        memory_current_bytes: i * 1000,
        cpu_usage_usec: i * 10000,
      }, prevCpu, i * 2000, 150);
      history = result.history;
      prevCpu = result.prevCpu;
    }

    expect(history).toHaveLength(150);
    // Oldest should be point 50 (200 - 150)
    expect(history[0].memoryBytes).toBe(50 * 1000);
  });

  it("skips non-cgroup stats", () => {
    const result = appendSnapshot([], { id: "app1", cgroup_enabled: false }, null, 1000, 150);
    expect(result.history).toHaveLength(0);
  });

  it("handles zero time delta gracefully", () => {
    const prev = { usec: 1_000_000, ts: 1000 };
    const result = appendSnapshot([], { ...baseStats, cpu_usage_usec: 2_000_000 }, prev, 1000, 150);
    expect(result.history[0].cpuPercent).toBe(0); // dtMs = 0
  });
});
