import { defineCommand } from "citty";
import consola from "consola";
import {
  CreekApiError,
  CreekClient,
  type DeploymentView,
  type WaitForDeploymentResult,
} from "@solcreek/sdk";
import { getToken, getApiUrl } from "../utils/config.js";
import {
  globalArgs,
  resolveJsonMode,
  jsonOutput,
  jsonLine,
  AUTH_BREADCRUMBS,
} from "../utils/output.js";
import { apiErrorFields, apiErrorHints } from "../utils/api-error.js";
import {
  pasteableBreadcrumbs,
  projectArg,
  projectBreadcrumbs,
  resolveProject,
} from "../utils/command-context.js";
import {
  deploymentFollowCrumbs,
  humanCommand,
  printDeployment,
  waitCommand,
} from "../utils/deployment-follow.js";
import { formatWaited, parseWaitDuration } from "./deploy.js";
import { isNetworkFailure } from "../utils/request-ledger.js";

// --- List (default behaviour) ---

const deploymentsList = defineCommand({
  meta: {
    name: "list",
    destructive: false,
    description: "List recent deployments",
  },
  args: {
    ...projectArg,
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const token = getToken();

    if (!token) {
      if (jsonMode)
        jsonOutput(
          {
            ok: false,
            error: "not_authenticated",
            message: "Not authenticated. Run `creek login` first.",
          },
          1,
          AUTH_BREADCRUMBS,
        );
      consola.error("Not authenticated. Run `creek login` first.");
      process.exit(1);
    }

    const { slug, source: projectSource } = resolveProject(args.project, jsonMode);
    const client = new CreekClient(getApiUrl(), token);

    let deployments;
    try {
      deployments = await client.listDeployments(slug);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to list deployments";
      if (jsonMode)
        jsonOutput({ ok: false, error: "api_error", message: msg, ...apiErrorFields(err) }, 1);
      consola.error(msg);
      for (const hint of apiErrorHints(err)) consola.info(hint);
      process.exit(1);
    }

    if (jsonMode) {
      const crumbs =
        deployments.length > 0
          ? [
              {
                command: `creek rollback --project ${slug}`,
                description: "Rollback to previous deployment",
              },
              {
                command: `creek status --project ${slug}`,
                description: "Check current project status",
              },
            ]
          : [{ command: `creek deploy`, description: "Create first deployment" }];
      jsonOutput(
        { ok: true, project: slug, projectSource, deployments },
        0,
        projectBreadcrumbs(slug, crumbs),
      );
    }

    if (deployments.length === 0) {
      consola.info(`No deployments for ${slug}. Run \`creek deploy\` to create one.`);
      return;
    }

    consola.info(`${deployments.length} deployment(s) for ${slug}\n`);
    for (const d of deployments) {
      const status = d.status === "active" ? "\x1b[32mactive\x1b[0m" : d.status;
      const branch = d.branch ? ` (${d.branch})` : "";
      const age = timeAgo(d.createdAt);
      consola.log(`  ${d.id.slice(0, 8)}  ${status}  ${age}${branch}`);
    }
  },
});

// --- Logs subcommand ---

const deploymentsLogs = defineCommand({
  meta: {
    name: "logs",
    destructive: false,
    description:
      "Read the build log for a deployment (production + branch + preview). Use --project to target a different project; --raw to print ndjson for piping. Designed so AI coding agents can diagnose failed deploys without a human relay.",
  },
  args: {
    id: {
      type: "positional",
      description: "Deployment id (8-char short id or full uuid)",
      required: true,
    },
    ...projectArg,
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
      if (jsonMode)
        jsonOutput(
          {
            ok: false,
            error: "not_authenticated",
            message: "Not authenticated. Run `creek login` first.",
          },
          1,
          AUTH_BREADCRUMBS,
        );
      consola.error("Not authenticated. Run `creek login` first.");
      process.exit(1);
    }

    const { slug, source: projectSource } = resolveProject(args.project, jsonMode);
    const client = new CreekClient(getApiUrl(), token);

    // If the user passed a short id, look up the full uuid. GET endpoint
    // requires the full id.
    let fullId = args.id;
    if (fullId.length < 36) {
      try {
        const list = await client.listDeployments(slug);
        const match = list.find((d) => d.id.startsWith(fullId));
        if (!match) {
          if (jsonMode)
            jsonOutput(
              {
                ok: false,
                error: "not_found",
                message: `No deployment matches id prefix '${fullId}'`,
              },
              1,
            );
          consola.error(`No deployment matches id prefix '${fullId}'`);
          process.exit(1);
        }
        fullId = match.id;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to resolve deployment id";
        if (jsonMode)
          jsonOutput({ ok: false, error: "api_error", message: msg, ...apiErrorFields(err) }, 1);
        consola.error(msg);
        for (const hint of apiErrorHints(err)) consola.info(hint);
        process.exit(1);
      }
    }

    let log;
    try {
      log = await client.getBuildLog(slug, fullId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to read build log";
      if (jsonMode)
        jsonOutput({ ok: false, error: "api_error", message: msg, ...apiErrorFields(err) }, 1);
      consola.error(msg);
      for (const hint of apiErrorHints(err)) consola.info(hint);
      process.exit(1);
    }

    if (jsonMode) {
      jsonOutput({ ok: true, project: slug, projectSource, deploymentId: fullId, ...log }, 0);
    }

    if (!log.metadata) {
      consola.info(log.message ?? "No build log available for this deployment.");
      return;
    }

    if (args.raw) {
      for (const e of log.entries) jsonLine(e as unknown as Record<string, unknown>);
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
      meta.status === "success" ? "\x1b[32m" : meta.status === "failed" ? "\x1b[31m" : "\x1b[33m";
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
          l.level === "error" || l.level === "fatal"
            ? "\x1b[31m"
            : l.level === "warn"
              ? "\x1b[33m"
              : "\x1b[90m";
        consola.log(`       ${lineColour}${l.msg}\x1b[0m`);
      }
    }

    if (meta.truncated) {
      consola.warn("  (log was truncated at 5MB / 200k lines)");
    }
  },
});

// --- Get / wait: follow one deployment to its result ---

/** A failed lookup: `not_found`, `ambiguous_id`, or `api_error` with the API's fields. */
function exitLookupError(jsonMode: boolean, err: unknown, slug: string): never {
  const msg = err instanceof Error ? err.message : "Failed to read the deployment";
  const code =
    err instanceof CreekApiError && ["not_found", "ambiguous_id", "invalid_id"].includes(err.code)
      ? err.code
      : "api_error";
  if (jsonMode)
    jsonOutput(
      { ok: false, error: code, message: msg, project: slug, ...apiErrorFields(err) },
      1,
      code === "api_error"
        ? []
        : pasteableBreadcrumbs(slug, [
            { command: "creek deployments --json", description: "List recent deployment ids" },
          ]),
    );
  consola.error(msg);
  for (const hint of apiErrorHints(err)) consola.info(hint);
  process.exit(1);
}

function requireToken(jsonMode: boolean): string {
  const token = getToken();
  if (!token) {
    // Same message and breadcrumbs as `deployments list` / `logs`.
    if (jsonMode)
      jsonOutput(
        {
          ok: false,
          error: "not_authenticated",
          message: "Not authenticated. Run `creek login` first.",
        },
        1,
        AUTH_BREADCRUMBS,
      );
    consola.error("Not authenticated. Run `creek login` first.");
    process.exit(1);
  }
  return token;
}

const deploymentsGet = defineCommand({
  meta: {
    name: "get",
    destructive: false,
    description:
      "Show one deployment: status, final (true once active, failed or cancelled), failedStep, errorCode/errorHint, url, commit and branch. Same fields as the MCP get_deployment tool.",
  },
  args: {
    id: {
      type: "positional",
      description: "Deployment id (8-char short id or full uuid)",
      required: true,
    },
    ...projectArg,
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const token = requireToken(jsonMode);
    const { slug, source: projectSource } = resolveProject(args.project, jsonMode);
    const client = new CreekClient(getApiUrl(), token);

    let view: DeploymentView;
    try {
      view = await client.getDeployment(slug, args.id);
    } catch (err) {
      exitLookupError(jsonMode, err, slug);
    }

    if (jsonMode) {
      jsonOutput({ ok: true, projectSource, ...view }, 0, deploymentFollowCrumbs(view));
    }
    printDeployment(view);
  },
});

const DEFAULT_WAIT = "2m";
const WAIT_POLL_MS = 2_000;

const deploymentsWait = defineCommand({
  meta: {
    name: "wait",
    destructive: false,
    description:
      "Wait until a deployment is final. Exits 0 when it is active; 1 with error deployment_failed (failedStep, errorCode, errorHint) or deployment_cancelled; 1 with error timeout and retryable: true when it is still running at --timeout — run it again.",
  },
  args: {
    id: {
      type: "positional",
      description: "Deployment id (8-char short id or full uuid)",
      required: true,
    },
    timeout: {
      type: "string",
      description: `How long to wait: 90s, 5m, 1h (default ${DEFAULT_WAIT}, max 60m)`,
      valueHint: "duration",
    },
    ...projectArg,
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const timeoutArg = (args.timeout as string | undefined) ?? DEFAULT_WAIT;
    const timeoutMs = parseWaitDuration(timeoutArg);
    if (timeoutMs === null) {
      const message = `Invalid --timeout '${timeoutArg}'. Use a duration such as 90s, 5m or 1h.`;
      if (jsonMode) jsonOutput({ ok: false, error: "invalid_timeout", message }, 1);
      consola.error(message);
      process.exit(1);
    }
    const token = requireToken(jsonMode);
    const { slug, source: projectSource } = resolveProject(args.project, jsonMode);
    const client = new CreekClient(getApiUrl(), token);

    let lastStatus: string | null = null;
    let result: WaitForDeploymentResult;
    try {
      result = await client.waitForDeployment(slug, args.id, {
        timeoutMs,
        intervalMs: WAIT_POLL_MS,
        onPoll: (v) => {
          if (!jsonMode && v.status !== lastStatus) {
            consola.info(`  ${v.deploymentId.slice(0, 8)}  ${v.status ?? "unknown"}`);
          }
          lastStatus = v.status;
        },
      });
    } catch (err) {
      // The SDK already retried transient failures until the deadline. A
      // network failure keeps the runner's api_unreachable classification
      // (retryable: a wait only reads); a server error is retryable too.
      if (isNetworkFailure(err)) throw err;
      if (err instanceof CreekApiError && (err.status >= 500 || err.status === 429)) {
        const message = `The API kept failing while waiting (${err.message}). Waiting only reads: run the wait again.`;
        if (jsonMode)
          jsonOutput(
            {
              ok: false,
              error: "api_error",
              message,
              retryable: true,
              project: slug,
              projectSource,
              deploymentId: args.id,
              lastStatus,
              ...apiErrorFields(err),
            },
            1,
            pasteableBreadcrumbs(slug, [
              { command: waitCommand(args.id), description: "Keep waiting for the deploy" },
            ]),
          );
        consola.error(message);
        process.exit(1);
      }
      exitLookupError(jsonMode, err, slug);
    }

    const waited = formatWaited(result.waitedMs);
    const view = result.view;
    if (result.timedOut || !view) {
      // A full id when the read resolved one; else what the caller passed.
      const id = view?.deploymentId ?? args.id;
      const message = `Deployment ${id} is still ${view?.status ?? "pending"} after ${formatWaited(timeoutMs)}. It has not failed; run the wait again.`;
      if (jsonMode)
        jsonOutput(
          {
            ok: false,
            error: "timeout",
            message,
            retryable: true,
            projectSource,
            ...(view ?? {
              project: slug,
              deploymentId: id,
              status: null,
              terminal: false,
              final: false,
            }),
            waitedMs: result.waitedMs,
          },
          1,
          pasteableBreadcrumbs(slug, [
            { command: waitCommand(id), description: "Keep waiting for the deploy to finish" },
            {
              command: `creek deployments logs ${id} --json`,
              description: "Read the build log so far",
            },
          ]),
        );
      consola.warn(message);
      consola.info(
        `  Keep waiting:  ${humanCommand(slug, `creek deployments wait ${id} --timeout 10m`)}`,
      );
      process.exit(1);
    }

    if (view.status === "active") {
      if (jsonMode)
        jsonOutput(
          { ok: true, projectSource, ...view, waitedMs: result.waitedMs },
          0,
          deploymentFollowCrumbs(view),
        );
      consola.success(`  Deployment ${view.deploymentId.slice(0, 8)} is active (${waited})`);
      printDeployment(view);
      return;
    }

    const failed = view.status === "failed";
    const message = failed
      ? `Deployment ${view.deploymentId} failed${view.failedStep ? ` at ${view.failedStep}` : ""}: ${view.errorMessage ?? "no message"}`
      : `Deployment ${view.deploymentId} was ${view.status}.`;
    if (jsonMode)
      jsonOutput(
        {
          ok: false,
          error: failed ? "deployment_failed" : "deployment_cancelled",
          message,
          projectSource,
          ...view,
          waitedMs: result.waitedMs,
        },
        1,
        deploymentFollowCrumbs(view),
      );
    consola.error(message);
    printDeployment(view);
    process.exit(1);
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

const DEPLOYMENTS_ARGS = {
  ...projectArg,
  ...globalArgs,
};

const DEPLOYMENTS_SUBCOMMANDS = {
  list: deploymentsList,
  get: deploymentsGet,
  wait: deploymentsWait,
  logs: deploymentsLogs,
};

/**
 * The subcommand `rawArgs` names, or null: the first bare token that is not
 * the value of an option (`--project get` names a project, not `get`), and
 * only when it is one of these subcommands' own keys (not `constructor`).
 * Exported for tests.
 */
export function namedSubcommand(
  rawArgs: readonly string[],
  args: Record<string, { type?: string; alias?: string | string[] }>,
  subCommands: Record<string, unknown>,
): string | null {
  const takesValue = new Set<string>();
  for (const [name, def] of Object.entries(args)) {
    if (def.type !== "string") continue;
    takesValue.add(`--${name}`);
    for (const a of ([] as string[]).concat(def.alias ?? [])) {
      takesValue.add(a.length === 1 ? `-${a}` : `--${a}`);
    }
  }
  for (let i = 0; i < rawArgs.length; i++) {
    const token = rawArgs[i];
    if (token === "--") return null;
    if (token.startsWith("-")) {
      if (!token.includes("=") && takesValue.has(token)) i++; // skip its value
      continue;
    }
    return Object.hasOwn(subCommands, token) ? token : null;
  }
  return null;
}

export const deploymentsCommand = defineCommand({
  meta: {
    name: "deployments",
    destructive: false,
    description: "List deployments, follow one to its result, and read build logs",
  },
  args: DEPLOYMENTS_ARGS,
  subCommands: DEPLOYMENTS_SUBCOMMANDS,
  // Default behaviour (no subcommand) = list. Citty runs a parent's run()
  // after a subcommand that returned (human mode), so skip it when the args
  // named a subcommand; otherwise `deployments get <id>` would print the
  // list after the deployment.
  async run(ctx) {
    if (namedSubcommand(ctx.rawArgs ?? [], DEPLOYMENTS_ARGS, DEPLOYMENTS_SUBCOMMANDS)) return;
    const run = deploymentsList.run;
    if (!run) return;
    return run(ctx as Parameters<NonNullable<typeof deploymentsList.run>>[0]);
  },
});

function timeAgo(dateStr: string | number): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
