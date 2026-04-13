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
  resolvedConfigToResources,
  resolvedConfigToBindingRequirements,
  ConfigNotFoundError,
  getSSRServerDir,
  collectServerFiles,
  isPreBundledFramework,
  detectAstroCloudflareBuild,
  detectNextjsMode,
  detectMonorepo,
  type Framework,
  type ResolvedConfig,
} from "@solcreek/sdk";
import { getToken, getApiUrl } from "../utils/config.js";
import { collectAssets } from "../utils/bundle.js";
import { bundleSSRServer } from "../utils/ssr-bundle.js";
import { bundleWorker } from "../utils/worker-bundle.js";
import { sandboxDeploy, pollSandboxStatus, printSandboxSuccess } from "../utils/sandbox.js";
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
    wouldDeploy,
    sideEffects: {
      networkCalls: false,
      fileUploads: false,
      buildExecuted: false,
      tosPromptShown: false,
    },
    nextStep: wouldDeploy
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

  // Detect Next.js mode (static vs opennext SSR)
  const nextjsMode = framework === "nextjs" ? detectNextjsMode(pkg, cwd) : null;
  const monorepo = detectMonorepo(cwd);

  section("Detect");
  consola.info(`  Framework: ${framework ?? "static site"}`);
  if (nextjsMode) consola.info(`  Next.js mode: ${nextjsMode}${monorepo.isMonorepo ? " (monorepo)" : ""}`);
  consola.info("  Mode: sandbox (60 min preview)");

  // Build
  if (!skipBuild) {
    section("Build");

    if (nextjsMode === "opennext") {
      // Next.js SSR on CF Workers: adapter (>= 16.2) or legacy opennext
      try {
        buildNextjs(cwd, monorepo.isMonorepo);
      } catch {
        consola.error("Next.js build failed");
        process.exit(1);
      }
      consola.success("  Build complete");
    } else {
      const buildCommand = resolved?.buildCommand || "npm run build";
      if (!buildCommand) {
        consola.error("No build script found in package.json.");
        consola.info("Add a 'build' script or use --skip-build if already built.");
        process.exit(1);
      }

      consola.start(`  ${buildCommand}`);
      try {
        execSync(buildCommand, { cwd, stdio: "inherit" });
      } catch {
        consola.error("Build failed");
        consola.info("");
        consola.info("  Common fixes:");
        consola.info("    npm install (missing dependencies?)");
        consola.info("    Check for TypeScript errors");
        process.exit(1);
      }
      consola.success("  Build complete");
    }
  }

  const useAdapterOutput = framework === "nextjs" && hasAdapterOutput(cwd);
  const outputDir = useAdapterOutput
    ? resolve(cwd, ".creek/adapter-output")
    : resolve(cwd, resolved?.buildOutput ?? getDefaultBuildOutput(framework));

  if (!existsSync(outputDir)) {
    consola.error(`Build output not found: ${outputDir}`);
    if (framework) {
      consola.info(`Expected output for ${framework}: ${getDefaultBuildOutput(framework)}`);
    }
    process.exit(1);
  }

  // Collect assets + determine render mode.
  //
  // Three shapes, mirroring the authenticated deploy path:
  //   1. Framework-detected SSR (Astro/Nuxt/etc.) → bundle the framework's
  //      server entry, upload dist/ as assets.
  //   2. User-declared Worker (`[build].worker` in creek.toml, no framework)
  //      → bundle the Worker entry with esbuild, serverFiles = { worker.js }.
  //      `dist/` assets are skipped for now — the "Workers + Static Assets
  //      coexist" zero-config pattern is tracked separately and requires
  //      build-pipeline changes; until it lands, users inline HTML/JS/CSS
  //      into the Worker (see docs).
  //   3. Neither → plain SPA/static, everything goes as assets.
  const isSSR = isSSRFramework(framework);
  const isWorker = !framework && !!resolved?.workerEntry;
  const renderMode = isWorker ? "worker" : (isSSR ? "ssr" : "spa");

  let clientAssets: Record<string, string> = {};
  let fileList: string[] = [];
  if (!isWorker) {
    let clientAssetsDir: string;
    if (useAdapterOutput) {
      clientAssetsDir = resolve(outputDir, "assets");
    } else {
      clientAssetsDir = outputDir;
      if (isSSR && framework) {
        const subdir = getClientAssetsDir(framework);
        if (subdir) clientAssetsDir = resolve(outputDir, subdir);
      }
    }
    const collected = collectAssets(clientAssetsDir);
    clientAssets = collected.assets;
    fileList = collected.fileList;
  }

  section("Upload");
  if (isWorker) {
    consola.info(`  Worker mode (${resolved!.workerEntry})`);
  } else {
    consola.info(`  ${fileList.length} assets (${assetSummary(fileList)})`);
  }

  let serverFiles: Record<string, string> | undefined;
  if (isSSR && framework) {
    const serverEntry = getSSRServerEntry(framework);
    if (serverEntry) {
      const serverEntryPath = resolve(outputDir, serverEntry);
      if (existsSync(serverEntryPath)) {
        consola.start("  Bundling SSR server...");
        const bundled = await bundleSSRServer(serverEntryPath);
        serverFiles = { "server.js": Buffer.from(bundled).toString("base64") };
        consola.success(`  SSR bundled (${Math.round(bundled.length / 1024)}KB)`);
      }
    }
  } else if (isWorker && resolved?.workerEntry) {
    const workerEntryPath = resolve(cwd, resolved.workerEntry);
    if (!existsSync(workerEntryPath)) {
      consola.error(`Worker entry not found: ${resolved.workerEntry}`);
      process.exit(1);
    }
    consola.start("  Bundling worker...");
    const bundled = await bundleWorker(workerEntryPath, cwd, {
      hasClientAssets: false,
    });
    serverFiles = { "worker.js": Buffer.from(bundled).toString("base64") };
    consola.success(`  Worker bundled (${Math.round(bundled.length / 1024)}KB)`);
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
        hasWorker: isSSR || isWorker,
        entrypoint: resolved?.workerEntry ?? null,
        renderMode,
      },
      assets: clientAssets,
      serverFiles,
      framework: framework ?? undefined,
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

    // Determine deploy mode
    const framework = resolved.framework;
    const isSSR = isSSRFramework(framework);
    const isWorker = !framework && !!resolved.workerEntry;
    const renderMode = isWorker ? "worker" : (isSSR ? "ssr" : "spa");

    // Detect Next.js mode for special build handling
    const pkg = existsSync(join(cwd, "package.json"))
      ? JSON.parse(readFileSync(join(cwd, "package.json"), "utf-8"))
      : {};
    const nextjsMode = framework === "nextjs" ? detectNextjsMode(pkg, cwd) : null;
    const monorepo = framework === "nextjs" ? detectMonorepo(cwd) : { isMonorepo: false, root: null };

    if (nextjsMode) {
      if (!jsonMode) consola.info(`  Next.js mode: ${nextjsMode}${monorepo.isMonorepo ? " (monorepo)" : ""}`);
    }

    // --- ⚡ Turbo deploy: check if server has a cached build for this commit ---
    // Read the local git HEAD SHA. If the working tree is clean and the
    // server has a cached bundle for this exact commit, skip the entire
    // local build + upload and let the server deploy from cache.
    const turboResult = await tryTurboDeploy(cwd, client, project, noCache, jsonMode);
    if (turboResult) {
      return; // ⚡ done — server deployed from cache
    }

    // Build (skip for pure Workers with no build command)
    if (!skipBuild && resolved.buildCommand) {
      section("Build");

      if (nextjsMode === "opennext") {
        try {
          buildNextjs(cwd, monorepo.isMonorepo);
        } catch {
          consola.error("Next.js build failed");
          process.exit(1);
        }
        consola.success("  Build complete");
      } else {
        const buildCmd = resolved.buildCommand;
        if (buildCmd.length > 500) {
          consola.error("Invalid build command (too long)");
          process.exit(1);
        }
        consola.start(`  ${buildCmd}`);
        try {
          execSync(buildCmd, { cwd, stdio: "inherit" });
        } catch {
          consola.error("Build failed");
          process.exit(1);
        }
        consola.success("  Build complete");
      }
    }

    // Post-build detection: Astro + @astrojs/cloudflare produces a
    // pre-bundled Worker (dist/server/entry.mjs) + split client assets
    // (dist/client/). We can only detect this after build — before
    // build `framework === "astro"` could mean SSG or CF-adapter-SSR.
    const astroCF =
      framework === "astro" ? detectAstroCloudflareBuild(cwd) : null;

    // Collect client assets
    // Worker + SPA hybrid: if a Worker project has buildOutput with built files, collect them too
    let clientAssets: Record<string, string> = {};
    let fileList: string[] = [];
    const workerHasClientAssets = isWorker && resolved.buildOutput && resolved.buildOutput !== "." &&
      existsSync(resolve(cwd, resolved.buildOutput));

    if (!isWorker || workerHasClientAssets) {
      let clientAssetsDir: string;

      // Adapter output takes precedence for Next.js
      if (framework === "nextjs" && hasAdapterOutput(cwd)) {
        clientAssetsDir = resolve(cwd, ".creek/adapter-output/assets");
      } else if (astroCF) {
        // Astro CF adapter splits its output: client assets live in
        // dist/client/ (not dist/), so redirect the collector there.
        clientAssetsDir = resolve(cwd, astroCF.assetsDir);
      } else {
        const outputDir = resolve(cwd, resolved.buildOutput);
        if (!existsSync(outputDir)) {
          consola.error(`Build output directory not found: ${resolved.buildOutput}`);
          process.exit(1);
        }
        clientAssetsDir = outputDir;
        if (isSSR && framework) {
          const clientSubdir = getClientAssetsDir(framework);
          if (clientSubdir) {
            clientAssetsDir = resolve(outputDir, clientSubdir);
          }
        }
      }

      section("Upload");
      ({ assets: clientAssets, fileList } = collectAssets(clientAssetsDir));
      consola.info(`  ${fileList.length} assets (${assetSummary(fileList)})`);
    }

    // Bundle server/worker files
    let serverFiles: Record<string, string> | undefined;

    if (astroCF) {
      // Astro CF adapter: upload dist/server/ as worker modules
      // (same shape Nuxt/SolidStart use — pre-bundled, do not re-bundle).
      const serverDir = resolve(cwd, astroCF.serverDir);
      if (existsSync(serverDir)) {
        consola.start("  Collecting Astro CF server files...");
        const collected = collectServerFiles(serverDir);
        const fileCount = Object.keys(collected).length;
        serverFiles = Object.fromEntries(
          Object.entries(collected).map(([p, buf]) => [p, buf.toString("base64")]),
        );
        consola.success(`  Astro CF worker: ${fileCount} files`);
      }
    } else if (isSSR && framework) {
      if (framework === "nextjs" && hasAdapterOutput(cwd)) {
        // Adapter path: read pre-bundled output from .creek/adapter-output/
        const adapterServerDir = resolve(cwd, ".creek/adapter-output/server");
        consola.start("  Collecting adapter output...");

        const collected: Record<string, Buffer> = {};
        if (existsSync(adapterServerDir)) {
          for (const f of readdirSync(adapterServerDir)) {
            const fp = join(adapterServerDir, f);
            if (!statSync(fp).isFile()) continue;
            if (f.endsWith(".map")) continue;
            let content = readFileSync(fp);
            // Patch bare Node.js module imports → node: prefix (workerd requires it)
            // Note: nodejs_compat_v2 handles most modules, but bare specifiers
            // (without node: prefix) still need patching.
            if (f.endsWith(".js") || f.endsWith(".mjs")) {
              content = Buffer.from(patchBareNodeImports(content.toString("utf-8")));
            }
            collected[f] = content;
          }
        }

        const fileCount = Object.keys(collected).length;
        serverFiles = Object.fromEntries(
          Object.entries(collected).map(([p, buf]) => [p, buf.toString("base64")]),
        );
        consola.success(`  Worker bundled: ${fileCount} files (${Math.round(Object.values(collected).reduce((s, b) => s + b.length, 0) / 1024)}KB)`);
      } else if (framework === "nextjs") {
        // Legacy path: use wrangler to produce a single bundled worker
        const bundleDir = resolve(cwd, ".creek/bundled");
        consola.start("  Bundling Next.js worker (legacy)...");
        execSync(`npx wrangler deploy --dry-run --outdir "${bundleDir}"`, { cwd, stdio: "pipe" });

        patchBundledWorker(bundleDir, resolve(cwd, ".open-next"));

        const collected: Record<string, Buffer> = {};
        if (existsSync(bundleDir)) {
          for (const f of readdirSync(bundleDir)) {
            const fp = join(bundleDir, f);
            if (!statSync(fp).isFile()) continue;
            if (f.endsWith(".map") || f === "README.md") continue;
            collected[f] = readFileSync(fp);
          }
        }

        const fileCount = Object.keys(collected).length;
        serverFiles = Object.fromEntries(
          Object.entries(collected).map(([p, buf]) => [p, buf.toString("base64")]),
        );
        consola.success(`  Worker bundled: ${fileCount} files (${Math.round(Object.values(collected).reduce((s, b) => s + b.length, 0) / 1024)}KB)`);
      } else if (isPreBundledFramework(framework)) {
        // Other pre-bundled SSR frameworks (Nuxt, SvelteKit, etc.)
        const serverDirRel = getSSRServerDir(framework);
        if (serverDirRel) {
          const serverDir = resolve(cwd, serverDirRel);
          if (existsSync(serverDir)) {
            consola.start("  Collecting SSR server files...");
            const collected = collectServerFiles(serverDir);
            const fileCount = Object.keys(collected).length;
            serverFiles = Object.fromEntries(
              Object.entries(collected).map(([p, buf]) => [p, buf.toString("base64")]),
            );
            consola.success(`  SSR server: ${fileCount} files`);
          }
        }
      } else {
        // Non-pre-bundled SSR: esbuild single-file bundle (fallback)
        const outputDir = resolve(cwd, resolved.buildOutput);
        const serverEntry = getSSRServerEntry(framework);
        if (serverEntry) {
          const serverEntryPath = resolve(outputDir, serverEntry);
          if (existsSync(serverEntryPath)) {
            consola.start("  Bundling SSR server...");
            const bundled = await bundleSSRServer(serverEntryPath);
            serverFiles = {
              "server.js": Buffer.from(bundled).toString("base64"),
            };
            consola.success(`  SSR bundled (${Math.round(bundled.length / 1024)}KB)`);
          }
        }
      }
    } else if (isWorker && resolved.workerEntry) {
      // Worker: auto-generate _setEnv wrapper + esbuild bundle
      const workerEntryPath = resolve(cwd, resolved.workerEntry);
      if (existsSync(workerEntryPath)) {
        section("Bundle");
        consola.start("  Bundling worker...");
        const bundled = await bundleWorker(workerEntryPath, cwd, {
          hasClientAssets: !!workerHasClientAssets,
        });
        serverFiles = {
          "worker.js": Buffer.from(bundled).toString("base64"),
        };
        consola.success(`  Worker bundled (${Math.round(bundled.length / 1024)}KB)`);
      } else {
        consola.error(`Worker entry not found: ${resolved.workerEntry}`);
        process.exit(1);
      }
    }

    section("Deploy");
    consola.start("  Creating deployment...");
    const { deployment } = await client.createDeployment(project.id);

    consola.start("  Uploading bundle...");
    // If the Astro CF adapter fired post-build, the project is actually
    // SSR (not SPA): overwrite the pre-build-computed renderMode and
    // point the entrypoint at the adapter-emitted entry.mjs.
    const effectiveRenderMode = astroCF ? "ssr" : renderMode;
    const effectiveHasWorker = astroCF ? true : (isSSR || isWorker);
    const effectiveEntrypoint = astroCF ? "entry.mjs" : resolved.workerEntry;
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
      // Backward compat: boolean flags
      resources: resolvedConfigToResources(resolved),
      // New: binding declarations with user-defined names
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
        lastStatus = status;
      }

      if (status === "active") {
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
