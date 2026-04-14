/**
 * Creek Build Pipeline — runs inside a CF Container.
 *
 * clone → resolveConfig → install → build → collect → return StagedBundle-compatible output.
 * Uses @solcreek/sdk for all detection (no duplicated regex logic).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import {
  resolveConfig,
  resolvedConfigToResources,
  resolvedConfigToBindingRequirements,
  formatDetectionSummary,
  isSSRFramework,
  isPreBundledFramework,
  getSSRServerDir,
  getDefaultBuildOutput,
  collectServerFiles,
  detectAstroCloudflareBuild,
  resolveDeployHint,
  type DeployHint,
  type ResolvedConfig,
} from "@solcreek/sdk";

// --- Types ---

export interface BuildRequest {
  repoUrl: string;
  branch?: string;
  path?: string;
  templateData?: Record<string, unknown>;
}

/**
 * Structured build log line. One per phase boundary and on subprocess
 * output. Collected inside the container and shipped back to the
 * caller (remote-builder or control-plane) as part of BuildResult /
 * BuildError so whatever stores them (R2) has the full transcript.
 */
export interface BuildLogLine {
  ts: number;
  step:
    | "clone"
    | "detect"
    | "install"
    | "build"
    | "bundle"
    | "upload"
    | "provision"
    | "activate"
    | "cleanup";
  stream: "stdout" | "stderr" | "creek";
  level: "debug" | "info" | "warn" | "error" | "fatal";
  msg: string;
  code?: string;
}

export interface BuildResult {
  success: true;
  timing: Record<string, number>;
  logs: BuildLogLine[];
  config: {
    wranglerSource: string | null;
    workerEntry: string | null;
    framework: string | null;
    renderMode: string;
    summary: string;
  };
  install: { success: boolean; pm: string; stderr?: string } | null;
  build: { success: boolean; stderr?: string } | null;
  bundle: {
    manifest: {
      assets: string[];
      hasWorker: boolean;
      entrypoint: string | null;
      renderMode: string;
    };
    assets: Record<string, string>;
    serverFiles: Record<string, string> | undefined;
    resources: { d1: boolean; r2: boolean; kv: boolean; ai: boolean };
    bindings: Array<{ type: string; bindingName: string }>;
    vars: Record<string, string>;
    compatibilityDate: string | undefined;
    compatibilityFlags: string[] | undefined;
    cron: string[] | undefined;
    queue: boolean | undefined;
    hint?: DeployHint;
  };
}

export interface BuildError {
  error: string;
  message: string;
  timing?: Record<string, number>;
  logs?: BuildLogLine[];
}

// --- Main pipeline ---

export async function buildAndBundle(req: BuildRequest): Promise<BuildResult | BuildError> {
  const timing: Record<string, number> = {};
  const t = () => Date.now();
  let t0: number;

  // --- Build log collector ---
  //
  // One flat array we push to at each phase boundary + on captured
  // subprocess stderr when a step fails. Included in every return
  // path (success + error) so the control-plane / dashboard panel
  // always has context, especially for failures.
  const logs: BuildLogLine[] = [];
  const log = (
    step: BuildLogLine["step"],
    level: BuildLogLine["level"],
    msg: string,
    opts?: { stream?: BuildLogLine["stream"]; code?: string },
  ): void => {
    logs.push({
      ts: Date.now(),
      step,
      stream: opts?.stream ?? "creek",
      level,
      msg,
      ...(opts?.code ? { code: opts.code } : {}),
    });
  };

  // 1. Clone
  const buildId = Date.now().toString(36);
  const repoDir = `/tmp/build-${buildId}`;

  t0 = t();
  log("clone", "info", `cloning ${req.repoUrl}${req.branch ? `#${req.branch}` : ""}`);
  try {
    execFileSync("git", [
      "clone", "--depth", "1", "--single-branch",
      ...(req.branch ? ["--branch", req.branch] : []),
      "--no-recurse-submodules",
      "--config", "core.hooksPath=/dev/null",
      req.repoUrl,
      repoDir,
    ], { stdio: "pipe", timeout: 60_000 });
  } catch (err: any) {
    cleanup(repoDir);
    const stderr = err.stderr?.toString() || "";
    log("clone", "error", stderr.slice(0, 500), { stream: "stderr" });
    if (stderr.includes("not found")) return { error: "clone_failed", message: `Repository not found: ${req.repoUrl}`, logs };
    if (stderr.includes("Authentication")) return { error: "clone_failed", message: "Private repository — not supported for remote build", logs };
    return { error: "clone_failed", message: stderr.slice(0, 500), logs };
  }
  timing.clone = t() - t0;
  log("clone", "info", `cloned in ${timing.clone}ms`);

  // Remove .git immediately (security + disk)
  rmSync(join(repoDir, ".git"), { recursive: true, force: true });

  const workDir = req.path ? join(repoDir, req.path) : repoDir;
  if (!existsSync(workDir)) {
    cleanup(repoDir);
    return { error: "subpath_not_found", message: `Subdirectory '${req.path}' not found`, logs };
  }

  try {
    // 2a. Apply template data (if provided)
    if (req.templateData) {
      await applyTemplateData(workDir, req.templateData);
    }

    // 2. Resolve config (SDK does all detection)
    let resolved: ResolvedConfig;
    try {
      resolved = resolveConfig(workDir);
    } catch {
      cleanup(repoDir);
      log("detect", "error", "no supported config found");
      return { error: "no_config", message: "No supported project found (creek.toml, wrangler.*, package.json, or index.html)", logs };
    }

    const framework = resolved.framework;
    const isSSR = isSSRFramework(framework);
    const isWorker = !framework && !!resolved.workerEntry;
    const renderMode = isWorker ? "worker" : (isSSR ? "ssr" : "spa");
    log(
      "detect",
      "info",
      `framework=${framework ?? "none"} renderMode=${renderMode} buildCmd=${resolved.buildCommand ?? "none"}`,
    );

    // 2b. Framework-aware post-deploy hints (admin URLs, warnings, etc.)
    // Pure metadata — no build or runtime side effects. Resolved from
    // the target's package.json deps so it works for any framework
    // whether or not we specialise the build for it.
    let deployHint: DeployHint | null = null;
    const pkgPathForHint = join(workDir, "package.json");
    if (existsSync(pkgPathForHint)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPathForHint, "utf-8"));
        deployHint = resolveDeployHint(pkg);
      } catch {
        // ignore — malformed package.json isn't fatal for hint resolution
      }
    }

    // 3. Install dependencies
    let installResult: BuildResult["install"] = null;
    let pm = "npm";
    if (existsSync(join(workDir, "package.json"))) {
      pm = detectPM(workDir, repoDir);
      const cmds: Record<string, [string, string[]]> = {
        npm: ["npm", ["install", "--no-audit", "--no-fund"]],
        pnpm: ["pnpm", ["install"]],
        yarn: ["yarn", ["install"]],
      };
      const [cmd, args] = cmds[pm];

      log("install", "info", `${cmd} ${args.join(" ")}`);
      t0 = t();
      try {
        execFileSync(cmd, args, { cwd: workDir, stdio: "pipe", timeout: 180_000 });
        installResult = { success: true, pm };
      } catch (err: any) {
        installResult = { success: false, pm, stderr: (err.stderr?.toString() || "").slice(0, 2000) };
      }
      timing.install = t() - t0;

      // Fail fast on install errors — running the build afterwards
      // would silently "succeed" with an empty `dist/` and surface a
      // misleading "no output files" message much later in the pipeline.
      if (!installResult.success) {
        log("install", "error", installResult.stderr ?? "install failed", { stream: "stderr" });
        cleanup(repoDir);
        return {
          error: "install_failed",
          message: `${pm} install failed: ${installResult.stderr?.slice(0, 800) || "unknown error"}`,
          logs,
        };
      }
      log("install", "info", `installed in ${timing.install}ms`);
    }

    // 4. Build — use the detected package manager so pnpm-specific
    // features (catalog:, workspace protocols, custom hooks) resolve
    // correctly. `npm run build` worked by accident for most projects
    // because it only invokes scripts, but pnpm run uses the workspace
    // context when available.
    //
    // Workspace fast-path (pnpm monorepos with `workspace:*` deps):
    // if the target `package.json` pulls in internal workspace
    // packages, `pnpm install` only symlinks them — their source has
    // never been built, so `astro build` / `vite build` will fail to
    // resolve imports like `@emdash-cms/cloudflare` (no `dist/` to
    // read entries from). Use `pnpm --filter <pkg>... build` which
    // selects the target AND all of its workspace dependencies and
    // runs `build` in topological order. Scoped to pnpm because the
    // filter syntax is pnpm-specific.
    let buildResult: BuildResult["build"] = null;
    if (resolved.buildCommand) {
      const { useCascade, targetName } = detectWorkspaceCascade(workDir, pm);

      const buildCmdLabel = useCascade && targetName
        ? `pnpm --filter ${targetName}... build`
        : `${pm} run build`;
      log("build", "info", buildCmdLabel);
      t0 = t();
      try {
        if (useCascade && targetName) {
          execFileSync("pnpm", ["--filter", `${targetName}...`, "build"], {
            cwd: repoDir,
            stdio: "pipe",
            timeout: 300_000,
          });
        } else {
          execFileSync(pm, ["run", "build"], {
            cwd: workDir,
            stdio: "pipe",
            timeout: 180_000,
          });
        }
        buildResult = { success: true };
      } catch (err: any) {
        buildResult = { success: false, stderr: (err.stderr?.toString() || "").slice(0, 2000) };
      }
      timing.build = t() - t0;

      // Same reasoning as install: surface the real stderr instead of
      // the downstream "no output files" cover-up.
      if (!buildResult.success) {
        log("build", "error", buildResult.stderr ?? "build failed", { stream: "stderr" });
        cleanup(repoDir);
        const label = useCascade ? "workspace cascade build" : `${pm} run build`;
        return {
          error: useCascade ? "workspace_build_failed" : "build_failed",
          message: `${label} failed: ${buildResult.stderr?.slice(0, 800) || "unknown error"}`,
          logs,
        };
      }
      log("build", "info", `built in ${timing.build}ms`);
    }

    // 4c. Detect pre-bundled Astro + `@astrojs/cloudflare` adapter
    // output. Framework detection happens pre-install from
    // package.json, so `resolved.framework === "astro"` could be
    // either SSG (static `dist/`) or CF-adapter-SSR — we only know
    // which once we can see the build output. See the SDK helper
    // for the detection fingerprint.
    const astroCF =
      framework === "astro" ? detectAstroCloudflareBuild(workDir) : null;

    // 5. Collect client assets
    let assets: Record<string, string> = {};
    let fileList: string[] = [];

    if (!isWorker) {
      const outputDir = astroCF
        ? join(workDir, astroCF.assetsDir)
        : join(workDir, resolved.buildOutput);
      if (existsSync(outputDir)) {
        const collected = collectAssetsBase64(outputDir);
        assets = collected.assets;
        fileList = collected.fileList;
      }
    }

    // 6. Collect server files
    let serverFiles: Record<string, string> | undefined;

    if (astroCF) {
      // Pre-bundled Astro CF adapter output: upload dist/server/ as worker modules.
      const serverDir = join(workDir, astroCF.serverDir);
      const collected = collectServerFiles(serverDir);
      serverFiles = Object.fromEntries(
        Object.entries(collected).map(([p, buf]) => [p, buf.toString("base64")]),
      );
    } else if (isSSR && framework && isPreBundledFramework(framework)) {
      // Pre-bundled SSR: upload entire server directory
      const serverDirRel = getSSRServerDir(framework);
      if (serverDirRel) {
        const serverDir = join(workDir, serverDirRel);
        if (existsSync(serverDir)) {
          const collected = collectServerFiles(serverDir);
          serverFiles = Object.fromEntries(
            Object.entries(collected).map(([p, buf]) => [p, buf.toString("base64")]),
          );
        }
      }
    } else if (isWorker && resolved.workerEntry) {
      // Pure Worker: esbuild bundle
      const entryPath = join(workDir, resolved.workerEntry);
      if (existsSync(entryPath)) {
        t0 = t();
        try {
          const outFile = join(workDir, "__creek_worker.mjs");
          execFileSync("esbuild", [
            entryPath, "--bundle", "--format=esm", "--platform=neutral",
            "--target=es2022", `--outfile=${outFile}`,
            "--external:node:*",
            "--conditions=workerd,worker,import",
          ], { stdio: "pipe", timeout: 30_000 });
          serverFiles = { "worker.js": readFileSync(outFile).toString("base64") };
          timing.bundle = t() - t0;
        } catch {
          // esbuild failed — try raw file
          if (existsSync(entryPath)) {
            serverFiles = { "worker.js": readFileSync(entryPath).toString("base64") };
          }
        }
      }
    }

    timing.total = Object.values(timing).reduce((a, b) => a + b, 0);

    // If the Astro CF adapter fired, upgrade the pre-build render mode
    // ("spa", assumed because framework === "astro") to actual "ssr".
    // The adapter also generates its own wrangler.json inside
    // dist/server/ whose "main" field points to entry.mjs — that's
    // the real Worker entrypoint, not the user-level wrangler.main.
    const effectiveRenderMode = astroCF ? "ssr" : renderMode;
    const effectiveHasWorker = astroCF ? true : (isSSR || isWorker);
    const effectiveEntrypoint = astroCF ? "entry.mjs" : resolved.workerEntry;

    // Merge adapter-emitted bindings on top of user-declared ones.
    // `@astrojs/cloudflare` injects bindings the user's root
    // wrangler.jsonc never mentions — most notably SESSION (KV),
    // IMAGES, and `worker_loaders` — into `dist/server/wrangler.json`.
    // Without this merge, sandbox-api only provisions the user-visible
    // subset and the Worker crashes on runtime access to env.SESSION.
    // Adapter-merged bindings can include types beyond the SDK's
    // narrow union (worker_loader, images), so widen to the broader
    // shape sandbox-api accepts.
    let effectiveBindings: Array<{ type: string; bindingName: string }> =
      resolvedConfigToBindingRequirements(resolved);
    if (astroCF) {
      const adapterWranglerPath = join(workDir, astroCF.serverDir, "wrangler.json");
      if (existsSync(adapterWranglerPath)) {
        try {
          const adapterWrangler = JSON.parse(readFileSync(adapterWranglerPath, "utf-8"));
          effectiveBindings = mergeAdapterBindings(effectiveBindings, adapterWrangler);
        } catch {
          // Malformed adapter JSON — keep user-declared bindings only
        }
      }
    }

    log(
      "bundle",
      "info",
      `${fileList.length} assets, ${serverFiles ? Object.keys(serverFiles).length : 0} server files`,
    );

    const result: BuildResult = {
      success: true,
      timing,
      logs,
      config: {
        wranglerSource: resolved.source.startsWith("wrangler") ? resolved.source : null,
        workerEntry: resolved.workerEntry,
        framework: resolved.framework,
        renderMode: effectiveRenderMode,
        summary: formatDetectionSummary(resolved),
      },
      install: installResult,
      build: buildResult,
      bundle: {
        manifest: {
          assets: isWorker ? [] : fileList,
          hasWorker: effectiveHasWorker,
          entrypoint: effectiveEntrypoint,
          renderMode: effectiveRenderMode,
        },
        assets: isWorker ? {} : assets,
        serverFiles,
        resources: resolvedConfigToResources(resolved),
        bindings: effectiveBindings,
        vars: Object.keys(resolved.vars).length > 0 ? resolved.vars : {},
        compatibilityDate: resolved.compatibilityDate ?? undefined,
        compatibilityFlags: resolved.compatibilityFlags.length > 0 ? resolved.compatibilityFlags : undefined,
        cron: resolved.cron.length > 0 ? resolved.cron : undefined,
        queue: resolved.queue || undefined,
        hint: deployHint ?? undefined,
      },
    };

    cleanup(repoDir);
    return result;
  } catch (err) {
    cleanup(repoDir);
    const msg = err instanceof Error ? err.message : String(err);
    log("cleanup", "fatal", msg, { stream: "stderr" });
    return { error: "internal", message: msg, logs };
  }
}

// --- Helpers ---

/**
 * Merge binding requirements emitted by an adapter's generated
 * `wrangler.json` on top of those derived from the user's root
 * config. Adapters (most notably `@astrojs/cloudflare`) inject bindings
 * the user never wrote — SESSION (KV), IMAGES, `worker_loaders` — and
 * the Worker will crash at runtime if we don't provision them.
 *
 * User-declared entries take precedence on binding-name conflict so
 * a user explicitly overriding a binding isn't silently clobbered.
 */
// SDK's `BindingRequirement` is currently typed to "d1"|"r2"|"kv"|"ai".
// Adapters can declare more (worker_loader for plugin sandboxes,
// images for the CF Images binding). We widen the union locally and
// hand the result back as a loosely-typed array — sandbox-api +
// deploy-core both accept `string` for binding type.
type BindingType = "d1" | "r2" | "kv" | "ai" | "worker_loader" | "images";
type BindingReq = { type: BindingType; bindingName: string };

export function mergeAdapterBindings(
  existing: ReadonlyArray<{ type: string; bindingName: string }>,
  adapterWrangler: Record<string, unknown>,
): BindingReq[] {
  const seen = new Set(existing.map((b) => `${b.type}:${b.bindingName}`));
  // Cast existing entries; their type field is already one of the
  // narrower SDK union members, so this is safe.
  const out: BindingReq[] = existing.map((b) => ({
    type: b.type as BindingType,
    bindingName: b.bindingName,
  }));

  const push = (type: BindingType, bindingName: string) => {
    const key = `${type}:${bindingName}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ type, bindingName });
    }
  };

  const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

  for (const d1 of arr<{ binding?: string }>(adapterWrangler.d1_databases)) {
    if (d1.binding) push("d1", d1.binding);
  }
  for (const r2 of arr<{ binding?: string }>(adapterWrangler.r2_buckets)) {
    if (r2.binding) push("r2", r2.binding);
  }
  for (const kv of arr<{ binding?: string }>(adapterWrangler.kv_namespaces)) {
    if (kv.binding) push("kv", kv.binding);
  }
  // Plugin sandbox (Dynamic Workers) — the binding declaration alone
  // is what enables `env.LOADER`. No resource provisioning needed;
  // sandbox-api treats this as "declare-only".
  for (const wl of arr<{ binding?: string }>(adapterWrangler.worker_loaders)) {
    if (wl.binding) push("worker_loader", wl.binding);
  }
  // CF Images binding — account-level service, declare-only.
  const images = adapterWrangler.images as { binding?: string } | undefined;
  if (images?.binding) push("images", images.binding);
  return out;
}

/**
 * Detect package manager by walking up the directory tree from `cwd`
 * until a lockfile or workspace root is found, or we reach `stopAt`
 * (the repo root, so we never escape the cloned project).
 *
 * Walking up matters for monorepos: the lockfile lives at the
 * workspace root, not inside `templates/starter/` or `apps/web/`.
 * Without this, a pnpm workspace subdir looks like `npm` to us,
 * `npm install` runs, and fails on `catalog:` / `workspace:*`
 * references — producing a misleading "no output files" error
 * three steps later.
 */
/**
 * Detect whether the target should be built via `pnpm --filter` cascade
 * instead of a plain `pnpm run build` in the subdirectory.
 *
 * Trigger condition: the target's `package.json` imports at least one
 * internal `workspace:*` package AND the active PM is pnpm. In that
 * case, `pnpm install` has only symlinked the workspace packages;
 * their `dist/` still needs building (typically by running each
 * package's `build` script in topological order) before the target
 * can resolve imports like `@emdash-cms/cloudflare`.
 *
 * Non-pnpm monorepos fall back to the plain build — they don't have
 * equivalent filter syntax (yarn workspaces have `yarn workspaces focus`
 * but semantics differ). Surfacing the real stderr via Gap B is still
 * better than the old silent failure.
 */
export function detectWorkspaceCascade(
  targetDir: string,
  pm: string,
): { useCascade: boolean; targetName: string | null } {
  if (pm !== "pnpm") return { useCascade: false, targetName: null };
  const pkgPath = join(targetDir, "package.json");
  if (!existsSync(pkgPath)) return { useCascade: false, targetName: null };
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
      name?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const hasWorkspaceDep = Object.values({
      ...pkg.dependencies,
      ...pkg.devDependencies,
    }).some((v) => typeof v === "string" && v.startsWith("workspace:"));
    if (!hasWorkspaceDep) return { useCascade: false, targetName: null };
    if (!pkg.name) return { useCascade: false, targetName: null };
    return { useCascade: true, targetName: pkg.name };
  } catch {
    return { useCascade: false, targetName: null };
  }
}

export function detectPM(cwd: string, stopAt: string): string {
  let dir = cwd;
  while (true) {
    if (existsSync(join(dir, "pnpm-lock.yaml")) || existsSync(join(dir, "pnpm-workspace.yaml"))) return "pnpm";
    if (existsSync(join(dir, "yarn.lock"))) return "yarn";
    if (existsSync(join(dir, "package-lock.json"))) return "npm";
    if (dir === stopAt) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "npm";
}

const IGNORE_DIRS = new Set(["node_modules", ".git", ".svn", ".next", ".nuxt", ".output"]);
const IGNORE_FILES = new Set([".DS_Store", ".env", ".env.local", ".env.production"]);

function collectAssetsBase64(dir: string, base?: string): { assets: Record<string, string>; fileList: string[] } {
  const b = base ?? dir;
  const assets: Record<string, string> = {};
  const fileList: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = collectAssetsBase64(full, b);
      Object.assign(assets, sub.assets);
      fileList.push(...sub.fileList);
    } else if (entry.isFile() && !IGNORE_FILES.has(entry.name)) {
      const rel = relative(b, full);
      assets[rel] = readFileSync(full).toString("base64");
      fileList.push(rel);
    }
  }
  return { assets, fileList };
}

/**
 * Apply template data: validate against creek-template.json schema,
 * merge into creek-data.json, remove creek-template.json.
 */
async function applyTemplateData(workDir: string, data: Record<string, unknown>): Promise<void> {
  const configPath = join(workDir, "creek-template.json");
  const dataPath = join(workDir, "creek-data.json");

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
      const { $schema: _, ...schemaWithoutMeta } = templateConfig.schema;
      const validate = ajv.compile(schemaWithoutMeta);

      if (!validate(merged)) {
        const errors = (validate.errors ?? [])
          .map((e: any) => `${e.instancePath || "/"}: ${e.message}`)
          .join("; ");
        throw new Error(`Template data validation failed: ${errors}`);
      }
    }
    // Remove creek-template.json (metadata, not project file)
    rmSync(configPath);
  }

  // Write merged data
  writeFileSync(dataPath, JSON.stringify(merged, null, 2) + "\n");
}

function cleanup(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}
