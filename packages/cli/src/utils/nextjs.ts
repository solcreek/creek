/**
 * Next.js-specific build utilities for Creek CLI.
 *
 * Two build paths:
 * - **Adapter path** (Next.js >= 16.2.3): Uses @solcreek/adapter-creek via
 *   NEXT_ADAPTER_PATH. Zero workarounds, typed outputs, direct esbuild bundle.
 *   Min version reflects the adapter's peerDependency (CVE-2026-23869).
 * - **Legacy path** (Next.js < 16.2.3): Uses @opennextjs/cloudflare with
 *   workarounds (standalone patch, middleware manifest inline, etc.)
 *
 * The CLI auto-detects the Next.js version and picks the right path.
 */

import { existsSync, cpSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { execSync, execFileSync } from "node:child_process";
import consola from "consola";

// ---------------------------------------------------------------------------
// Version detection + unified entry point
// ---------------------------------------------------------------------------

/** Read the installed Next.js version from node_modules. */
export function getNextVersion(cwd: string): string | null {
  try {
    const pkgPath = join(cwd, "node_modules/next/package.json");
    return JSON.parse(readFileSync(pkgPath, "utf-8")).version;
  } catch {
    return null;
  }
}

/** Simple semver >= comparison (major.minor.patch only). */
function semverGte(version: string, target: string): boolean {
  const parse = (v: string) => v.split(".").map(Number);
  const [aMaj, aMin, aPat] = parse(version);
  const [bMaj, bMin, bPat] = parse(target);
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  return aPat >= bPat;
}

/**
 * Build a Next.js app using the Creek adapter (>= 16.2.3).
 *
 * Sets NEXT_ADAPTER_PATH to the adapter bundled with the CLI.
 * No opennext, no wrangler, no config patching — the adapter handles
 * everything inside onBuildComplete().
 */
function resolveAdapterPath(): string | null {
  try {
    const require = createRequire(import.meta.url);
    return require.resolve("@solcreek/adapter-creek");
  } catch {
    return null;
  }
}

function buildWithAdapter(cwd: string): void {
  const adapterPath = resolveAdapterPath();
  if (!adapterPath) {
    consola.warn("  @solcreek/adapter-creek not found — install it for optimal Next.js builds");
    return; // caller falls back to legacy
  }

  consola.start("  Building Next.js with Creek adapter...\n");
  // --webpack is required: Turbopack does not generate standalone output,
  // and its chunked format uses a custom runtime incompatible with esbuild.
  execSync("npx next build --webpack", {
    cwd,
    stdio: "inherit",
    env: { ...process.env, NEXT_ADAPTER_PATH: adapterPath },
  });
}

/**
 * Unified Next.js build entry point.
 *
 * - Next.js >= 16.2.3: Creek adapter path (recommended)
 * - Next.js < 16.2.3: legacy opennext path (best effort)
 *
 * Min version for the adapter path matches @solcreek/adapter-creek's
 * peerDependency, which pins Next.js >= 16.2.3 to fix CVE-2026-23869.
 */
export function buildNextjs(cwd: string, isMonorepo: boolean, projectName?: string): void {
  const version = getNextVersion(cwd);
  const useAdapter = version && semverGte(version, "16.2.3") && resolveAdapterPath();

  if (useAdapter) {
    buildWithAdapter(cwd);
  } else {
    if (version) {
      consola.warn(`  Next.js ${version} — using legacy build path`);
    }
    buildNextjsForWorkers(cwd, isMonorepo, projectName);
  }
}

/** Check if the adapter output exists (vs legacy opennext output). */
export function hasAdapterOutput(cwd: string): boolean {
  return existsSync(join(cwd, ".creek/adapter-output/manifest.json"));
}

/**
 * Patch the bundled worker to fix opennext's dynamic require issues.
 *
 * @deprecated Legacy path — only used for Next.js < 16.2. For >= 16.2,
 * the Creek adapter handles middleware via typed AdapterOutputs.
 */
export function patchBundledWorker(bundleDir: string, openNextDir: string): void {
  // Try worker.js (wrangler --dry-run output) and handler.mjs (opennext server function)
  const candidates = [join(bundleDir, "worker.js"), join(bundleDir, "handler.mjs")];
  const workerPath = candidates.find((p) => existsSync(p));
  if (!workerPath) return;

  let code = readFileSync(workerPath, "utf-8");
  let patched = false;

  // Read the actual middleware manifest from the build output
  const manifestPath = join(openNextDir, "server-functions/default/.next/server/middleware-manifest.json");
  let manifest = '{"version":3,"middleware":{},"sortedMiddleware":[],"functions":{}}';
  if (existsSync(manifestPath)) {
    manifest = readFileSync(manifestPath, "utf-8").trim();
  }

  // Patch: getMiddlewareManifest() { return [__]require(this.middlewareManifestPath); }
  // →      getMiddlewareManifest() { return <inline manifest>; }
  // Note: Next.js versions may use `require()` or `__require()` — match both
  const pattern = /getMiddlewareManifest\(\)\s*\{[^}]*(?:__)?require\(this\.middlewareManifestPath\)[^}]*\}/;
  if (pattern.test(code)) {
    code = code.replace(pattern, `getMiddlewareManifest() { return ${manifest}; }`);
    patched = true;
  }

  if (patched) {
    writeFileSync(workerPath, code);
    consola.info("  Patched worker: inline middleware manifest");
  }
}

const CREEK_DIR = ".creek";
const OPENNEXT_PKG = "@opennextjs/cloudflare";
const OPENNEXT_VERSION = "^1.18.0";

/**
 * Ensure @opennextjs/cloudflare is available in .creek/node_modules.
 * Returns the path to the opennextjs-cloudflare CLI binary.
 */
function ensureOpenNext(cwd: string): string {
  const creekDir = join(cwd, CREEK_DIR);
  const opennextBin = join(creekDir, "node_modules/.bin/opennextjs-cloudflare");

  if (existsSync(opennextBin)) return opennextBin;

  consola.start(`  Installing ${OPENNEXT_PKG} (one-time setup)...`);
  mkdirSync(creekDir, { recursive: true });

  const pkgPath = join(creekDir, "package.json");
  if (!existsSync(pkgPath)) {
    writeFileSync(pkgPath, JSON.stringify({
      private: true,
      dependencies: { [OPENNEXT_PKG]: OPENNEXT_VERSION },
    }, null, 2));
  }

  execSync("npm install --no-audit --no-fund --ignore-scripts --no-optional", {
    cwd: creekDir,
    stdio: "pipe",
  });

  consola.success(`  ${OPENNEXT_PKG} installed`);
  return opennextBin;
}

/**
 * Generate wrangler.jsonc in project root for opennext to read.
 * Only created if not already present — opennext needs it at the project root.
 */
function ensureWranglerConfig(cwd: string, projectName: string): string | null {
  // If user already has wrangler config, don't touch it
  for (const name of ["wrangler.jsonc", "wrangler.json", "wrangler.toml"]) {
    if (existsSync(join(cwd, name))) return null;
  }

  // Create minimal config for opennext
  const configPath = join(cwd, "wrangler.jsonc");
  writeFileSync(configPath, JSON.stringify({
    name: projectName,
    main: ".open-next/worker.js",
    compatibility_date: "2025-03-14",
    compatibility_flags: ["nodejs_compat"],
    assets: { directory: ".open-next/assets", binding: "ASSETS" },
  }, null, 2));

  return configPath; // caller can clean up after build
}

/**
 * Fix the standalone output path for monorepo builds.
 *
 * When outputFileTracingRoot points to the monorepo root, Next.js outputs to:
 *   .next/standalone/{relative-app-path}/.next/
 * instead of:
 *   .next/standalone/.next/
 *
 * This breaks @opennextjs/cloudflare's createCacheAssets.
 */
export function fixStandalonePath(appDir: string): boolean {
  const standaloneDir = join(appDir, ".next/standalone");
  const expectedDotNext = join(standaloneDir, ".next");

  if (!existsSync(standaloneDir)) return false;
  if (existsSync(join(expectedDotNext, "server"))) return false; // already correct

  const shifted = findShiftedDotNext(standaloneDir);
  if (!shifted) {
    consola.warn("  Could not find .next in standalone output — path fix skipped");
    return false;
  }

  consola.info("  Fixing monorepo standalone path...");
  cpSync(shifted, expectedDotNext, { recursive: true });

  const serverJs = join(shifted, "..", "server.js");
  if (existsSync(serverJs)) {
    cpSync(serverJs, join(standaloneDir, "server.js"));
  }

  return true;
}

function findMonorepoRoot(cwd: string): string | null {
  let dir = resolve(cwd);
  while (dir !== dirname(dir)) {
    dir = dirname(dir);
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    if (existsSync(join(dir, "turbo.json"))) return dir;
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
      if (pkg.workspaces) return dir;
    } catch {}
  }
  return null;
}

function findShiftedDotNext(dir: string, depth = 0): string | null {
  if (depth > 5) return null;

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === ".next" && existsSync(join(dir, ".next/server"))) {
      return join(dir, ".next");
    }
    if (entry.name !== "node_modules" && entry.name !== ".next") {
      const result = findShiftedDotNext(join(dir, entry.name), depth + 1);
      if (result) return result;
    }
  }
  return null;
}

/**
 * Inject required Next.js config for CF Workers deployment.
 *
 * Reads the user's next.config, checks if output/outputFileTracingRoot/turbopack.root
 * are set, and patches the file if needed. Returns a restore function.
 *
 * Injected settings:
 * - output: "standalone" (required for opennext)
 * - outputFileTracingRoot: monorepo root (required for correct standalone path)
 * - turbopack.root: monorepo root (required for pnpm dep resolution)
 */
function injectNextConfig(cwd: string, monorepoRoot: string | null): (() => void) | null {
  const configNames = ["next.config.ts", "next.config.js", "next.config.mjs"];
  let configPath: string | null = null;
  let originalContent: string | null = null;

  for (const name of configNames) {
    const p = join(cwd, name);
    if (existsSync(p)) {
      configPath = p;
      originalContent = readFileSync(p, "utf-8");
      break;
    }
  }

  if (!configPath || !originalContent) {
    // No next.config found — create a minimal one
    configPath = join(cwd, "next.config.ts");
    const root = monorepoRoot ?? cwd;
    writeFileSync(configPath, `
import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: "${root}",
  turbopack: { root: "${root}" },
};
export default nextConfig;
`);
    return () => { rmSync(configPath!); };
  }

  // Check what's missing
  const hasStandalone = /output\s*:\s*["']standalone["']/.test(originalContent);
  const hasTracingRoot = /outputFileTracingRoot/.test(originalContent);
  const hasTurboRoot = /turbopack\s*:\s*\{[^}]*root/.test(originalContent);

  if (hasStandalone && hasTracingRoot && hasTurboRoot) return null; // all set

  // Need to patch — wrap the existing config
  const root = monorepoRoot ?? cwd;
  const isTS = configPath.endsWith(".ts");
  const ext = configPath.endsWith(".mjs") ? "mjs" : (isTS ? "ts" : "js");

  // Backup original
  const backupPath = configPath + ".creek-backup";
  writeFileSync(backupPath, originalContent);

  // Build patched config that imports + extends the original
  // We can't easily wrap TS configs, so inject settings at the top level
  let patched = originalContent;

  if (!hasStandalone) {
    // Add output: "standalone" to the config object
    patched = patched.replace(
      /const\s+\w+\s*(?::\s*\w+)?\s*=\s*\{/,
      (match) => `${match}\n  output: "standalone",`,
    );
  }

  if (!hasTracingRoot && monorepoRoot) {
    patched = patched.replace(
      /const\s+\w+\s*(?::\s*\w+)?\s*=\s*\{/,
      (match) => `${match}\n  outputFileTracingRoot: "${root}",`,
    );
  }

  if (!hasTurboRoot && monorepoRoot) {
    if (/turbopack\s*:\s*\{/.test(patched)) {
      // turbopack block exists, add root
      patched = patched.replace(
        /turbopack\s*:\s*\{/,
        `turbopack: {\n    root: "${root}",`,
      );
    } else {
      // No turbopack block, add one
      patched = patched.replace(
        /const\s+\w+\s*(?::\s*\w+)?\s*=\s*\{/,
        (match) => `${match}\n  turbopack: { root: "${root}" },`,
      );
    }
  }

  // Add resolve import if needed for path
  if (patched !== originalContent) {
    consola.info("  Injecting Creek build config into next.config...");
    writeFileSync(configPath, patched);
  }

  return () => {
    // Restore original
    if (existsSync(backupPath)) {
      writeFileSync(configPath!, readFileSync(backupPath, "utf-8"));
      rmSync(backupPath);
    }
  };
}

/**
 * Build a Next.js app for Cloudflare Workers via legacy opennext path.
 *
 * @deprecated Legacy path for Next.js < 16.2. Use buildNextjs() which
 * auto-selects the adapter path for >= 16.2.
 */
export function buildNextjsForWorkers(cwd: string, isMonorepo: boolean, projectName = "app"): void {
  // Clean up stale adapter output to prevent deploy from using it
  const staleAdapterOutput = join(cwd, ".creek/adapter-output");
  if (existsSync(staleAdapterOutput)) {
    rmSync(staleAdapterOutput, { recursive: true, force: true });
  }

  // Step 1: Ensure opennext is available
  const opennextBin = ensureOpenNext(cwd);

  // Step 2: Ensure wrangler config
  const generatedConfig = ensureWranglerConfig(cwd, projectName);

  // Step 3: Inject next.config settings
  const monorepoRoot = isMonorepo ? findMonorepoRoot(cwd) : null;
  const restoreConfig = injectNextConfig(cwd, monorepoRoot);

  try {
    // Step 4: next build
    consola.start("  Building Next.js app...\n");
    execSync("npx next build", { cwd, stdio: "inherit" });

    // Step 4: Fix monorepo standalone path
    if (isMonorepo) {
      fixStandalonePath(cwd);
    }

    // Step 5: opennextjs-cloudflare post-processing
    consola.start("  Bundling for Cloudflare Workers...");
    execFileSync(opennextBin, ["build", "--skipNextBuild"], {
      cwd,
      stdio: "inherit",
    });

    // Step 6: Patch handler.mjs to fix dynamic require issues in Workers runtime
    patchBundledWorker(
      join(cwd, ".open-next/server-functions/default"),
      join(cwd, ".open-next"),
    );
  } finally {
    // Restore original next.config
    if (restoreConfig) restoreConfig();

    // Clean up generated wrangler config
    if (generatedConfig && existsSync(generatedConfig)) {
      rmSync(generatedConfig);
    }
  }
}
