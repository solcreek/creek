import { defineCommand } from "citty";
import consola from "consola";
import {
  CreekClient,
  resolveConfig,
  ConfigNotFoundError,
  type MetricsResponse,
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

const VALID_PERIODS = ["1h", "6h", "24h", "7d", "30d"] as const;
type Period = (typeof VALID_PERIODS)[number];

/**
 * `creek metrics` — read project traffic + error aggregates from the
 * control-plane metrics endpoint (Analytics Engine + zone GraphQL).
 *
 * Auth: requires `creek login`. Server enforces tenant isolation from
 * the session — the CLI passes only the project slug.
 *
 * Output shape matches the Dashboard Analytics tab: total requests
 * (including edge-cache hits), worker invocations, error count, and
 * three breakdowns (HTTP method, scriptType, statusBucket). Live p50/
 * p99 CPU times aren't exposed here yet; they live in the Workers
 * GraphQL subset the Dashboard reads separately.
 *
 * Pair with `--json` to pipe into reports / dashboards.
 */
export const metricsCommand = defineCommand({
  meta: {
    name: "metrics",
    description:
      "Read request + error metrics for a project. One-shot query — pair with --json for agent use or `| jq` piping.",
  },
  args: {
    project: {
      type: "string",
      description: "Project slug. Defaults to creek.toml in cwd.",
    },
    period: {
      type: "string",
      description: `Time window. One of: ${VALID_PERIODS.join(", ")}. Default: 24h`,
    },
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const token = getToken();
    if (!token) {
      if (jsonMode)
        jsonOutput({ ok: false, error: "not_authenticated" }, 1, AUTH_BREADCRUMBS);
      consola.error("Not authenticated. Run `creek login` first.");
      process.exit(1);
    }

    const projectSlug = await resolveProjectSlug(
      args.project as string | undefined,
      jsonMode,
    );

    const period = validatePeriod(args.period as string | undefined, jsonMode);

    const client = new CreekClient(getApiUrl(), token);
    let response: MetricsResponse;
    try {
      response = await client.getMetrics(projectSlug, period);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (jsonMode)
        jsonOutput({ ok: false, error: "metrics_failed", message: msg }, 1, []);
      consola.error(`Failed to read metrics: ${msg}`);
      process.exit(1);
    }

    if (jsonMode) {
      jsonOutput(
        { ok: true, project: projectSlug, ...response },
        0,
        [
          {
            command: `creek logs --project ${projectSlug} --since ${period}`,
            description: "Tail logs for the same window",
          },
        ],
      );
      return;
    }

    printHuman(projectSlug, response);
  },
});

function validatePeriod(
  raw: string | undefined,
  jsonMode: boolean,
): Period {
  if (!raw) return "24h";
  if ((VALID_PERIODS as readonly string[]).includes(raw)) return raw as Period;
  const message = `Invalid --period: ${raw}. Valid: ${VALID_PERIODS.join(", ")}`;
  if (jsonMode)
    jsonOutput({ ok: false, error: "invalid_period", message }, 1, []);
  consola.error(message);
  process.exit(1);
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

// ─── Human output ────────────────────────────────────────────────────────

const COLOR = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

function tty(): boolean {
  return process.stdout.isTTY ?? false;
}

function c(s: string, color: keyof typeof COLOR): string {
  return tty() ? `${COLOR[color]}${s}${COLOR.reset}` : s;
}

function fmtNumber(n: number): string {
  if (n === 0) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function fmtPct(n: number, total: number): string {
  if (total === 0) return "0%";
  return `${((n / total) * 100).toFixed(1)}%`;
}

function printHuman(slug: string, r: MetricsResponse): void {
  const { totals } = r;
  const cachePct = fmtPct(totals.cachedReqs, totals.reqs);
  const errPct = fmtPct(totals.errs, totals.invocations);

  consola.log("");
  consola.log(`  ${c("⬡ creek metrics", "bold")}  ${c(`${slug} · ${r.period}`, "dim")}`);
  consola.log("");
  consola.log(`  Requests:      ${c(fmtNumber(totals.reqs), "bold")}`);
  consola.log(
    `  Cache hits:    ${fmtNumber(totals.cachedReqs)} ${c(`(${cachePct})`, "dim")}`,
  );
  consola.log(
    `  Invocations:   ${fmtNumber(totals.invocations)} ${c("worker ran", "dim")}`,
  );
  const errColor = totals.errs > 0 ? "red" : "green";
  consola.log(
    `  Errors:        ${c(fmtNumber(totals.errs), errColor)} ${c(`(${errPct} of invocations)`, "dim")}`,
  );
  consola.log("");

  printBreakdown("Method", r.breakdowns.method);
  printBreakdown("Script type", r.breakdowns.scriptType);
  printBreakdown("Status bucket", r.breakdowns.statusBucket);
}

function printBreakdown(
  title: string,
  rows: Array<{ label: string; reqs: number; errs: number }>,
): void {
  if (rows.length === 0) return;
  consola.log(`  ${c(title, "dim")}`);
  const total = rows.reduce((sum, r) => sum + r.reqs, 0);
  const top = rows.slice(0, 5);
  for (const row of top) {
    const pct = fmtPct(row.reqs, total);
    const label = row.label || c("(empty)", "gray");
    const errBadge = row.errs > 0 ? c(` ${row.errs} err`, "red") : "";
    consola.log(
      `    ${label.padEnd(12)} ${fmtNumber(row.reqs).padStart(8)} ${c(pct.padStart(6), "dim")}${errBadge}`,
    );
  }
  if (rows.length > top.length) {
    consola.log(
      `    ${c(`+${rows.length - top.length} more`, "dim")}`,
    );
  }
  consola.log("");
}
