import { defineCommand } from "citty";
import consola from "consola";
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from "node:fs";
// ajv is lazy-imported only when --template --data is used (avoid top-level crash if deps missing)
import { join, resolve, basename } from "node:path";
import { execSync, execFileSync } from "node:child_process";
import {
  parseConfig,
  CreekClient,
  CreekAuthError,
  isSSRFramework,
  getSSRServerEntry,
  getClientAssetsDir,
  getDefaultBuildOutput,
  getDefaultBuildCommand,
  detectFramework,
  resolveConfig,
  formatDetectionSummary,
  resolvedConfigToBindingRequirements,
  ConfigNotFoundError,
  getSSRServerDir,
  collectServerFiles,
  isPreBundledFramework,
  detectAstroCloudflareBuild,
  detectNextjsMode,
  detectMonorepo,
  planDeploy,
  runDoctor,
  type Framework,
  type ResolvedConfig,
} from "@solcreek/sdk";
import { buildDoctorContext } from "../utils/doctor-context.js";
import { getToken, getApiUrl } from "../utils/config.js";
import { collectAssets } from "../utils/bundle.js";
import { bundleSSRServer } from "../utils/ssr-bundle.js";
import { bundleWorker } from "../utils/worker-bundle.js";
import { sandboxDeploy, pollSandboxStatus, printSandboxSuccess } from "../utils/sandbox.js";
import { prepareDeployBundle } from "../utils/prepare-bundle.js";
import { BuildLogEmitter } from "../utils/build-log.js";
import { isTTY, jsonOutput, resolveJsonMode, globalArgs, shouldAutoConfirm, AUTH_BREADCRUMBS, NO_PROJECT_BREADCRUMBS, type Breadcrumb } from "../utils/output.js";
import { ensureTosAccepted, type TosAcceptance } from "../utils/tos.js";
import { buildNextjs, buildNextjsForWorkers, patchBundledWorker, hasAdapterOutput } from "../utils/nextjs.js";
import { isRepoUrl, parseRepoUrl, validateRepoUrl, validateSubpath, RepoUrlError } from "../utils/repo-url.js";
import { checkGitInstalled, cloneRepo, detectPackageManager, installDependencies, cleanupDir as cleanupCloneDir, GitCloneError } from "../utils/git-clone.js";

function section(name: string) {
  consola.log(`\n  \x1b[2m[${name}]\x1b[0m`);
}

function assetSummary(fileList: string[]): string {
  const byExt: Record<string, number> = {};
  for (const f of fileList) {
    const ext = f.includes(".") ? `.${f.split(".").pop()}` : "(other)";
    byExt[ext] = (byExt[ext] ?? 0) + 1;
  }
  const parts = Object.entries(byExt)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([ext, n]) => `${n} ${ext}`);
  return parts.join(", ");
}

/**
 * Dry-run handler: describes what `creek deploy` would do without
 * executing. No network calls, no file uploads, no builds, no ToS
 * prompts. Safe to call from an AI agent that wants to understand
 * the deploy plan before running it.
 *
 * Always exits 0 — a dry-run is "successful" even when no project is
 * found, because the goal is to report state, not enforce it.
 */
async function dryRunPlan(
  cwd: string,
  args: Record<string, unknown>,
  jsonMode: boolean,
): Promise<void> {
  // Unsupported modes — report and return cleanly
  const unsupportedMode =
    args.template ? "template"
    : args["from-github"] ? "from-github"
    : (typeof args.dir === "string" && isRepoUrl(args.dir)) ? "repo-url"
    : null;

  if (unsupportedMode) {
    if (jsonMode) {
      jsonOutput(
        {
          mode: "dry-run",
          supported: false,
          unsupportedMode,
          message: `Dry-run is not yet supported for --${unsupportedMode} deploys`,
          hint: `Run without --dry-run to execute, or inspect the command docs with --help`,
        },
        0,
        [],
      );
      return;
    }
    consola.log(
      `\n  \x1b[2m[dry-run]\x1b[0m Dry-run is not yet supported for --${unsupportedMode} deploys.\n`,
    );
    consola.log(
      `  Run without --dry-run to execute, or inspect the command docs with --help.\n`,
    );
    return;
  }

  // Main case: resolve config in cwd
  let resolved: ResolvedConfig | null = null;
  try {
    resolved = resolveConfig(cwd);
  } catch (err) {
    if (!(err instanceof ConfigNotFoundError)) throw err;
  }

  const token = getToken();
  const authenticated = !!token;

  // If no config, check build-output fallback
  let buildOutputFallback: string | null = null;
  if (!resolved) {
    for (const dir of ["dist", "build", "out", ".output/public"]) {
      if (existsSync(resolve(cwd, dir))) {
        buildOutputFallback = dir;
        break;
      }
    }
  }

  const wouldDeploy = !!(resolved || buildOutputFallback);
  const targetType = authenticated ? "production" : "sandbox";
  const bindings = resolved
    ? resolvedConfigToBindingRequirements(resolved).map((b) => ({
        name: b.bindingName,
        type: b.type,
      }))
    : [];

  // Run the same rule engine as `creek doctor` so dry-run surfaces
  // config errors (e.g. CK-RESOURCES-KEYS) that would otherwise only
  // reveal themselves at runtime when the missing binding crashes the
  // worker. Agents following the SKILL.md "dry-run first" rule need
  // these findings here, not after a 500.
  const doctorReport = runDoctor(buildDoctorContext(cwd));
  const blockingFindings = doctorReport.findings.filter(
    (f) => f.severity === "error",
  );

  const plan = {
    mode: "dry-run" as const,
    supported: true,
    cwd,
    authenticated,
    target: {
      type: targetType,
      description:
        targetType === "production"
          ? "Your team's production slot (permanent URL via creek.toml)"
          : "Free 60-minute sandbox (no signup required)",
    },
    config: resolved
      ? {
          source: resolved.source,
          projectName: resolved.projectName,
          framework: resolved.framework,
          buildCommand: resolved.buildCommand,
          buildOutput: resolved.buildOutput,
          cron: resolved.cron,
          queue: resolved.queue,
        }
      : null,
    buildOutputFallback,
    bindings,
    findings: doctorReport.findings,
    wouldDeploy,
    sideEffects: {
      networkCalls: false,
      fileUploads: false,
      buildExecuted: false,
      tosPromptShown: false,
    },
    nextStep: blockingFindings.length > 0
      ? `Fix ${blockingFindings.length} blocking issue${blockingFindings.length === 1 ? "" : "s"} first (see findings), then re-run. For details: creek doctor --json`
      : wouldDeploy
      ? "Run without --dry-run to execute: npx creek deploy"
      : "No project config or build output found. Run `creek init` or `npm create vite@latest` first.",
  };

  if (jsonMode) {
    jsonOutput(plan, 0, []);
    return;
  }

  // Human-readable plan
  consola.log(
    "\n  \x1b[2m[dry-run]\x1b[0m No deploy will execute. No network calls. No uploads.\n",
  );
  consola.log(`  cwd:              ${cwd}`);
  consola.log(
    `  Auth status:      ${authenticated ? "✓ signed in" : "✗ not signed in"}`,
  );
  consola.log(
    `  Deploy target:    ${targetType} — ${plan.target.description}`,
  );
  if (resolved) {
    consola.log(`  Detected:         ${formatDetectionSummary(resolved)}`);
    consola.log(`  Project name:     ${resolved.projectName}`);
    if (resolved.framework) {
      consola.log(`  Framework:        ${resolved.framework}`);
    }
    consola.log(`  Build command:    ${resolved.buildCommand}`);
    consola.log(`  Build output:     ${resolved.buildOutput}`);
    if (bindings.length > 0) {
      consola.log(
        `  Bindings:         ${bindings.map((b) => `${b.name} (${b.type})`).join(", ")}`,
      );
    }
    if (resolved.cron.length > 0) {
      consola.log(`  Cron triggers:    ${resolved.cron.join(", ")}`);
    }
    if (resolved.queue) {
      consola.log(`  Queue trigger:    enabled`);
    }
    if (resolved.unsupportedBindings.length > 0) {
      consola.log(
        `  Unsupported:      ${resolved.unsupportedBindings
          .map((b) => `${b.name} (${b.type})`)
          .join(", ")} — would be skipped`,
      );
    }
    if (doctorReport.findings.length > 0) {
      const errCount = doctorReport.summary.error;
      const warnCount = doctorReport.summary.warn;
      const infoCount = doctorReport.summary.info;
      const parts: string[] = [];
      if (errCount) parts.push(`${errCount} error${errCount === 1 ? "" : "s"}`);
      if (warnCount) parts.push(`${warnCount} warning${warnCount === 1 ? "" : "s"}`);
      if (infoCount) parts.push(`${infoCount} info`);
      consola.log(
        `  Doctor findings:  ${parts.join(", ")} — run \`creek doctor\` for details`,
      );
      for (const f of doctorReport.findings.filter((f) => f.severity === "error")) {
        consola.log(`    \x1b[31m✗\x1b[0m [${f.code}] ${f.title}`);
      }
    }
  } else if (buildOutputFallback) {
    consola.log(
      `  Detected:         prebuilt assets in ${buildOutputFallback}/ (no creek.toml, no wrangler config)`,
    );
  } else {
    consola.log(
      `  Detected:         nothing — no creek.toml, no wrangler config, no dist/build/out/.output/public/`,
    );
  }
  consola.log(`\n  Next step:        ${plan.nextStep}\n`);
}

export const deployCommand = defineCommand({
  meta: {
    name: "deploy",
    description:
      "Deploy the current project to Creek. Signed-in: deploys to your team's production slot. Not signed in: creates a free 60-minute sandbox URL (no signup). Auto-detects framework from creek.toml, wrangler files, package.json, or index.html. Safe to run from an AI coding agent — use --dry-run first to inspect the plan without executing.",
  },
  args: {
    dir: {
      type: "positional",
      description:
        "Directory to deploy (default: current directory). Also accepts a GitHub repo URL to clone-and-deploy.",
      required: false,
    },
    "skip-build": {
      type: "boolean",
      description:
        "Skip the build step — upload existing build output as-is. Useful when CI already built the artifact.",
      default: false,
    },
    "dry-run": {
      type: "boolean",
      description:
        "Show what would be deployed without doing it: resolved config, detected framework, bindings, target URL, auth status. No network calls, no file uploads. Pair with --json for machine-readable plan output. Safe for agents.",
      default: false,
    },
    ...globalArgs,
    template: {
      type: "string",
      description:
        "Deploy a named template (e.g., landing, blog, todo). Combine with --data to pass template params.",
      required: false,
    },
    data: {
      type: "string",
      description:
        "JSON string of template parameters (used with --template). Example: --data '{\"title\":\"Hello\"}'",
      required: false,
    },
    path: {
      type: "string",
      description:
        "Subdirectory within the repo to deploy, for monorepos. Example: --path apps/web",
      required: false,
    },
    "no-cache": {
      type: "boolean",
      description:
        "Skip build cache check — always build locally. Use when you suspect cached output is stale or you changed build config without changing source files.",
      default: false,
    },
    "from-github": {
      type: "boolean",
      description:
        "Skip local build; trigger a remote deploy of the latest commit on the project's production branch via its GitHub connection.",
      default: false,
    },
    project: {
      type: "string",
      description:
        "Target project slug or UUID. Required with --from-github when not run inside a project directory.",
      required: false,
    },
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);

    // --- Dry-run short-circuit ---
    // No ToS prompt, no network, no file uploads, no builds. Pure config
    // resolution + plan output. Safe to call from an AI agent that wants
    // to understand what `creek deploy` would do before running it.
    if (args["dry-run"]) {
      const dryCwd =
        args.dir && typeof args.dir === "string" && !isRepoUrl(args.dir)
          ? resolve(args.dir)
          : process.cwd();
      return await dryRunPlan(dryCwd, args, jsonMode);
    }

    // --- Ensure ToS accepted ---
    const autoConfirm = shouldAutoConfirm(args);
    const tos = await ensureTosAccepted(autoConfirm);

    // --- Template deploy ---
    if (args.template) {
      let templateData: Record<string, unknown> | undefined;
      if (args.data) {
        try {
          templateData = JSON.parse(args.data);
        } catch {
          consola.error("Invalid JSON in --data");
          process.exit(1);
        }
      }
      return await deployTemplate(args.template, templateData);
    }

    // --- Trigger a deploy from the project's GitHub connection (no local build) ---
    if (args["from-github"]) {
      return await deployFromGithub({
        project: args.project,
        cwd: args.dir ? resolve(args.dir) : process.cwd(),
        jsonMode,
      });
    }

    // --- Repo URL deploy (creek deploy https://github.com/user/repo) ---
    if (args.dir && isRepoUrl(args.dir)) {
      return await deployRepoUrl(args.dir, {
        path: args.path ?? null,
        skipBuild: args["skip-build"],
        json: jsonMode,
      });
    }

    // --- Resolve target directory ---
    const cwd = args.dir ? resolve(args.dir) : process.cwd();
    const token = getToken();

    // --- Explicit directory (creek deploy ./dist) ---
    if (args.dir) {
      if (!existsSync(cwd)) {
        if (jsonMode) jsonOutput({ error: "not_found", message: `Directory not found: ${args.dir}` }, 1, NO_PROJECT_BREADCRUMBS);
        consola.error(`Directory not found: ${args.dir}`);
        process.exit(1);
      }
      return await deployDirectory(cwd, jsonMode, tos);
    }

    // --- Try auto-detection (creek.toml → wrangler.* → package.json → index.html) ---
    let resolved: ResolvedConfig | null = null;
    try {
      resolved = resolveConfig(cwd);
    } catch (err) {
      if (!(err instanceof ConfigNotFoundError)) throw err;
    }

    if (resolved) {
      if (!jsonMode) {
        consola.info(`  Detected: ${formatDetectionSummary(resolved)}`);
        for (const ub of resolved.unsupportedBindings) {
          consola.warn(`  Binding '${ub.name}' (${ub.type}) is not yet supported — will be skipped`);
        }
      }

      if (token) {
        return await deployAuthenticated(cwd, resolved, token, args["skip-build"], jsonMode, args["no-cache"]);
      }
      return await deploySandbox(cwd, args["skip-build"], jsonMode, resolved, tos);
    }

    // --- Auto-detect build output dirs ---
    for (const dir of ["dist", "build", "out", ".output/public"]) {
      const fullPath = resolve(cwd, dir);
      if (existsSync(fullPath)) {
        if (!jsonMode) consola.info(`Found build output: ${dir}/`);
        return await deployDirectory(fullPath, jsonMode, tos);
      }
    }

    // --- Nothing found → guide the user ---
    if (jsonMode) jsonOutput({ error: "no_project", message: "No project found in this directory" }, 1, NO_PROJECT_BREADCRUMBS);
    consola.info("No project found in this directory.\n");
    consola.info("  creek deploy ./dist              Deploy a build output directory");
    consola.info("  npx create-creek-app             Create a new project from a template");
    consola.info("");
    consola.info("Or create a project first:");
    consola.info("  npm create vite@latest my-app && cd my-app && npx creek deploy");
    process.exit(1);
  },
});

// ============================================================================
// Deploy from GitHub connection — no local build, server fetches latest commit
// ============================================================================

interface DeployFromGithubOptions {
  project: string | undefined;
  cwd: string;
  jsonMode: boolean;
}

export interface CliDeployment {
  id: string;
  version: number;
  status: string;
  branch: string | null;
  failedStep: string | null;
  errorMessage: string | null;
  createdAt: number;
  url: string | null;
}

export const CLI_TERMINAL_STATUSES = new Set(["active", "failed", "cancelled"]);
export const CLI_IN_FLIGHT_STATUSES = new Set([
  "queued",
  "uploading",
  "provisioning",
  "deploying",
]);

/**
 * Given a deployment list and a "previous latest createdAt" snapshot,
 * return the most recently-created deployment that arrived after the
 * snapshot, or null if none have appeared yet. Used by `--from-github`
 * to find the row that handlePush just inserted in the background.
 */
export function findNewDeployment(
  deployments: CliDeployment[],
  previousLatestCreatedAt: number,
): CliDeployment | null {
  const newer = deployments.filter((d) => d.createdAt > previousLatestCreatedAt);
  if (newer.length === 0) return null;
  return newer.reduce((latest, d) => (d.createdAt > latest.createdAt ? d : latest), newer[0]);
}

/**
 * Trigger a deploy that uses the project's github_connection instead of a
 * local build. Polls the deployments list until the new row settles and
 * streams status transitions to the terminal.
 *
 * The server endpoint (POST /github/deploy-latest) returns 200 immediately
 * while handlePush runs in waitUntil, so we fingerprint the deployments list
 * before the POST and look for a new row afterward.
 */
async function deployFromGithub(options: DeployFromGithubOptions): Promise<void> {
  const { project: projectArg, cwd, jsonMode } = options;

  const token = getToken();
  if (!token) {
    if (jsonMode) jsonOutput({ error: "not_authenticated", message: "Run `creek login` first." }, 1, AUTH_BREADCRUMBS);
    consola.error("Not logged in. Run `creek login` first.");
    process.exit(1);
  }

  // Resolve the target project: explicit --project flag wins, otherwise
  // fall back to the current directory's resolved config (creek.toml
  // [project] name or inferred project name).
  let projectSlug = projectArg;
  if (!projectSlug) {
    try {
      const resolved = resolveConfig(cwd);
      projectSlug = resolved.projectName;
    } catch (err) {
      if (!(err instanceof ConfigNotFoundError)) throw err;
    }
  }

  if (!projectSlug) {
    if (jsonMode) jsonOutput({ error: "validation", message: "Could not determine target project. Pass --project <slug>." }, 1, NO_PROJECT_BREADCRUMBS);
    consola.error("Could not determine target project. Pass --project <slug> or run inside a directory with a creek.toml.");
    process.exit(1);
  }

  const client = new CreekClient(getApiUrl(), token);

  // Snapshot the current newest deployment so we can detect the one this
  // command creates. createdAt is the cleanest marker — the version number
  // also works but we don't need to parse it.
  let previousLatestCreatedAt = 0;
  try {
    const existing = (await client.listDeployments(projectSlug)) as unknown as CliDeployment[];
    previousLatestCreatedAt = existing.reduce((max, d) => Math.max(max, d.createdAt), 0);
  } catch (err) {
    if (err instanceof CreekAuthError) throw err;
    if (jsonMode) jsonOutput({ error: "not_found", message: (err as Error).message }, 1, NO_PROJECT_BREADCRUMBS);
    consola.error(`Could not load deployments for project '${projectSlug}': ${(err as Error).message}`);
    process.exit(1);
  }

  // Kick off the build
  if (!jsonMode) {
    section("Trigger");
    consola.start(`  Triggering deploy of '${projectSlug}' from its GitHub connection...`);
  }

  let triggerResult: { ok: boolean; commitSha: string; branch: string };
  try {
    triggerResult = await client.deployFromGithub(projectSlug);
  } catch (err) {
    const msg = (err as Error).message;
    if (jsonMode) jsonOutput({ error: "trigger_failed", message: msg }, 1, NO_PROJECT_BREADCRUMBS);
    consola.error(`Trigger failed: ${msg}`);
    process.exit(1);
  }

  if (!jsonMode) {
    consola.success(`  Triggered (${triggerResult.branch} @ ${triggerResult.commitSha.slice(0, 7)})`);
    section("Watch");
  }

  // Poll for the new deployment row, then follow its status until it settles.
  // First phase: wait up to 20s for the row to appear (handlePush runs in
  // waitUntil and may take a beat to insert).
  const startedAt = Date.now();
  const rowAppearDeadline = startedAt + 20_000;
  const overallDeadline = startedAt + 15 * 60_000; // 15 min hard cap
  let targetDeployment: CliDeployment | null = null;
  let lastStatus: string | null = null;

  while (Date.now() < overallDeadline) {
    let list: CliDeployment[];
    try {
      list = (await client.listDeployments(projectSlug)) as unknown as CliDeployment[];
    } catch (err) {
      if (!jsonMode) consola.warn(`  Poll failed: ${(err as Error).message}`);
      await sleep(2000);
      continue;
    }

    // Phase 1: find the new row. It's the newest deployment with a
    // createdAt greater than our snapshot. triggerType should be 'github'
    // but we don't require it (rollback/promote could race, but extremely
    // unlikely in the narrow window between snapshot + poll).
    if (!targetDeployment) {
      const candidate = list
        .filter((d) => d.createdAt > previousLatestCreatedAt)
        .sort((a, b) => b.createdAt - a.createdAt)[0];

      if (candidate) {
        targetDeployment = candidate;
        if (!jsonMode) {
          consola.info(`  v${candidate.version} ${candidate.branch ?? ""}`.trim());
        }
      } else if (Date.now() > rowAppearDeadline) {
        // 20s and no new row — handlePush must have errored before it could
        // insert. Surface the timeout rather than hanging.
        if (jsonMode) jsonOutput({ error: "no_deployment", message: "Deployment row did not appear within 20s. Check server logs." }, 1, NO_PROJECT_BREADCRUMBS);
        consola.error("  Deployment row did not appear within 20s. Check control-plane logs.");
        process.exit(1);
      } else {
        await sleep(1500);
        continue;
      }
    }

    // Phase 2: follow the target row's status
    const current = list.find((d) => d.id === targetDeployment!.id);
    if (!current) {
      // Shouldn't happen — row was there a moment ago
      await sleep(1500);
      continue;
    }
    targetDeployment = current;

    if (current.status !== lastStatus) {
      lastStatus = current.status;
      if (!jsonMode) {
        if (CLI_IN_FLIGHT_STATUSES.has(current.status)) {
          consola.start(`  ${current.status}...`);
        }
      }
    }

    if (CLI_TERMINAL_STATUSES.has(current.status)) {
      break;
    }

    await sleep(2000);
  }

  if (!targetDeployment) {
    if (jsonMode) jsonOutput({ error: "timeout", message: "Timed out waiting for deployment" }, 1, NO_PROJECT_BREADCRUMBS);
    consola.error("Timed out waiting for deployment");
    process.exit(1);
  }

  // Report the outcome
  if (targetDeployment.status === "active") {
    if (jsonMode) {
      jsonOutput(
        {
          ok: true,
          deploymentId: targetDeployment.id,
          version: targetDeployment.version,
          status: "active",
          url: targetDeployment.url,
        },
        0,
        NO_PROJECT_BREADCRUMBS,
      );
    } else {
      consola.success(`  Deployed v${targetDeployment.version}`);
      if (targetDeployment.url) consola.log(`  ${targetDeployment.url}`);
    }
    return;
  }

  // Failed / cancelled
  const failureMsg = targetDeployment.errorMessage || `Deployment ${targetDeployment.status}`;
  if (jsonMode) {
    jsonOutput(
      {
        ok: false,
        deploymentId: targetDeployment.id,
        status: targetDeployment.status,
        failedStep: targetDeployment.failedStep,
        errorMessage: failureMsg,
      },
      1,
      NO_PROJECT_BREADCRUMBS,
    );
  } else {
    consola.error(
      `  Deployment ${targetDeployment.status}${targetDeployment.failedStep ? ` at ${targetDeployment.failedStep}` : ""}: ${failureMsg}`,
    );
  }
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================================
// Repo URL deploy — clone from GitHub, detect config, deploy
// ============================================================================

interface RepoDeployOptions {
  path: string | null;
  skipBuild: boolean;
  json: boolean;
}

async function deployRepoUrl(input: string, options: RepoDeployOptions) {
  const { path: subpath, skipBuild, json: jsonMode } = options;

  try {
    // 1. Parse and validate URL
    const parsed = parseRepoUrl(input);
    validateRepoUrl(parsed);
    if (subpath) validateSubpath(subpath);

    // 2. Check git is available
    checkGitInstalled();

    // 3. Clone
    section("Clone");
    consola.start(`  Cloning ${parsed.displayUrl}...`);
    const { tmpDir, workDir, sizeMb } = cloneRepo(parsed, { subpath });
    consola.success(`  Cloned (${sizeMb.toFixed(1)} MB)`);

    try {
      // 4. Resolve config
      section("Detect");
      let resolved: ResolvedConfig;
      try {
        resolved = resolveConfig(workDir);
      } catch (err) {
        if (err instanceof ConfigNotFoundError) {
          consola.error(`No supported project found in ${parsed.displayUrl}.`);
          consola.info("");
          consola.info("  If this is a monorepo, specify a subdirectory:");
          consola.info(`    creek deploy ${input} --path packages/app`);
          consola.info("");
          consola.info("  Creek looks for: creek.toml, wrangler.*, package.json, or index.html");
          process.exit(1);
        }
        throw err;
      }

      consola.info(`  Detected: ${formatDetectionSummary(resolved)}`);
      for (const ub of resolved.unsupportedBindings) {
        consola.warn(`  Binding '${ub.name}' (${ub.type}) is not yet supported — will be skipped`);
      }

      // 5. Install dependencies (if package.json exists)
      if (existsSync(join(workDir, "package.json"))) {
        section("Install");
        const pm = detectPackageManager(workDir);
        consola.start(`  Installing dependencies (${pm})...`);
        installDependencies(workDir, pm);
        consola.success(`  Dependencies installed`);
      }

      // 6. Route to authenticated or sandbox deploy
      const token = getToken();
      if (token) {
        return await deployAuthenticated(workDir, resolved, token, skipBuild, jsonMode);
      }
      return await deploySandbox(workDir, skipBuild, jsonMode, resolved);

    } finally {
      cleanupCloneDir(tmpDir);
    }
  } catch (err) {
    if (err instanceof RepoUrlError || err instanceof GitCloneError) {
      if (jsonMode) jsonOutput({ error: "repo_deploy_failed", message: err.message }, 1, [
        { command: "npx create-creek-app", description: "Create a new project from a template" },
      ]);
      consola.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

// ============================================================================
// Directory deploy — deploy pre-built static files directly
// ============================================================================

async function deployDirectory(dir: string, jsonMode: boolean, tos?: TosAcceptance) {
  if (!jsonMode) section("Upload");
  const { assets, fileList } = collectAssets(dir);

  if (fileList.length === 0) {
    if (jsonMode) jsonOutput({ ok: false, error: "no_files", message: `No files found in ${dir}` }, 1, NO_PROJECT_BREADCRUMBS);
    consola.error(`No files found in ${dir}\n`);
    consola.info("  creek deploy ./dist              Deploy a build output directory");
    consola.info("  npx create-creek-app             Create a new project from a template");
    process.exit(1);
  }

  if (!jsonMode) {
    consola.info(`  ${fileList.length} files (${assetSummary(fileList)})`);
    consola.info("  Mode: sandbox (60 min preview)");
    section("Deploy");
    consola.start("  Deploying to edge...");
  }

  try {
    const result = await sandboxDeploy({ assets, source: "cli" }, { tos });
    const status = await pollSandboxStatus(result.statusUrl);

    if (jsonMode) {
      jsonOutput({
        ok: true,
        sandboxId: result.sandboxId,
        url: status.previewUrl,
        deployDurationMs: status.deployDurationMs,
        expiresAt: result.expiresAt,
        assetCount: fileList.length,
        mode: "sandbox",
      }, 0, [
        { command: `creek status ${result.sandboxId}`, description: "Check sandbox status" },
        { command: `creek claim ${result.sandboxId}`, description: "Claim as permanent project" },
      ]);
    }

    printSandboxSuccess(status.previewUrl, result.expiresAt, result.sandboxId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Deploy failed";
    if (jsonMode) jsonOutput({ ok: false, error: "deploy_failed", message }, 1, [
      { command: "creek deploy", description: "Retry deploy" },
    ]);
    consola.error(message);
    process.exit(1);
  }
}

// ============================================================================
// Sandbox deploy — auto-detect framework, build, deploy
// ============================================================================

async function deploySandbox(cwd: string, skipBuild: boolean, jsonMode = false, resolved?: ResolvedConfig, tos?: TosAcceptance) {
  // Static-site fast path: when resolveConfig fell back to index.html, the cwd
  // has no build step and may have no package.json. Delegate to deployDirectory
  // which just uploads the cwd as-is. This handles the simplest possible
  // onboarding:
  //     mkdir test && cd test
  //     echo '<h1>Hi</h1>' > index.html
  //     npx creek deploy
  if (resolved?.source === "index.html") {
    return deployDirectory(cwd, jsonMode, tos);
  }

  // Framework path: package.json should exist because resolveConfig picked a
  // framework from package.json, wrangler files, or creek.toml. Guard anyway
  // so we fail with a helpful message instead of an ENOENT stack trace.
  const pkgJsonPath = join(cwd, "package.json");
  if (!existsSync(pkgJsonPath)) {
    const message = `Expected package.json in ${cwd} but none found.`;
    if (jsonMode) {
      jsonOutput(
        {
          ok: false,
          error: "no_package_json",
          message,
          hint: "Run `npx creek deploy ./dist` to deploy a prebuilt directory, or `npx creek deploy --template landing` to start from a template.",
        },
        1,
        NO_PROJECT_BREADCRUMBS,
      );
      return;
    }
    consola.error(message);
    consola.info("  Run `npx creek deploy ./dist` to deploy a prebuilt directory instead,");
    consola.info("  or `npx creek deploy --template landing` to start from a template.");
    process.exit(1);
  }

  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
  const framework = resolved?.framework ?? detectFramework(pkg);
  const nextjsMode = framework === "nextjs" ? detectNextjsMode(pkg, cwd) : null;
  const monorepo = detectMonorepo(cwd);

  section("Detect");
  consola.info(`  Framework: ${framework ?? "static site"}`);
  if (nextjsMode) consola.info(`  Next.js mode: ${nextjsMode}${monorepo.isMonorepo ? " (monorepo)" : ""}`);
  consola.info("  Mode: sandbox (60 min preview)");

  // Pre-build header so the section banner ("Build") still appears
  // before build output streams. Then prepareDeployBundle owns the
  // actual build + plan + collect + bundle pipeline.
  if (!skipBuild) section("Build");
  const prepared = await prepareDeployBundle({
    cwd,
    resolved: resolved ?? ({} as ResolvedConfig), // sandbox path can be called without resolved when delegating; guarded above
    skipBuild,
  });
  const { plan, fileList, assets: clientAssets, serverFiles, effectiveRenderMode } = prepared;

  section("Upload");
  consola.info(`  Mode: ${effectiveRenderMode}${plan.worker.entry ? ` (worker: ${plan.worker.entry})` : ""}`);
  if (plan.assets.enabled) {
    consola.info(`  ${fileList.length} assets (${assetSummary(fileList)})`);
  }

  // Deploy to sandbox
  if (!jsonMode) {
    section("Deploy");
    consola.start("  Deploying to edge...");
  }
  try {
    const result = await sandboxDeploy({
      manifest: {
        assets: fileList,
        hasWorker: prepared.serverFiles !== undefined,
        entrypoint: prepared.effectiveEntrypoint,
        renderMode: effectiveRenderMode,
      },
      assets: clientAssets,
      serverFiles,
      framework: prepared.framework ?? undefined,
      source: "cli",
      ...(resolved
        ? { bindings: resolvedConfigToBindingRequirements(resolved) }
        : {}),
      ...(resolved?.compatibilityDate
        ? { compatibilityDate: resolved.compatibilityDate }
        : {}),
      ...(resolved && resolved.compatibilityFlags.length > 0
        ? { compatibilityFlags: resolved.compatibilityFlags }
        : {}),
    }, { tos });

    const status = await pollSandboxStatus(result.statusUrl);

    if (jsonMode) {
      jsonOutput({
        ok: true,
        sandboxId: result.sandboxId,
        url: status.previewUrl,
        deployDurationMs: status.deployDurationMs,
        expiresAt: result.expiresAt,
        framework: framework ?? null,
        assetCount: fileList.length,
        mode: "sandbox",
      }, 0, [
        { command: `creek status ${result.sandboxId}`, description: "Check sandbox status" },
        { command: `creek claim ${result.sandboxId}`, description: "Claim as permanent project" },
      ]);
    }

    printSandboxSuccess(status.previewUrl, result.expiresAt, result.sandboxId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Sandbox deploy failed";
    if (jsonMode) jsonOutput({ ok: false, error: "deploy_failed", message }, 1, [
      { command: "creek deploy", description: "Retry deploy" },
    ]);
    consola.error(message);
    process.exit(1);
  }
}

// ============================================================================
// Template deploy — clone + build + deploy to sandbox
// ============================================================================

async function deployTemplate(templateId: string, data?: Record<string, unknown>) {
  // Validate template ID — alphanumeric, hyphens, underscores only (no path traversal)
  if (!/^[a-zA-Z0-9_-]+$/.test(templateId)) {
    consola.error("Invalid template name. Use only letters, numbers, hyphens, and underscores.");
    process.exit(1);
  }

  consola.info(`Deploying template: ${templateId}`);

  // Clone template to temp dir
  const tmpDir = join(process.env.TMPDIR ?? "/tmp", `creek-template-${Date.now()}`);
  const repoUrl = "https://github.com/solcreek/templates";

  consola.start("Cloning template...");
  try {
    execFileSync("git", [
      "clone", "--depth", "1", "--filter=blob:none", "--sparse", repoUrl, tmpDir,
    ], { stdio: "pipe" });
    execFileSync("git", [
      "sparse-checkout", "set", templateId,
    ], { cwd: tmpDir, stdio: "pipe" });
  } catch {
    consola.error(`Template '${templateId}' not found.`);
    consola.info("Available templates: npx create-creek-app --list");
    cleanupDir(tmpDir);
    process.exit(1);
  }

  const templateDir = join(tmpDir, templateId);
  // Verify resolved path is still within tmpDir (prevent path traversal)
  if (!resolve(templateDir).startsWith(resolve(tmpDir))) {
    consola.error("Invalid template path.");
    cleanupDir(tmpDir);
    process.exit(1);
  }

  if (!existsSync(templateDir)) {
    consola.error(`Template directory not found: ${templateId}`);
    cleanupDir(tmpDir);
    process.exit(1);
  }

  // Apply --data: validate against schema + merge into creek-data.json
  if (data) {
    const configPath = join(templateDir, "creek-template.json");
    const dataPath = join(templateDir, "creek-data.json");

    // Read defaults
    let defaults: Record<string, unknown> = {};
    if (existsSync(dataPath)) {
      defaults = JSON.parse(readFileSync(dataPath, "utf-8"));
    }
    const merged = { ...defaults, ...data };

    // Validate against schema if creek-template.json exists
    if (existsSync(configPath)) {
      const templateConfig = JSON.parse(readFileSync(configPath, "utf-8"));
      if (templateConfig.schema) {
        const { default: Ajv } = await import("ajv");
        const ajv = new Ajv({ allErrors: true, useDefaults: true });
        const { $schema: _, ...schemaWithoutMeta } = templateConfig.schema as Record<string, unknown>;
        const validate = ajv.compile(schemaWithoutMeta);

        if (!validate(merged)) {
          consola.error("Data validation failed:");
          for (const err of (validate.errors ?? []) as Array<{ instancePath?: string; message?: string }>) {
            consola.error(`  ${err.instancePath || "/"}: ${err.message}`);
          }
          cleanupDir(tmpDir);
          process.exit(1);
        }
      }
    }

    // Write merged data into creek-data.json
    writeFileSync(dataPath, JSON.stringify(merged, null, 2) + "\n");
    consola.success("Applied custom data");
  }

  // Remove creek-template.json (metadata, not project file)
  const templateConfigPath = join(templateDir, "creek-template.json");
  if (existsSync(templateConfigPath)) {
    rmSync(templateConfigPath);
  }

  consola.start("Installing dependencies...");
  try {
    execFileSync("npm", ["install"], { cwd: templateDir, stdio: "pipe" });
  } catch {
    consola.error("Failed to install dependencies");
    cleanupDir(tmpDir);
    process.exit(1);
  }

  // Deploy as sandbox (reuse sandbox flow)
  await deploySandbox(templateDir, false);

  // Cleanup
  cleanupDir(tmpDir);
}

function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// ============================================================================
// Authenticated deploy — existing flow
// ============================================================================

async function deployAuthenticated(cwd: string, resolved: ResolvedConfig, token: string, skipBuild: boolean, jsonMode = false, noCache = false) {
  try {
    const client = new CreekClient(getApiUrl(), token);

    section("Auth");
    const session = await client.getSession();
    if (!session?.user) {
      consola.error("Token is invalid or expired. Run `creek login` to re-authenticate.");
      process.exit(1);
    }
    consola.info(`  Deploying as ${session.user.email}`);
    consola.info(`  Project: ${resolved.projectName}`);

    // Ensure project exists — confirm before auto-creating
    let project: { id: string; slug: string };
    try {
      project = await client.getProject(resolved.projectName);
    } catch {
      if (!jsonMode && isTTY) {
        const confirm = await consola.prompt(
          `Project "${resolved.projectName}" does not exist. Create it?`,
          { type: "confirm" },
        );
        if (!confirm) {
          consola.info("Deploy cancelled.");
          process.exit(0);
        }
      }
      const res = await client.createProject({
        slug: resolved.projectName,
        framework: resolved.framework ?? undefined,
      });
      project = res.project;
      if (!jsonMode) consola.success(`  Created project: ${project.slug}`);
    }

    // Framework is resolved upstream; everything else (SSR / worker /
    // assets / bundling) is decided inside prepareDeployBundle via the
    // SDK's planDeploy resolver.
    const framework = resolved.framework;

    // Detect Next.js mode for the info banner only — actual handling is
    // inside prepareDeployBundle.
    const pkg = existsSync(join(cwd, "package.json"))
      ? JSON.parse(readFileSync(join(cwd, "package.json"), "utf-8"))
      : {};
    const nextjsMode = framework === "nextjs" ? detectNextjsMode(pkg, cwd) : null;
    const monorepo = framework === "nextjs" ? detectMonorepo(cwd) : { isMonorepo: false, root: null };
    if (nextjsMode && !jsonMode) {
      consola.info(`  Next.js mode: ${nextjsMode}${monorepo.isMonorepo ? " (monorepo)" : ""}`);
    }

    // --- ⚡ Turbo deploy: check if server has a cached build for this commit ---
    // Read the local git HEAD SHA. If the working tree is clean and the
    // server has a cached bundle for this exact commit, skip the entire
    // local build + upload and let the server deploy from cache.
    const turboResult = await tryTurboDeploy(cwd, client, project, noCache, jsonMode);
    if (turboResult) {
      return; // ⚡ done — server deployed from cache
    }

    // Single source of truth for build → plan → collect → bundle. Both
    // sandbox and authenticated paths call the same function; they
    // diverge only in where the bundle gets POSTed.
    if (!skipBuild && resolved.buildCommand) section("Build");
    const prepared = await prepareDeployBundle({ cwd, resolved, skipBuild });
    const {
      plan,
      framework: detectedFramework,
      effectiveRenderMode,
      effectiveEntrypoint,
      fileList,
      assets: clientAssets,
      serverFiles,
    } = prepared;
    void detectedFramework; // framework var above is the source of truth here

    // Resource / runtime anchors — inline lines that pre-empt the most
    // common wrong assumptions an AI agent reads from Creek running on
    // Cloudflare. Cheap to print, and they parse them directly.
    const dbDeps =
      !!resolved.bindings.find((b) => b.type === "d1") ||
      fileList.some((f) => /\.(db|sqlite)$/i.test(f));
    if (!jsonMode && dbDeps) {
      consola.info(
        "  ℹ Database: Creek uses the portable driver — better-sqlite3 locally, D1 remotely. Your code reads env.DB in both. Do NOT rewrite for D1 manually; `creek db attach` wires the binding.",
      );
    }

    section("Upload");
    consola.info(`  ${fileList.length} assets (${assetSummary(fileList)})`);

    section("Deploy");
    consola.start("  Creating deployment...");
    const { deployment } = await client.createDeployment(project.id);

    // Collect a minimal structured build log for the dashboard. We emit
    // one line per high-level phase — verbose stdout capture is a
    // Phase 2 concern. The log is POSTed once we reach a terminal
    // status (success / failed), so the dashboard panel shows something
    // useful for every authenticated deploy.
    const buildLog = new BuildLogEmitter();
    buildLog.info(
      "detect",
      `framework=${framework ?? "none"} renderMode=${effectiveRenderMode} entrypoint=${effectiveEntrypoint ?? "none"}`,
    );
    if (resolved.buildCommand) {
      buildLog.info("build", `ran: ${resolved.buildCommand}`);
    }
    buildLog.info("bundle", `${fileList.length} assets (${assetSummary(fileList)})`);

    consola.start("  Uploading bundle...");
    const effectiveHasWorker = serverFiles !== undefined;
    const bundle = {
      manifest: {
        assets: fileList,
        hasWorker: effectiveHasWorker,
        entrypoint: effectiveEntrypoint,
        renderMode: effectiveRenderMode,
        framework: framework ?? undefined,
      },
      workerScript: null,
      assets: clientAssets,
      serverFiles,
      // Binding declarations with user-defined names
      bindings: resolvedConfigToBindingRequirements(resolved),
      // Pass through wrangler vars and compat settings
      ...(Object.keys(resolved.vars).length > 0 ? { vars: resolved.vars } : {}),
      ...(resolved.compatibilityDate ? { compatibilityDate: resolved.compatibilityDate } : {}),
      // nodejs_compat required for Creek runtime (AsyncLocalStorage).
      // Adapter path uses nodejs_compat_v2 for full Node.js APIs.
      ...(hasAdapterOutput(cwd)
        ? { compatibilityFlags: ["nodejs_compat_v2"] }
        : { compatibilityFlags: [
            "nodejs_compat",
            ...resolved.compatibilityFlags.filter((f) => f !== "nodejs_compat"),
          ] }),
      ...(resolved.cron.length > 0 ? { cron: resolved.cron } : {}),
      ...(resolved.queue ? { queue: true } : {}),
    };

    await client.uploadDeploymentBundle(project.id, deployment.id, bundle);

    // Poll for async deploy progress
    const POLL_INTERVAL = 1000;
    const POLL_TIMEOUT = 120_000;
    const TERMINAL = new Set(["active", "failed", "cancelled"]);
    const STEP_LABELS: Record<string, string> = {
      queued: "  Waiting...",
      uploading: "  Uploading...",
      provisioning: "  Provisioning resources...",
      deploying: "  Deploying to edge...",
    };

    let lastStatus = "";
    const start = Date.now();

    buildLog.info("upload", `bundle uploaded (${fileList.length} files)`);

    while (Date.now() - start < POLL_TIMEOUT) {
      const res = await client.getDeploymentStatus(project.id, deployment.id);
      const { status, failed_step, error_message } = res.deployment;

      if (status !== lastStatus) {
        if (lastStatus && STEP_LABELS[lastStatus]) {
          consola.success(STEP_LABELS[lastStatus].replace("...", ""));
        }
        if (!TERMINAL.has(status) && STEP_LABELS[status]) {
          consola.start(STEP_LABELS[status]);
        }
        // Map server-side phase transitions into build-log steps so
        // the dashboard timeline shows what happened after upload.
        if (status === "provisioning") buildLog.info("provision", "provisioning resources");
        if (status === "deploying") buildLog.info("activate", "activating at edge");
        lastStatus = status;
      }

      if (status === "active") {
        buildLog.info("activate", `deployed: ${res.url ?? res.previewUrl}`);
        // Fire-and-forget the build log upload — don't block the user
        // on it or make a slow/failing log API take down a successful
        // deploy.
        void client
          .uploadBuildLog(deployment.id, buildLog.toNdjson(), {
            status: "success",
            startedAt: buildLog.startedAt,
          })
          .catch(() => {
            // Silent — build log is best-effort for now.
          });

        if (jsonMode) {
          jsonOutput({
            ok: true,
            url: res.url ?? res.previewUrl,
            previewUrl: res.previewUrl,
            deploymentId: deployment.id,
            project: project.slug,
            mode: "production",
            ...(resolved.cron.length > 0 ? { cron: resolved.cron } : {}),
          }, 0, [
            { command: `creek status`, description: "Check deployment status" },
            { command: `creek deployments --project ${project.slug}`, description: "View deployment history" },
            { command: `creek domains add <HOSTNAME> --project ${project.slug}`, description: "Add custom domain" },
          ]);
        }
        consola.success(`  ⬡ Deployed! ${res.url ?? res.previewUrl}`);
        if (res.url && res.previewUrl) {
          consola.info(`  Preview: ${res.previewUrl}`);
        }
        if (resolved.cron.length > 0) {
          consola.info(`  Cron: ${resolved.cron.join(", ")}`);
        }
        if (resolved.queue) {
          consola.info("  Queue: enabled");
        }

        // Contextual next-step hints (non-JSON only)
        if (!jsonMode) {
          printNextStepHint(effectiveRenderMode, resolved);
        }
        return;
      }

      if (status === "failed") {
        const step = failed_step ? ` at ${failed_step}` : "";
        const msg = error_message ?? "Unknown error";
        buildLog.error(
          (failed_step as Parameters<typeof buildLog.error>[0]) ?? "activate",
          msg,
        );
        void client
          .uploadBuildLog(deployment.id, buildLog.toNdjson(), {
            status: "failed",
            startedAt: buildLog.startedAt,
            errorStep: failed_step ?? null,
          })
          .catch(() => {
            // Silent — build log is best-effort for now.
          });
        if (jsonMode) jsonOutput({ ok: false, error: "deploy_failed", message: msg, failedStep: failed_step }, 1, [
          { command: `creek deployments --project ${project.slug}`, description: "Check previous deployments" },
          { command: `creek rollback --project ${project.slug}`, description: "Rollback to previous version" },
        ]);
        consola.error(`Deploy failed${step}: ${msg}`);
        process.exit(1);
      }

      if (status === "cancelled") {
        if (jsonMode) jsonOutput({ ok: false, error: "cancelled", message: "Deploy was cancelled" }, 1, [
          { command: "creek deploy", description: "Retry deploy" },
        ]);
        consola.warn("Deploy was cancelled");
        process.exit(1);
      }

      await new Promise((r) => setTimeout(r, POLL_INTERVAL));
    }

    if (jsonMode) jsonOutput({ ok: false, error: "timeout", message: "Deploy timed out after 2 minutes" }, 1, [
      { command: `creek status`, description: "Check if deploy completed" },
      { command: "creek deploy", description: "Retry deploy" },
    ]);
    consola.error("Deploy timed out after 2 minutes");
    process.exit(1);
  } catch (err) {
    if (err instanceof CreekAuthError) {
      consola.error("Authentication failed. Run `creek login` to re-authenticate.");
      process.exit(1);
    }
    throw err;
  }
}

// --- Hints ---

/**
 * Print next-step hints after deploy.
 * Shows capability overview — lets agents and developers discover what Creek offers.
 */
function printNextStepHint(renderMode: string, config: ResolvedConfig): void {
  const hasDb = config.bindings.some((b) => b.type === "d1");
  if (hasDb) return; // Already using Creek runtime — no hint needed

  console.log("");
  consola.info("  Next steps:");
  consola.info("    import { db } from \"creek\"          Database (managed, no config needed)");
  consola.info("    import { define } from \"d1-schema\"  Define your tables (auto-created)");
  consola.info("    import { kv } from \"creek\"          Key-value storage");
  consola.info("    import { ai } from \"creek\"          AI inference");
  consola.info("    creek dev                           Local development");
  consola.info("    https://creek.dev/docs              Documentation");
}

// --- Helpers ---

/** Node.js built-in modules that may appear as bare imports in bundled workers. */
const NODE_BUILTINS = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console",
  "constants", "crypto", "dgram", "diagnostics_channel", "dns", "domain",
  "events", "fs", "http", "http2", "https", "inspector", "module", "net",
  "os", "path", "perf_hooks", "process", "punycode", "querystring",
  "readline", "repl", "stream", "string_decoder", "sys", "timers",
  "tls", "trace_events", "tty", "url", "util", "v8", "vm", "wasi",
  "worker_threads", "zlib",
]);

/**
 * Patch bare Node.js module imports (e.g. `from "fs"`) to use the `node:` prefix
 * (e.g. `from "node:fs"`). Workerd requires the `node:` prefix for all built-in modules.
 * @internal — exported for testing
 */
export function patchBareNodeImports(code: string): string {
  return code
    .replace(
      /from\s+["']([a-z_]+)["']/g,
      (match, mod) => NODE_BUILTINS.has(mod) ? match.replace(`"${mod}"`, `"node:${mod}"`).replace(`'${mod}'`, `'node:${mod}'`) : match,
    )
    .replace(
      /require\(["']([a-z_]+)["']\)/g,
      (match, mod) => NODE_BUILTINS.has(mod) ? match.replace(`"${mod}"`, `"node:${mod}"`).replace(`'${mod}'`, `'node:${mod}'`) : match,
    );
}

// --- ⚡ Turbo deploy ---

/**
 * Attempt a Turbo deploy: read the local git HEAD SHA, send it to
 * the server with cacheCheck, and if the server has a cached bundle
 * for this exact commit, let it deploy from cache. Returns true if
 * Turbo succeeded (caller should return), false if caller should
 * proceed with normal build + upload.
 *
 * Graceful: any failure (no git, dirty tree, API error, cache miss)
 * silently returns false → normal deploy. Turbo is always opt-in bonus.
 */
async function tryTurboDeploy(
  cwd: string,
  client: CreekClient,
  project: { id: string; slug: string },
  noCache: boolean,
  jsonMode: boolean,
): Promise<boolean> {
  if (noCache) return false;

  // 1. Read git HEAD SHA
  let sha: string;
  try {
    sha = execSync("git rev-parse HEAD", { cwd, encoding: "utf-8" }).trim();
    if (!sha || sha.length < 12) return false;
  } catch {
    return false; // not a git repo or git not installed
  }

  // 2. Check working tree is clean
  try {
    const dirty = execSync("git status --porcelain", { cwd, encoding: "utf-8" }).trim();
    if (dirty) {
      // Uncommitted changes → can't trust cache (source differs from commit)
      return false;
    }
  } catch {
    return false;
  }

  // 3. Detect branch
  let branch = "main";
  try {
    branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd, encoding: "utf-8" }).trim();
  } catch {
    // default to main
  }

  // 4. Ask server to create deployment with cache check
  const shortSha = sha.slice(0, 12);
  if (!jsonMode) {
    consola.info(`  Commit: ${shortSha} (${branch}, clean)`);
    consola.start("  \x1b[33m⚡\x1b[0m Checking build cache...");
  }

  try {
    const res = await client.createDeployment(project.id, {
      branch,
      commitSha: shortSha,
    });

    if (!res.cacheHit) {
      if (!jsonMode) consola.info("  \x1b[2mFirst-time build — building from source\x1b[0m");
      return false;
    }

    // ⚡ Turbo build — server is deploying from cache.
    if (!jsonMode) {
      consola.success("  \x1b[33m⚡\x1b[0m \x1b[1mTurbo build — ready\x1b[0m");
    }

    // Poll until deployment is active (same as normal deploy path)
    const POLL_INTERVAL = 1000;
    const POLL_TIMEOUT = 30_000; // Turbo should be fast — 30s max
    const TERMINAL = new Set(["active", "failed", "cancelled"]);
    let lastStatus = "";
    const start = Date.now();

    while (Date.now() - start < POLL_TIMEOUT) {
      const status = await client.getDeploymentStatus(project.id, res.deployment.id);
      const { status: s } = status.deployment;

      if (s !== lastStatus && !jsonMode) {
        if (s === "deploying") consola.start("  Deploying to edge...");
        lastStatus = s;
      }

      if (TERMINAL.has(s)) {
        if (s === "active") {
          const elapsed = ((Date.now() - start) / 1000).toFixed(1);
          if (jsonMode) {
            jsonOutput({
              ok: true,
              url: status.url ?? status.previewUrl,
              previewUrl: status.previewUrl,
              deploymentId: res.deployment.id,
              project: project.slug,
              mode: "production",
              turbo: true,
              elapsed: `${elapsed}s`,
            }, 0, []);
          }
          consola.success(`  ⬡ Deployed! ${status.url ?? status.previewUrl}`);
          consola.log(`\n  \x1b[33m⚡ Turbo deploy\x1b[0m  ${elapsed}s\n`);
          return true;
        }
        // Failed — don't fall back to normal build (server already tried)
        if (!jsonMode) consola.error(`  Deploy from cache failed: ${status.deployment.error_message || "unknown"}`);
        return true; // return true to prevent double-deploy attempt
      }

      await new Promise((r) => setTimeout(r, POLL_INTERVAL));
    }

    // Timeout — deploy might still complete, but CLI gives up waiting
    if (!jsonMode) consola.warn("  Cache deploy timed out — check `creek status`");
    return true;
  } catch {
    // API error — fall through to normal build
    return false;
  }
}
