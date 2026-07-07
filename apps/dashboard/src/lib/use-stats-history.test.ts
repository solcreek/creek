import { describe, it, expect } from "vitest";
import type { StatsView } from "./creekd-client";

// Test the ring buffer accumulation logic extracted from the hook
function simulateRingBuffer(
  statsList: StatsView[],
  maxPoints: number,
): Array<{ ts: number; memoryBytes: number; cpuPercent: number }> {
  const history: Array<{ ts: number; memoryBytes: number; cpuPercent: number }> = [];
  let prevCpu: { usec: number; ts: number } | null = null;

  for (let i = 0; i < statsList.length; i++) {
    const stats = statsList[i];
    if (!stats.cgroup_enabled) continue;

    const now = i * 2000;
    let cpuPercent = 0;
    if (stats.cpu_usage_usec != null) {
      if (prevCpu) {
        const dtUs = stats.cpu_usage_usec - prevCpu.usec;
        const dtMs = now - prevCpu.ts;
        if (dtMs > 0) cpuPercent = (dtUs / 1000 / dtMs) * 100;
      }
      prevCpu = { usec: stats.cpu_usage_usec, ts: now };
    }

    history.push({ ts: now, memoryBytes: stats.memory_current_bytes ?? 0, cpuPercent });
    if (history.length > maxPoints) history.splice(0, history.length - maxPoints);
  }

  return history;
}

const baseStats: StatsView = {
  id: "app1",
  cgroup_enabled: true,
  memory_current_bytes: 50_000_000,
  memory_max_bytes: 256_000_000,
  pids_current: 5,
  cpu_usage_usec: 1_000_000,
  oom_kills: 0,
};

describe("stats ring buffer logic", () => {
  it("accumulates snapshots", () => {
    const result = simulateRingBuffer([baseStats, baseStats], 150);
    expect(result).toHaveLength(2);
    expect(result[0].memoryBytes).toBe(50_000_000);
  });

  it("calculates CPU% from delta", () => {
    const result = simulateRingBuffer(
      [
        { ...baseStats, cpu_usage_usec: 0 },
        { ...baseStats, cpu_usage_usec: 2_000_000 }, // 2M usec over 2000ms = 100%
      ],
      150,
    );
    expect(result[0].cpuPercent).toBe(0); // first point: no prev
    expect(result[1].cpuPercent).toBeCloseTo(100);
  });

  it("caps at maxPoints", () => {
    const stats = Array.from({ length: 200 }, (_, i) => ({
      ...baseStats,
      memory_current_bytes: i * 1000,
      cpu_usage_usec: i * 10000,
    }));
    const result = simulateRingBuffer(stats, 150);
    expect(result).toHaveLength(150);
    expect(result[0].memoryBytes).toBe(50 * 1000);
  });

  it("skips non-cgroup stats", () => {
    const result = simulateRingBuffer([{ id: "app1", cgroup_enabled: false }], 150);
    expect(result).toHaveLength(0);
  });

  it("handles zero CPU delta", () => {
    const result = simulateRingBuffer(
      [
        { ...baseStats, cpu_usage_usec: 1_000_000 },
        { ...baseStats, cpu_usage_usec: 1_000_000 },
      ],
      150,
    );
    expect(result[1].cpuPercent).toBe(0);
  });
});
