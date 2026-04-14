import { defineCommand } from "citty";
import consola from "consola";
import { CreekClient } from "@solcreek/sdk";
import { getToken, getApiUrl } from "../utils/config.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfig } from "@solcreek/sdk";
import { globalArgs, resolveJsonMode, jsonOutput, AUTH_BREADCRUMBS, NO_PROJECT_BREADCRUMBS } from "../utils/output.js";

function resolveSlug(argSlug: string | undefined, jsonMode: boolean): string {
  if (argSlug) return argSlug;
  const configPath = join(process.cwd(), "creek.toml");
  if (!existsSync(configPath)) {
    if (jsonMode) {
      jsonOutput(
        {
          ok: false,
          error: "no_project",
          message: "No creek.toml found. Use --project <slug> or run from a project directory.",
        },
        1,
        NO_PROJECT_BREADCRUMBS,
      );
    }
    consola.error("No creek.toml found. Use --project <slug> or run from a project directory.");
    process.exit(1);
  }
  return parseConfig(readFileSync(configPath, "utf-8")).project.name;
}

// --- List (default behaviour) ---

const deploymentsList = defineCommand({
  meta: {
    name: "list",
    description: "List recent deployments",
  },
  args: {
    project: {
      type: "string",
      description: "Project slug (default: from creek.toml)",
      required: false,
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

    const slug = resolveSlug(args.project, jsonMode);
    const client = new CreekClient(getApiUrl(), token);

    let deployments;
    try {
      deployments = await client.listDeployments(slug);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to list deployments";
      if (jsonMode) jsonOutput({ ok: false, error: "api_error", message: msg }, 1);
      consola.error(msg);
      process.exit(1);
    }

    if (jsonMode) {
      const crumbs = deployments.length > 0
        ? [
            { command: `creek rollback --project ${slug}`, description: "Rollback to previous deployment" },
            { command: `creek status`, description: "Check current project status" },
          ]
        : [{ command: `creek deploy`, description: "Create first deployment" }];
      jsonOutput({ ok: true, project: slug, deployments }, 0, crumbs);
    }

    if (deployments.length === 0) {
      consola.info(`No deployments for ${slug}. Run \`creek deploy\` to create one.`);
      return;
    }

    consola.info(`${deployments.length} deployment(s) for ${slug}\n`);
    for (const d of deployments) {
      const status = d.status === "active" ? "\x1b[32mactive\x1b[0m" : d.status;
      const branch = d.branch ? ` (${d.branch})` : "";
      const age = timeAgo(d.created_at);
      consola.log(`  ${d.id.slice(0, 8)}  ${status}  ${age}${branch}`);
    }
  },
});

// --- Logs subcommand ---

const deploymentsLogs = defineCommand({
  meta: {
    name: "logs",
    description:
      "Read the build log for a deployment (production + branch + preview). Use --project to target a different project; --raw to print ndjson for piping. Designed so AI coding agents can diagnose failed deploys without a human relay.",
  },
  args: {
    id: {
      type: "positional",
      description: "Deployment id (8-char short id or full uuid)",
      required: true,
    },
    project: {
      type: "string",
      description: "Project slug (default: from creek.toml)",
      required: false,
    },
    raw: {
      type: "boolean",
      description: "Print raw ndjson lines instead of step-grouped output",
      default: false,
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

    const slug = resolveSlug(args.project, jsonMode);
    const client = new CreekClient(getApiUrl(), token);

    // If the user passed a short id, look up the full uuid. GET endpoint
    // requires the full id.
    let fullId = args.id;
    if (fullId.length < 36) {
      try {
        const list = await client.listDeployments(slug);
        const match = list.find((d) => d.id.startsWith(fullId));
        if (!match) {
          if (jsonMode) jsonOutput({ ok: false, error: "not_found", message: `No deployment matches id prefix '${fullId}'` }, 1);
          consola.error(`No deployment matches id prefix '${fullId}'`);
          process.exit(1);
        }
        fullId = match.id;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to resolve deployment id";
        if (jsonMode) jsonOutput({ ok: false, error: "api_error", message: msg }, 1);
        consola.error(msg);
        process.exit(1);
      }
    }

    let log;
    try {
      log = await client.getBuildLog(slug, fullId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to read build log";
      if (jsonMode) jsonOutput({ ok: false, error: "api_error", message: msg }, 1);
      consola.error(msg);
      process.exit(1);
    }

    if (jsonMode) {
      jsonOutput({ ok: true, deploymentId: fullId, ...log }, 0);
    }

    if (!log.metadata) {
      consola.info(log.message ?? "No build log available for this deployment.");
      return;
    }

    if (args.raw) {
      for (const e of log.entries) consola.log(JSON.stringify(e));
      return;
    }

    // Grouped printout: step ▸ lines. Headers carry status + duration + CK-code.
    const grouped = groupByStep(log.entries);
    const headerLabels: Record<string, string> = {
      clone: "Clone",
      detect: "Detect",
      install: "Install",
      build: "Build",
      bundle: "Bundle",
      upload: "Upload",
      provision: "Provision",
      activate: "Activate",
      cleanup: "Cleanup",
    };
    const order = [
      "clone",
      "detect",
      "install",
      "build",
      "bundle",
      "upload",
      "provision",
      "activate",
      "cleanup",
    ];

    const meta = log.metadata;
    const statusColour =
      meta.status === "success" ? "\x1b[32m" :
      meta.status === "failed" ? "\x1b[31m" :
      "\x1b[33m";
    consola.log(`\n  deployment ${fullId.slice(0, 8)}  ${statusColour}${meta.status}\x1b[0m`);
    if (meta.errorCode) consola.log(`  error code: ${meta.errorCode}`);
    if (meta.errorStep) consola.log(`  failed at: ${meta.errorStep}`);
    consola.log("");

    for (const step of order) {
      const lines = grouped.get(step);
      if (!lines) continue;
      const header = headerLabels[step] ?? step;
      const duration = stepDuration(lines);
      const failed = meta.status === "failed" && meta.errorStep === step;
      const icon = failed ? "\x1b[31m✗\x1b[0m" : "\x1b[32m✓\x1b[0m";
      const label = failed ? `\x1b[31m${header}\x1b[0m` : header;
      consola.log(`  ${icon}  ${label}${duration ? ` (${duration})` : ""}`);
      for (const l of lines) {
        const lineColour =
          l.level === "error" || l.level === "fatal" ? "\x1b[31m" :
          l.level === "warn" ? "\x1b[33m" :
          "\x1b[90m";
        consola.log(`       ${lineColour}${l.msg}\x1b[0m`);
      }
    }

    if (meta.truncated) {
      consola.warn("  (log was truncated at 5MB / 200k lines)");
    }
  },
});

function groupByStep<T extends { step: string }>(entries: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const e of entries) {
    let bucket = map.get(e.step);
    if (!bucket) {
      bucket = [];
      map.set(e.step, bucket);
    }
    bucket.push(e);
  }
  return map;
}

function stepDuration(lines: Array<{ ts: number }>): string | null {
  if (lines.length < 2) return null;
  const sorted = [...lines].sort((a, b) => a.ts - b.ts);
  const ms = sorted[sorted.length - 1].ts - sorted[0].ts;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

// --- Public export ---

export const deploymentsCommand = defineCommand({
  meta: {
    name: "deployments",
    description: "List deployments and read build logs",
  },
  args: {
    project: {
      type: "string",
      description: "Project slug (default: from creek.toml)",
      required: false,
    },
    ...globalArgs,
  },
  subCommands: {
    list: deploymentsList,
    logs: deploymentsLogs,
  },
  // Default behaviour (no subcommand) = list. Citty resolves
  // subcommands first, so this only fires when the user types
  // `creek deployments` with no trailing verb.
  async run(ctx) {
    const run = deploymentsList.run;
    if (!run) return;
    return run(ctx as Parameters<NonNullable<typeof deploymentsList.run>>[0]);
  },
});

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
