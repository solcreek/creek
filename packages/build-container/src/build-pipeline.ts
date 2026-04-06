/**
 * Creek Build Pipeline — runs inside a CF Container.
 *
 * clone → resolveConfig → install → build → collect → return StagedBundle-compatible output.
 * Uses @solcreek/sdk for all detection (no duplicated regex logic).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

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
  type ResolvedConfig,
} from "@solcreek/sdk";

// --- Types ---

export interface BuildRequest {
  repoUrl: string;
  branch?: string;
  path?: string;
  templateData?: Record<string, unknown>;
}

export interface BuildResult {
  success: true;
  timing: Record<string, number>;
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
  };
}

export interface BuildError {
  error: string;
  message: string;
  timing?: Record<string, number>;
}

// --- Main pipeline ---

export async function buildAndBundle(req: BuildRequest): Promise<BuildResult | BuildError> {
  const timing: Record<string, number> = {};
  const t = () => Date.now();
  let t0: number;

  // 1. Clone
  const buildId = Date.now().toString(36);
  const repoDir = `/tmp/build-${buildId}`;

  t0 = t();
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
    if (stderr.includes("not found")) return { error: "clone_failed", message: `Repository not found: ${req.repoUrl}` };
    if (stderr.includes("Authentication")) return { error: "clone_failed", message: "Private repository — not supported for remote build" };
    return { error: "clone_failed", message: stderr.slice(0, 500) };
  }
  timing.clone = t() - t0;

  // Remove .git immediately (security + disk)
  rmSync(join(repoDir, ".git"), { recursive: true, force: true });

  const workDir = req.path ? join(repoDir, req.path) : repoDir;
  if (!existsSync(workDir)) {
    cleanup(repoDir);
    return { error: "subpath_not_found", message: `Subdirectory '${req.path}' not found` };
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
      return { error: "no_config", message: "No supported project found (creek.toml, wrangler.*, package.json, or index.html)" };
    }

    const framework = resolved.framework;
    const isSSR = isSSRFramework(framework);
    const isWorker = !framework && !!resolved.workerEntry;
    const renderMode = isWorker ? "worker" : (isSSR ? "ssr" : "spa");

    // 3. Install dependencies
    let installResult: BuildResult["install"] = null;
    if (existsSync(join(workDir, "package.json"))) {
      const pm = detectPM(workDir);
      const cmds: Record<string, [string, string[]]> = {
        npm: ["npm", ["install", "--no-audit", "--no-fund"]],
        pnpm: ["pnpm", ["install"]],
        yarn: ["yarn", ["install"]],
      };
      const [cmd, args] = cmds[pm];

      t0 = t();
      try {
        execFileSync(cmd, args, { cwd: workDir, stdio: "pipe", timeout: 120_000 });
        installResult = { success: true, pm };
      } catch (err: any) {
        installResult = { success: false, pm, stderr: (err.stderr?.toString() || "").slice(0, 500) };
      }
      timing.install = t() - t0;
    }

    // 4. Build
    let buildResult: BuildResult["build"] = null;
    if (resolved.buildCommand) {
      t0 = t();
      try {
        execFileSync("npm", ["run", "build"], { cwd: workDir, stdio: "pipe", timeout: 120_000 });
        buildResult = { success: true };
      } catch (err: any) {
        buildResult = { success: false, stderr: (err.stderr?.toString() || "").slice(0, 500) };
      }
      timing.build = t() - t0;
    }

    // 5. Collect client assets
    let assets: Record<string, string> = {};
    let fileList: string[] = [];

    if (!isWorker) {
      const outputDir = join(workDir, resolved.buildOutput);
      if (existsSync(outputDir)) {
        const collected = collectAssetsBase64(outputDir);
        assets = collected.assets;
        fileList = collected.fileList;
      }
    }

    // 6. Collect server files
    let serverFiles: Record<string, string> | undefined;

    if (isSSR && framework && isPreBundledFramework(framework)) {
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

    const result: BuildResult = {
      success: true,
      timing,
      config: {
        wranglerSource: resolved.source.startsWith("wrangler") ? resolved.source : null,
        workerEntry: resolved.workerEntry,
        framework: resolved.framework,
        renderMode,
        summary: formatDetectionSummary(resolved),
      },
      install: installResult,
      build: buildResult,
      bundle: {
        manifest: {
          assets: isWorker ? [] : fileList,
          hasWorker: isSSR || isWorker,
          entrypoint: resolved.workerEntry,
          renderMode,
        },
        assets: isWorker ? {} : assets,
        serverFiles,
        resources: resolvedConfigToResources(resolved),
        bindings: resolvedConfigToBindingRequirements(resolved),
        vars: Object.keys(resolved.vars).length > 0 ? resolved.vars : {},
        compatibilityDate: resolved.compatibilityDate ?? undefined,
        compatibilityFlags: resolved.compatibilityFlags.length > 0 ? resolved.compatibilityFlags : undefined,
      },
    };

    cleanup(repoDir);
    return result;
  } catch (err) {
    cleanup(repoDir);
    return { error: "internal", message: err instanceof Error ? err.message : String(err) };
  }
}

// --- Helpers ---

function detectPM(cwd: string): string {
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
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
