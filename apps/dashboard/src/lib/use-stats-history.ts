import { useEffect, useRef, useState } from "react";
import type { StatsView } from "./creekd-client";

export interface StatsSnapshot {
  ts: number;
  memoryBytes: number;
  memoryMaxBytes: number;
  cpuPercent: number;
  pids: number;
}

const MAX_POINTS = 150; // 5 min × 2s interval

export function useStatsHistory(stats: StatsView | undefined) {
  const [history, setHistory] = useState<StatsSnapshot[]>([]);
  const prevCpu = useRef<{ usec: number; ts: number } | null>(null);

  useEffect(() => {
    if (!stats?.cgroup_enabled) return;

    const now = Date.now();
    let cpuPercent = 0;

    if (stats.cpu_usage_usec != null) {
      const prev = prevCpu.current;
      if (prev) {
        const dtUs = stats.cpu_usage_usec - prev.usec;
        const dtMs = now - prev.ts;
        if (dtMs > 0) {
          cpuPercent = (dtUs / 1000 / dtMs) * 100;
        }
      }
      prevCpu.current = { usec: stats.cpu_usage_usec, ts: now };
    }

    const snapshot: StatsSnapshot = {
      ts: now,
      memoryBytes: stats.memory_current_bytes ?? 0,
      memoryMaxBytes: stats.memory_max_bytes ?? 0,
      cpuPercent,
      pids: stats.pids_current ?? 0,
    };

    setHistory((prev) => {
      const next = [...prev, snapshot];
      return next.length > MAX_POINTS ? next.slice(-MAX_POINTS) : next;
    });
  }, [stats]);

  return history;
}
