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

export const deployCommand = defineCommand({
  meta: {
    name: "deploy",
    description: "Deploy the current project to Creek",
  },
  args: {
    dir: {
      type: "positional",
      description: "Directory to deploy (default: current directory)",
      required: false,
    },
    "skip-build": {
      type: "boolean",
      description: "Skip the build step",
      default: false,
    },
    ...globalArgs,
    template: {
      type: "string",
      description: "Deploy a template (e.g., landing, blog, todo)",
      required: false,
    },
    data: {
      type: "string",
      description: "JSON data for template params (used with --template)",
      required: false,
    },
    path: {
      type: "string",
      description: "Subdirectory within repo to deploy (for monorepos)",
      required: false,
    },
    "from-github": {
      type: "boolean",
      description: "Skip local build; trigger a deploy of the latest commit on the project's production branch via its GitHub connection",
      default: false,
    },
    project: {
      type: "string",
      description: "Target project slug or UUID (required with --from-github when not run inside a project directory)",
      required: false,
    },
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);

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
        return await deployAuthenticated(cwd, resolved, token, args["skip-build"], jsonMode);
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
  const framework = resolved?.framework ?? detectFramework(
    JSON.parse(readFileSync(join(cwd, "package.json"), "utf-8")),
  );

  // Detect Next.js mode (static vs opennext SSR)
  const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf-8"));
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

  // Collect assets
  const isSSR = isSSRFramework(framework);
  const renderMode = isSSR ? "ssr" : "spa";

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

  section("Upload");
  const { assets: clientAssets, fileList } = collectAssets(clientAssetsDir);
  consola.info(`  ${fileList.length} assets (${assetSummary(fileList)})`);

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
  }

  // Deploy to sandbox
  if (!jsonMode) {
    section("Deploy");
    consola.start("  Deploying to edge...");
  }
  try {
    const result = await sandboxDeploy({
      assets: clientAssets,
      serverFiles,
      framework: framework ?? undefined,
      source: "cli",
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

async function deployAuthenticated(cwd: string, resolved: ResolvedConfig, token: string, skipBuild: boolean, jsonMode = false) {
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

    if (isSSR && framework) {
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
    const bundle = {
      manifest: {
        assets: fileList,
        hasWorker: isSSR || isWorker,
        entrypoint: resolved.workerEntry,
        renderMode,
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
          printNextStepHint(renderMode, resolved);
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
