import { defineCommand } from "citty";
import consola from "consola";
import WebSocket from "ws";
import {
  CreekClient,
  resolveConfig,
  ConfigNotFoundError,
  type LogEntry,
  type LogQueryFilters,
  type ResolvedConfig,
} from "@solcreek/sdk";
import { getToken, getApiUrl } from "../utils/config.js";
import {
  globalArgs,
  resolveJsonMode,
  jsonOutput,
  AUTH_BREADCRUMBS,
  NO_PROJECT_BREADCRUMBS,
} from "../utils/output.js";
import { matchesClientSide, describeFilters, safeStringify as ssExport } from "./logs-filter.js";

/**
 * `creek logs` — read structured tenant logs from R2 archive.
 *
 * Auth: requires `creek login`. Server is responsible for tenant
 * isolation — the CLI simply targets the project slug, the
 * authenticated session decides which team's logs are visible.
 *
 * Project resolution: --project flag wins; otherwise resolve from
 * cwd creek.toml / wrangler.*. If neither, error with hint.
 *
 * `--follow` is reserved for Step 7 (WebSocket subscribe). For now
 * the command is one-shot historical query.
 *
 * Output:
 *   default → human-friendly multi-line per entry, colored by
 *             outcome (ok=dim, exception=red, etc.)
 *   --json  → newline-delimited LogEntry JSON, suitable for `| jq`
 */
export const logsCommand = defineCommand({
  meta: {
    name: "logs",
    description: "Read recent log entries for a project",
  },
  args: {
    project: {
      type: "string",
      description: "Project slug. Defaults to creek.toml in cwd.",
    },
    since: {
      type: "string",
      description: "Time window start. Relative (1h, 30m, 2d) or ISO. Default: 1h",
    },
    until: {
      type: "string",
      description: 'Time window end. "now" or ISO. Default: now',
    },
    outcome: {
      type: "string",
      description:
        "Filter by tail outcome. Repeatable via comma (ok,exception).",
    },
    "script-type": {
      type: "string",
      description:
        "Filter by production/branch/deployment. Repeatable via comma.",
    },
    deployment: {
      type: "string",
      description: "8-hex deploy id — scopes to that single deployment preview.",
    },
    branch: {
      type: "string",
      description: "Branch name — scopes to that branch preview.",
    },
    level: {
      type: "string",
      description:
        "Filter by console level (error,warn,...). Entry needs at least one matching log line.",
    },
    search: {
      type: "string",
      description:
        "Substring match against console messages, exceptions, and request URLs.",
    },
    limit: {
      type: "string",
      description: "Max entries to print. Default 100, max 1000.",
    },
    follow: {
      type: "boolean",
      description:
        "Live tail via WebSocket. Prints recent context first, then streams new entries until Ctrl+C.",
    },
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const token = getToken();
    if (!token) {
      if (jsonMode) jsonOutput({ ok: false, error: "not_authenticated" }, 1, AUTH_BREADCRUMBS);
      consola.error("Not authenticated. Run `creek login` first.");
      process.exit(1);
    }

    const projectSlug = await resolveProjectSlug(args.project as string | undefined, jsonMode);

    const client = new CreekClient(getApiUrl(), token);
    const filters: LogQueryFilters = {
      ...(args.since ? { since: args.since as string } : {}),
      ...(args.until ? { until: args.until as string } : {}),
      ...(args.deployment ? { deployment: args.deployment as string } : {}),
      ...(args.branch ? { branch: args.branch as string } : {}),
      ...(args.search ? { search: args.search as string } : {}),
      ...(args.limit ? { limit: Number(args.limit) } : {}),
      ...(args.outcome
        ? { outcomes: parseList(args.outcome as string) as LogEntry["outcome"][] }
        : {}),
      ...(args["script-type"]
        ? {
            scriptTypes: parseList(
              args["script-type"] as string,
            ) as LogEntry["scriptType"][],
          }
        : {}),
      ...(args.level
        ? { levels: parseList(args.level as string) as LogEntry["logs"][number]["level"][] }
        : {}),
    };

    let response;
    try {
      response = await client.getLogs(projectSlug, filters);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (jsonMode) jsonOutput({ ok: false, error: "logs_failed", message: msg }, 1, []);
      consola.error(`Failed to read logs: ${msg}`);
      process.exit(1);
    }

    if (jsonMode) {
      // ndjson — easy to pipe to jq
      for (const entry of response.entries) {
        process.stdout.write(JSON.stringify(entry) + "\n");
      }
      if (response.truncated) {
        process.stderr.write(
          `# truncated — more entries match. Refine --since/--limit to narrow.\n`,
        );
      }
      return;
    }

    if (response.entries.length === 0 && !args.follow) {
      consola.info("No log entries match the query.");
      return;
    }

    // Human output: oldest at top so the latest entry is closest to the prompt.
    const ordered = [...response.entries].reverse();
    for (const entry of ordered) {
      printEntry(entry);
    }

    if (response.truncated && !args.follow) {
      consola.warn(
        `Truncated to ${response.entries.length} entries — refine --since/--limit to see more.`,
      );
    }

    if (args.follow) {
      // Track the newest historical timestamp so we can drop any
      // duplicates that the WS would otherwise replay (R2 → realtime
      // race window — the same event can appear on both within a
      // ~second of being captured).
      const seenAfter = response.entries.length > 0
        ? Math.max(...response.entries.map((e) => e.timestamp))
        : 0;
      await follow(client, projectSlug, filters, seenAfter, jsonMode);
    }
  },
});

/**
 * Live tail via WebSocket. Mints a 5-min token via control-plane,
 * connects to realtime-worker, and prints incoming `type: "log"`
 * messages through the same printEntry path used for historical mode.
 *
 * Reconnect: realtime-worker drops the connection on any 5xx upstream
 * (DO eviction, DO error, etc.). We retry with capped exponential
 * backoff, re-mint the token (it could have expired during downtime).
 *
 * Token refresh: a single token is good for 5 min. For long-running
 * tails we re-mint at 4 min — well before expiry — to avoid a
 * mid-window 401 race with the WS handshake.
 *
 * Filter parity: the same client-side filter we'd apply to historical
 * entries is applied to live entries too. Realtime push doesn't know
 * about query filters; we filter here so `--outcome exception
 * --follow` shows only exceptions.
 */
async function follow(
  client: CreekClient,
  projectSlug: string,
  filters: LogQueryFilters,
  initialSeenAfter: number,
  jsonMode: boolean,
): Promise<void> {
  if (!jsonMode) {
    consola.info(
      `Live tail — Ctrl+C to exit. Filtering: ${describeFilters(filters)}`,
    );
  }

  let seenAfter = initialSeenAfter;
  let stopped = false;
  process.on("SIGINT", () => {
    stopped = true;
    if (!jsonMode) {
      process.stderr.write("\n");
      consola.info("Stopped.");
    }
    process.exit(0);
  });

  const TOKEN_REFRESH_MS = 4 * 60 * 1000;
  let backoffMs = 500;
  const BACKOFF_MAX_MS = 15_000;

  while (!stopped) {
    let mintedAt: number;
    let wsUrl: string;
    try {
      const minted = await client.getLogsWsToken(projectSlug);
      mintedAt = Date.now();
      wsUrl = minted.wsUrl;
    } catch (err) {
      if (stopped) return;
      const msg = err instanceof Error ? err.message : String(err);
      if (jsonMode) process.stderr.write(`# ws-token failed: ${msg}\n`);
      else consola.warn(`Failed to mint subscribe token: ${msg}. Retrying in ${Math.round(backoffMs / 1000)}s.`);
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
      continue;
    }

    const ws = new WebSocket(wsUrl);
    let closed = false;
    let refreshTimer: NodeJS.Timeout | null = null;

    await new Promise<void>((resolve) => {
      ws.on("open", () => {
        backoffMs = 500; // reset on successful connect
        // Force a clean reconnect just before token expiry.
        const elapsed = Date.now() - mintedAt;
        const remaining = Math.max(5_000, TOKEN_REFRESH_MS - elapsed);
        refreshTimer = setTimeout(() => {
          if (!closed) {
            try { ws.close(1000, "token refresh"); } catch { /* already closed */ }
          }
        }, remaining);
      });

      ws.on("message", (data) => {
        let parsed: { type?: string; entry?: LogEntry };
        try {
          parsed = JSON.parse(data.toString()) as { type?: string; entry?: LogEntry };
        } catch {
          return;
        }
        if (parsed.type !== "log" || !parsed.entry) return;
        const entry = parsed.entry;
        // Skip duplicates the historical R2 read already showed.
        if (entry.timestamp <= seenAfter) return;
        // Apply client-side filters so flags work in --follow mode too.
        if (!matchesClientSide(entry, filters)) return;
        seenAfter = Math.max(seenAfter, entry.timestamp);
        if (jsonMode) {
          process.stdout.write(JSON.stringify(entry) + "\n");
        } else {
          printEntry(entry);
        }
      });

      ws.on("close", () => {
        closed = true;
        if (refreshTimer) clearTimeout(refreshTimer);
        resolve();
      });

      ws.on("error", () => {
        // The "close" event will fire after this; resolve happens there.
      });
    });

    if (stopped) return;
    // Brief backoff before reconnect — only meaningful if the close
    // wasn't from our own token-refresh timer.
    await sleep(backoffMs);
    backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function resolveProjectSlug(
  override: string | undefined,
  jsonMode: boolean,
): Promise<string> {
  if (override) return override;
  let resolved: ResolvedConfig;
  try {
    resolved = resolveConfig(process.cwd());
  } catch (err) {
    if (err instanceof ConfigNotFoundError) {
      if (jsonMode)
        jsonOutput(
          { ok: false, error: "no_project", message: "No project config in cwd" },
          1,
          NO_PROJECT_BREADCRUMBS,
        );
      consola.error("No project config in cwd. Pass --project <slug>.");
      process.exit(1);
    }
    throw err;
  }
  return resolved.projectName;
}

function parseList(input: string): string[] {
  return input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const COLOR = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

function color(s: string, c: keyof typeof COLOR): string {
  return process.stdout.isTTY ? `${COLOR[c]}${s}${COLOR.reset}` : s;
}

function printEntry(entry: LogEntry): void {
  const ts = new Date(entry.timestamp).toISOString().replace("T", " ").slice(0, 19);
  const outcomeColor: keyof typeof COLOR =
    entry.outcome === "ok"
      ? "gray"
      : entry.outcome === "exception"
        ? "red"
        : "yellow";
  const status = entry.request?.status;
  const statusStr = status === undefined
    ? ""
    : status >= 500
      ? color(String(status), "red")
      : status >= 400
        ? color(String(status), "yellow")
        : color(String(status), "green");

  const variant =
    entry.scriptType === "production"
      ? ""
      : entry.scriptType === "branch"
        ? ` [branch ${entry.branch}]`
        : ` [deploy ${entry.deployId}]`;

  const headline = [
    color(ts, "dim"),
    color(entry.outcome, outcomeColor),
    entry.request?.method ?? "—",
    entry.request?.url
      ? new URL(entry.request.url).pathname + new URL(entry.request.url).search
      : "—",
    statusStr,
    color(variant, "dim"),
  ]
    .filter(Boolean)
    .join(" ");
  process.stdout.write(headline + "\n");

  for (const log of entry.logs) {
    const levelColor: keyof typeof COLOR =
      log.level === "error" ? "red" : log.level === "warn" ? "yellow" : "cyan";
    const msg = log.message
      .map((m) => (typeof m === "string" ? m : safeStringify(m)))
      .join(" ");
    process.stdout.write(`  ${color(log.level.padEnd(5), levelColor)} ${msg}\n`);
  }
  for (const ex of entry.exceptions) {
    process.stdout.write(
      `  ${color("exc", "red")} ${color(ex.name, "red")}: ${ex.message}\n`,
    );
  }
}

// safeStringify lives in logs-filter.js (re-exported for nested
// console.log message rendering in printEntry below).
const safeStringify = ssExport;
