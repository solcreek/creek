import { useEffect, useRef, useState } from "react";
import type { StatsView } from "./creekd-client";

export interface StatsSnapshot {
  ts: number;
  memoryBytes: number;
  memoryMaxBytes: number;
  cpuPercent: number;
  pids: number;
}

const MAX_POINTS = 150;

/**
 * Polls stats independently via fetch and accumulates into a ring buffer.
 * Avoids React Query structural sharing issues entirely.
 */
export function useStatsRingBuffer(appId: string, baseUrl: string, intervalMs = 2000, token?: string): StatsSnapshot[] {
  const [history, setHistory] = useState<StatsSnapshot[]>([]);
  const prevCpu = useRef<{ usec: number; ts: number } | null>(null);

  useEffect(() => {
    setHistory([]);
    prevCpu.current = null;
    let stopped = false;

    const poll = async () => {
      try {
        const headers: Record<string, string> = {};
        if (token) headers["Authorization"] = `Bearer ${token}`;
        const res = await fetch(`${baseUrl}/v1/apps/${encodeURIComponent(appId)}/stats`, { headers });
        if (!res.ok) return;
        const stats: StatsView = await res.json();
        if (!stats.cgroup_enabled) return;

        const now = Date.now();
        let cpuPercent = 0;
        if (stats.cpu_usage_usec != null) {
          const prev = prevCpu.current;
          if (prev) {
            const dtUs = stats.cpu_usage_usec - prev.usec;
            const dtMs = now - prev.ts;
            if (dtMs > 0) cpuPercent = (dtUs / 1000 / dtMs) * 100;
          }
          prevCpu.current = { usec: stats.cpu_usage_usec, ts: now };
        }

        if (!stopped) {
          setHistory((prev) => {
            const next = [...prev, {
              ts: now,
              memoryBytes: stats.memory_current_bytes ?? 0,
              memoryMaxBytes: stats.memory_max_bytes ?? 0,
              cpuPercent,
              pids: stats.pids_current ?? 0,
            }];
            return next.length > MAX_POINTS ? next.slice(-MAX_POINTS) : next;
          });
        }
      } catch {
        // Network error — skip this tick
      }
    };

    poll();
    const id = setInterval(poll, intervalMs);
    return () => { stopped = true; clearInterval(id); };
  }, [appId, baseUrl, intervalMs, token]);

  return history;
}
