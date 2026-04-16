import { defineCommand } from "citty";
import consola from "consola";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  runDoctor,
  type DoctorReport,
  type Finding,
} from "@solcreek/sdk";
import { buildDoctorContext } from "../utils/doctor-context.js";
import { CreekClient } from "@solcreek/sdk";
import { getToken, getApiUrl } from "../utils/config.js";
import {
  globalArgs,
  resolveJsonMode,
  jsonOutput,
  AUTH_BREADCRUMBS,
} from "../utils/output.js";

/**
 * `creek doctor` — pre-deploy sanity check.
 *
 * Runs the SDK rule engine against the current project, reports
 * findings. Exits 0 if ok, 1 if any error-severity finding fires.
 *
 * This is the one command designed for LLM agents to invoke before
 * `creek deploy`. With `--json` the output is ndjson-adjacent (pretty
 * JSON, but parseable), letting an agent look up fixes by stable
 * CK-* codes and apply them without re-reading the source.
 */
export const doctorCommand = defineCommand({
  meta: {
    name: "doctor",
    description:
      "Analyze the project for pre-deploy issues — missing build output, deprecated config keys, Workers-incompatible deps, portability leaks.",
  },
  args: {
    path: {
      type: "positional",
      description: "Project directory to analyze. Defaults to cwd.",
      required: false,
    },
    last: {
      type: "boolean",
      description:
        "Diagnose the most recent FAILED deployment instead of running pre-deploy checks. Fetches the build log and matches errorCode against the CK-* fix table.",
      default: false,
    },
    project: {
      type: "string",
      description: "Project slug for --last (default: read from creek.toml in cwd)",
      required: false,
    },
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);

    if (args.last) {
      await runLastFailureDiagnosis({
        project: args.project,
        cwd: resolve((args.path as string | undefined) ?? process.cwd()),
        jsonMode,
      });
      return;
    }

    const cwd = resolve((args.path as string | undefined) ?? process.cwd());
    const ctx = buildDoctorContext(cwd);
    const report = runDoctor(ctx);

    if (jsonMode) {
      jsonOutput(
        {
          ok: report.ok,
          cwd,
          archetype: report.archetype,
          summary: report.summary,
          findings: report.findings,
        },
        report.ok ? 0 : 1,
      );
      return;
    }

    printHuman(cwd, report);
    if (!report.ok) process.exit(1);
  },
});

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// ─── Human output ───────────────────────────────────────────────────────

const COLOR = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
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

function printHuman(cwd: string, report: DoctorReport): void {
  consola.log("");
  consola.log(`  ${c("⬡ creek doctor", "bold")}  ${c(cwd, "dim")}`);
  consola.log(`  ${c("archetype:", "dim")} ${report.archetype ?? "unknown"}`);
  consola.log("");

  if (report.findings.length === 0) {
    consola.log(`  ${c("✓", "green")} No issues detected. Deploy is good to go.`);
    consola.log("");
    return;
  }

  const order: Finding["severity"][] = ["error", "warn", "info"];
  const grouped = groupBy(report.findings, (f) => f.severity);
  for (const sev of order) {
    const bucket = grouped.get(sev) ?? [];
    for (const f of bucket) {
      printFinding(f);
    }
  }

  const parts: string[] = [];
  if (report.summary.error) parts.push(c(`${report.summary.error} error${s(report.summary.error)}`, "red"));
  if (report.summary.warn) parts.push(c(`${report.summary.warn} warning${s(report.summary.warn)}`, "yellow"));
  if (report.summary.info) parts.push(c(`${report.summary.info} info`, "cyan"));
  consola.log(`  Summary: ${parts.join(", ")}`);
  consola.log("");
}

function printFinding(f: Finding): void {
  const icon =
    f.severity === "error" ? c("✗", "red")
      : f.severity === "warn" ? c("⚠", "yellow")
        : c("ℹ", "cyan");
  consola.log(`  ${icon} ${c(f.title, "bold")}  ${c(`[${f.code}]`, "gray")}`);
  for (const line of f.detail.split("\n")) {
    consola.log(`     ${c(line, "dim")}`);
  }
  consola.log(`     ${c("→ fix:", "cyan")}`);
  for (const line of f.fix.split("\n")) {
    consola.log(`       ${line}`);
  }
  if (f.references?.length) {
    consola.log(`     ${c("→ refs:", "dim")} ${f.references.join(", ")}`);
  }
  consola.log("");
}

function groupBy<T, K>(arr: T[], key: (v: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const v of arr) {
    const k = key(v);
    const bucket = out.get(k) ?? [];
    bucket.push(v);
    out.set(k, bucket);
  }
  return out;
}

function s(n: number): string {
  return n === 1 ? "" : "s";
}

// ─── `--last` failure diagnosis ─────────────────────────────────────────
//
// CK-code → one-line fix hint. Source of truth in product terms is
// skills/creek/references/diagnosis.md; the MCP server's get_build_log
// tool carries the same mapping (packages/mcp-server/src/tools.ts
// CK_FIX_HINTS). Keep all three in sync when adding a new CK-* rule.

const CK_FIX_HINTS: Record<string, string> = {
  "CK-NO-CONFIG":
    "Run `creek init` to scaffold a creek.toml, or cd to a directory that contains creek.toml / wrangler.* / package.json / index.html.",
  "CK-NOTHING-TO-DEPLOY":
    "Run the project's build command so there's output in [build].output, or set [build].command in creek.toml if the project needs one.",
  "CK-DB-DUAL-DRIVER-SPLIT":
    "Consolidate the split db.local.ts + db.prod.ts files. Share schema.ts and routes.ts; keep only thin boot files (server/local.ts for dev, server/worker.ts for prod) that differ in driver setup. See examples/vite-react-drizzle.",
  "CK-SYNC-SQLITE":
    "better-sqlite3 is synchronous and won't run on Workers. Migrate to an async ORM with a D1 adapter — Drizzle or Kysely are the drop-in paths.",
  "CK-PRISMA-SQLITE":
    "Prisma's SQLite datasource isn't supported on Cloudflare Workers. Switch to Drizzle or Kysely with a D1 adapter.",
  "CK-RUNTIME-LOCKIN":
    "The project imports from @solcreek/* runtime packages. For a portable build that can deploy outside Creek, replace those with driver-level imports (e.g. drizzle-orm/d1 instead of creek's db re-export).",
  "CK-CONFIG-OVERLAP":
    "Both creek.toml and wrangler.* are present. Pick one as the source of truth — creek.toml is preferred; remove wrangler.* or update any shared fields to match.",
};

function suggestFix(code: string | null): string | null {
  if (!code) return null;
  return CK_FIX_HINTS[code] ?? null;
}

async function runLastFailureDiagnosis(opts: {
  project: string | undefined;
  cwd: string;
  jsonMode: boolean;
}): Promise<void> {
  const token = getToken();
  if (!token) {
    if (opts.jsonMode) {
      jsonOutput(
        { ok: false, error: "not_authenticated" },
        1,
        AUTH_BREADCRUMBS,
      );
    }
    consola.error("Not authenticated. Run `creek login` first.");
    process.exit(1);
  }

  // Resolve project slug — prefer --project, fall back to creek.toml
  let slug = opts.project;
  if (!slug) {
    const creekToml = join(opts.cwd, "creek.toml");
    if (existsSync(creekToml)) {
      const raw = safeRead(creekToml);
      const match = raw?.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
      if (match) slug = match[1];
    }
  }
  if (!slug) {
    const msg =
      "No project slug. Pass --project <slug> or run from a directory with creek.toml.";
    if (opts.jsonMode) jsonOutput({ ok: false, error: "no_project", message: msg }, 1);
    consola.error(msg);
    process.exit(1);
  }

  const client = new CreekClient(getApiUrl(), token);

  // Find the most recent failed deployment.
  let deployments;
  try {
    deployments = await client.listDeployments(slug);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to list deployments";
    if (opts.jsonMode) jsonOutput({ ok: false, error: "api_error", message: msg }, 1);
    consola.error(msg);
    process.exit(1);
  }

  const failed = deployments.find((d) => d.status === "failed");
  if (!failed) {
    const msg = `No failed deployments for ${slug}. Last ${deployments.length} deploys succeeded.`;
    if (opts.jsonMode) jsonOutput({ ok: true, project: slug, failed: null, message: msg }, 0);
    consola.log("");
    consola.log(`  ${c("⬡ creek doctor --last", "bold")}  ${c(slug, "dim")}`);
    consola.log(`  ${c("✓", "green")} ${msg}`);
    consola.log("");
    return;
  }

  // Pull the build log.
  let log;
  try {
    log = await client.getBuildLog(slug, failed.id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to read build log";
    if (opts.jsonMode) jsonOutput({ ok: false, error: "api_error", message: msg }, 1);
    consola.error(msg);
    process.exit(1);
  }

  const meta = log.metadata;
  const errorCode = meta?.errorCode ?? null;
  const errorStep = meta?.errorStep ?? null;
  const fix = suggestFix(errorCode);

  if (opts.jsonMode) {
    jsonOutput(
      {
        ok: true,
        project: slug,
        failed: {
          id: failed.id,
          version: (failed as unknown as { version?: number }).version,
          branch: failed.branch,
          commitSha: failed.commit_sha,
          errorCode,
          errorStep,
          suggestedFix: fix,
          failedStep: failed.failed_step,
          errorMessage: failed.error_message,
        },
      },
      0,
      [
        {
          command: `creek deployments logs ${failed.id.slice(0, 8)} --json`,
          description: "Read the full build log",
        },
        { command: `creek deploy --json`, description: "Redeploy after fixing" },
      ],
    );
    return;
  }

  // Human output.
  consola.log("");
  consola.log(`  ${c("⬡ creek doctor --last", "bold")}  ${c(slug, "dim")}`);
  consola.log(
    `  ${c("failed deploy:", "dim")} ${failed.id.slice(0, 8)}${failed.branch ? ` (${failed.branch})` : ""}`,
  );
  consola.log("");

  if (errorCode) {
    consola.log(`  ${c("✗", "red")} ${c(errorCode, "bold")}  ${c(`at step: ${errorStep ?? "unknown"}`, "gray")}`);
  } else if (errorStep) {
    consola.log(`  ${c("✗", "red")} Failed at step: ${c(errorStep, "bold")}`);
  } else {
    consola.log(`  ${c("✗", "red")} Deploy failed — no structured errorCode available.`);
  }
  consola.log("");

  if (fix) {
    consola.log(`  ${c("→ fix:", "cyan")}`);
    for (const line of fix.split("\n")) consola.log(`    ${line}`);
    consola.log("");
  } else if (errorCode) {
    consola.log(
      `  ${c("→ no mapped fix for", "dim")} ${c(errorCode, "bold")}${c(". Inspect the full log:", "dim")}`,
    );
    consola.log(`    creek deployments logs ${failed.id.slice(0, 8)}`);
    consola.log("");
  } else {
    consola.log(`  ${c("→ inspect the full log:", "cyan")}`);
    consola.log(`    creek deployments logs ${failed.id.slice(0, 8)}`);
    consola.log("");
  }

  if (failed.error_message) {
    consola.log(`  ${c("error message:", "dim")}`);
    for (const line of failed.error_message.split("\n").slice(0, 8)) {
      consola.log(`    ${c(line, "gray")}`);
    }
    consola.log("");
  }
}
