import { defineCommand } from "citty";
import consola from "consola";
import { globalArgs, resolveJsonMode, jsonOutput, isTTY } from "../utils/output.js";
import {
  CreekdClient,
  CreekdApiError,
  getCreekdUrl,
  type AppView,
  type StatsView,
} from "../utils/creekd-client.js";
import { fmtBytes, fmtDuration, calcCpuPercent } from "../utils/top-format.js";

export const topCommand = defineCommand({
  meta: {
    name: "top",
    description: "Live view of apps on a creekd instance",
  },
  args: {
    ...globalArgs,
    server: {
      type: "string",
      description: "creekd admin API URL (or $CREEKD_URL)",
      required: false,
    },
    token: {
      type: "string",
      description: "Bearer token (or $CREEKD_TOKEN)",
      required: false,
    },
    interval: {
      type: "string",
      description: "Refresh interval in seconds (default 2)",
      default: "2",
    },
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const client = new CreekdClient(
      args.server || getCreekdUrl(),
      args.token || process.env.CREEKD_TOKEN || process.env.CREEKCTL_TOKEN || "",
    );
    const intervalMs = Math.max(500, parseFloat(args.interval || "2") * 1000);

    if (jsonMode) {
      const snapshot = await collectSnapshot(client);
      jsonOutput(
        { ok: true, ...snapshot },
        0,
        [
          { command: "creek top --json", description: "Refresh snapshot" },
          { command: "creek logs <app-id>", description: "Stream app logs" },
        ],
      );
    }

    await liveTop(client, intervalMs);
  },
});

interface AppRow {
  id: string;
  status: string;
  cpu: string;
  mem: string;
  memLimit: string;
  pids: string;
  restarts: number;
  uptime: string;
}

interface Snapshot {
  apps: AppRow[];
  summary: { total: number; running: number; crashed: number };
  timestamp: string;
}

let prevCpu: Map<string, { usec: number; ts: number }> = new Map();

async function collectSnapshot(client: CreekdClient): Promise<Snapshot> {
  const apps = await client.listApps();
  const now = Date.now();
  const rows: AppRow[] = [];

  const statsResults = await Promise.allSettled(
    apps.map((app) => client.getStats(app.id)),
  );

  for (let i = 0; i < apps.length; i++) {
    const app = apps[i];
    const stats = statsResults[i].status === "fulfilled"
      ? (statsResults[i] as PromiseFulfilledResult<StatsView>).value
      : null;

    let cpuStr = "—";
    if (stats?.cgroup_enabled && stats.cpu_usage_usec != null) {
      const prev = prevCpu.get(app.id);
      if (prev) {
        const pct = calcCpuPercent(prev.usec, prev.ts, stats.cpu_usage_usec, now);
        if (pct !== null) cpuStr = pct.toFixed(1) + "%";
      }
      prevCpu.set(app.id, { usec: stats.cpu_usage_usec, ts: now });
    }

    rows.push({
      id: app.id,
      status: app.status,
      cpu: cpuStr,
      mem: stats?.memory_current_bytes != null ? fmtBytes(stats.memory_current_bytes) : "—",
      memLimit: stats?.memory_max_bytes != null && stats.memory_max_bytes > 0
        ? fmtBytes(stats.memory_max_bytes)
        : "—",
      pids: stats?.pids_current != null ? String(stats.pids_current) : "—",
      restarts: app.restart_count,
      uptime: fmtDuration(app.uptime_ms),
    });
  }

  const running = apps.filter((a) => a.status === "running").length;
  const crashed = apps.filter((a) => a.status === "crash_loop").length;

  return {
    apps: rows,
    summary: { total: apps.length, running, crashed },
    timestamp: new Date().toISOString(),
  };
}

async function liveTop(client: CreekdClient, intervalMs: number) {
  const url = client instanceof CreekdClient
    ? getCreekdUrl()
    : "creekd";

  let first = true;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const snap = await collectSnapshot(client);
      if (isTTY) process.stdout.write("\x1b[2J\x1b[H");
      render(snap, url);
      first = false;
    } catch (err) {
      if (first) {
        if (err instanceof CreekdApiError && err.status === 401) {
          consola.error("Authentication failed. Set CREEKD_TOKEN or use --token.");
        } else {
          consola.error(`Cannot reach creekd at ${url}`);
          consola.info("Is creekd running? Check with: systemctl status creekd");
        }
        process.exit(1);
      }
      if (isTTY) process.stdout.write("\x1b[2J\x1b[H");
      consola.warn(`Refresh failed: ${(err as Error).message}`);
    }

    await sleep(intervalMs);
  }
}

function render(snap: Snapshot, url: string) {
  const { apps, summary } = snap;
  const dim = "\x1b[2m";
  const reset = "\x1b[0m";
  const bold = "\x1b[1m";
  const green = "\x1b[32m";
  const red = "\x1b[31m";
  const yellow = "\x1b[33m";

  const header = `${bold}creek top${reset}${dim} — ${url}${reset}  ` +
    `${summary.total} apps, ${green}${summary.running} running${reset}` +
    (summary.crashed > 0 ? `, ${red}${summary.crashed} crashed${reset}` : "");
  process.stdout.write(header + "\n\n");

  if (apps.length === 0) {
    process.stdout.write(`${dim}  No apps running.${reset}\n`);
    return;
  }

  const cols = ["APP", "STATUS", "CPU", "MEM", "LIMIT", "PIDS", "RESTARTS", "UPTIME"];
  const widths = cols.map((c, i) => {
    const dataMax = Math.max(...apps.map((r) => String(cellValue(r, i)).length), 0);
    return Math.max(c.length, dataMax);
  });

  const headerLine = cols.map((c, i) => c.padEnd(widths[i])).join("  ");
  process.stdout.write(`${dim}  ${headerLine}${reset}\n`);

  for (const row of apps) {
    const statusColor = row.status === "running" ? green
      : row.status === "crash_loop" ? red
      : row.status === "starting" ? yellow
      : dim;

    const cells = cols.map((_, i) => {
      const val = String(cellValue(row, i));
      if (i === 1) return `${statusColor}${val.padEnd(widths[i])}${reset}`;
      return val.padEnd(widths[i]);
    });
    process.stdout.write("  " + cells.join("  ") + "\n");
  }

  process.stdout.write(`\n${dim}  Refreshing every ${(snap as any)._intervalS || 2}s — Ctrl+C to quit${reset}\n`);
}

function cellValue(row: AppRow, col: number): string | number {
  switch (col) {
    case 0: return row.id;
    case 1: return row.status;
    case 2: return row.cpu;
    case 3: return row.mem;
    case 4: return row.memLimit;
    case 5: return row.pids;
    case 6: return row.restarts;
    case 7: return row.uptime;
    default: return "";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
