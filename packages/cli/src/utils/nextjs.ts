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
import { prismaNeedsGenerate, detectSqliteOrm, readProjectDeps } from "./db-preflight.js";

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
 * Read the installed adapter version from the package.json above a resolved
 * adapter entry path (.../adapter-creek/dist/index.js).
 */
function adapterVersionAt(entryPath: string): string | null {
  let dir = dirname(entryPath);
  for (let i = 0; i < 3; i++) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (pkg.name === ADAPTER_PKG) return pkg.version ?? null;
      } catch {
        return null;
      }
    }
    dir = dirname(dir);
  }
  return null;
}

/**
 * Resolve @solcreek/adapter-creek from any reachable location.
 *
 * Tries, in order: the CLI's own install (monorepo workspace / global
 * install alongside the adapter), the project's own node_modules, then the
 * lazy-installed copy under .creek/node_modules. Copies older than
 * `minVersion` are skipped — adapter < 0.2.1 cannot resolve its cache
 * handler from the .creek lazy install, so a stale cached copy must not
 * shadow a fixed one. Returns the adapter entry path (for
 * NEXT_ADAPTER_PATH), or null if no acceptable copy is installed.
 */
function resolveAdapterPath(cwd?: string, minVersion?: string): string | null {
  const bases = [import.meta.url];
  if (cwd) {
    // createRequire walks node_modules up from the base file's directory;
    // the base file itself need not exist.
    bases.push(join(cwd, "package.json"));
    bases.push(join(cwd, CREEK_DIR, "package.json"));
  }
  for (const base of bases) {
    try {
      const entry = createRequire(base).resolve(ADAPTER_PKG);
      if (minVersion) {
        const version = adapterVersionAt(entry);
        if (!version || !semverGte(version, minVersion)) continue;
      }
      return entry;
    } catch {
      // try next base
    }
  }
  return null;
}

/**
 * Build a Next.js app using the Creek adapter (>= 16.2.3).
 *
 * Sets NEXT_ADAPTER_PATH to the resolved adapter. No opennext, no wrangler,
 * no config patching — the adapter handles everything inside onBuildComplete().
 */
function buildWithAdapter(cwd: string, adapterPath: string): void {
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
 * - Next.js >= 16.2.3: Creek adapter path (recommended). The adapter is
 *   lazily installed into .creek/node_modules on first use — the CLI never
 *   depends on it directly, so non-Next.js users never pay for it.
 * - Next.js < 16.2.3 (or adapter install fails): legacy opennext path.
 *
 * Min version for the adapter path matches @solcreek/adapter-creek's
 * peerDependency, which pins Next.js >= 16.2.3 to fix CVE-2026-23869.
 */
export function buildNextjs(cwd: string, isMonorepo: boolean, projectName?: string): void {
  const version = getNextVersion(cwd);

  if (version && semverGte(version, "16.2.3")) {
    const adapterPath = ensureAdapter(cwd);
    if (adapterPath) {
      ensurePrismaClient(cwd);
      ensurePrismaD1(cwd);
      buildWithAdapter(cwd, adapterPath);
      return;
    }
    consola.warn(`  Falling back to legacy build path for Next.js ${version}`);
  } else if (version) {
    consola.warn(`  Next.js ${version} — using legacy build path`);
  }

  buildNextjsForWorkers(cwd, isMonorepo, projectName);
}

/** Check if the adapter output exists (vs legacy opennext output). */
export function hasAdapterOutput(cwd: string): boolean {
  return existsSync(join(cwd, ".creek/adapter-output/manifest.json"));
}

/**
 * Read the compat settings the adapter built the worker with from
 * `.creek/adapter-output/manifest.json`. The worker is validated at upload
 * against the date/flags it ships with (e.g. node:http server modules need
 * `nodejs_compat` + compatibility_date >= 2025-09-01), so the deploy must
 * use exactly what the adapter built against rather than a hardcoded default
 * that can drift. Returns null when absent/unparseable (caller falls back).
 */
export function readAdapterCompat(
  cwd: string,
): { compatibilityDate?: string; compatibilityFlags?: string[] } | null {
  const manifestPath = join(cwd, ".creek/adapter-output/manifest.json");
  if (!existsSync(manifestPath)) return null;
  try {
    const m = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      compatibilityDate?: string;
      compatibilityFlags?: string[];
    };
    const out: { compatibilityDate?: string; compatibilityFlags?: string[] } = {};
    if (typeof m.compatibilityDate === "string") out.compatibilityDate = m.compatibilityDate;
    if (Array.isArray(m.compatibilityFlags)) out.compatibilityFlags = m.compatibilityFlags;
    return out;
  } catch {
    return null;
  }
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
const ADAPTER_PKG = "@solcreek/adapter-creek";
const ADAPTER_VERSION = "^0.2.2";
// Zero-change Prisma-on-D1: the adapter's build-time swap imports
// @prisma/adapter-d1 (an optional peer it doesn't ship), installed on demand.
const PRISMA_D1_PKG = "@prisma/adapter-d1";
// Minimum adapter the CLI will REUSE from a prior .creek install; older
// cached copies are force-reinstalled. Each bump tracks a deploy-critical
// adapter fix that a stale cache would silently miss:
//   0.2.2 — wrangler resolved via module resolution (not a nested .bin guess)
//   0.2.6 — better-sqlite3 stubbed (else the native module inlines → a ~200MB
//           worker that only fails at upload with "Payload Too Large")
//   0.2.7 — zero-change Prisma-on-D1 swap
//   0.2.10 — oversized-bundle fail-fast
//   0.2.12 — never scan stale `.next/dev` (else a leftover dev build inflates
//            the worker by orders of magnitude — a real deploy hit 202MB)
//   0.2.14 — skip 0.2.13, whose default-on minify broke Prisma driver-adapter
//            apps at runtime ("PrismaD1 is not a constructor"); reject a cached
//            0.2.13 so a deploy pulls the fixed build instead of reusing it
// Kept at the latest because the reinstall cost is trivial and a cached copy
// in the 0.2.2–0.2.5 window builds successfully but produces a broken worker.
const ADAPTER_MIN_VERSION = "0.2.14";

/**
 * Merge a dependency into .creek/package.json without clobbering deps that
 * a previous install (adapter or opennext) may have already written.
 */
function upsertCreekDep(creekDir: string, pkg: string, version: string): void {
  const pkgPath = join(creekDir, "package.json");
  let manifest: { private?: boolean; dependencies?: Record<string, string> } = {
    private: true,
    dependencies: {},
  };
  if (existsSync(pkgPath)) {
    try {
      manifest = JSON.parse(readFileSync(pkgPath, "utf-8"));
      manifest.dependencies ??= {};
    } catch {
      manifest = { private: true, dependencies: {} };
    }
  }
  manifest.dependencies![pkg] = version;
  writeFileSync(pkgPath, JSON.stringify(manifest, null, 2));
}

/**
 * Install a package into .creek/node_modules. Returns false if npm fails.
 */
function installCreekDep(creekDir: string, pkg: string, version: string): boolean {
  mkdirSync(creekDir, { recursive: true });
  upsertCreekDep(creekDir, pkg, version);
  try {
    // No --no-optional: the adapter bundles the worker with wrangler, whose
    // workerd dependency ships its platform binary (@cloudflare/workerd-*)
    // as an optionalDependency. Omitting optionals fails the build with
    // "package could not be found, and is needed by workerd".
    execSync("npm install --no-audit --no-fund --ignore-scripts", {
      cwd: creekDir,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure @solcreek/adapter-creek is resolvable, lazily installing it into
 * .creek/node_modules on demand. Returns the resolved adapter entry path
 * (for NEXT_ADAPTER_PATH), or null if it could not be made available.
 *
 * Lazy by design: the CLI stays framework-neutral, so the adapter — a
 * Next.js-specific package with its own Next peerDependency — is only
 * fetched when a Next.js project is actually deployed. It is never a hard
 * CLI dependency that every `npx creek` user would pay for.
 */
function ensureAdapter(cwd: string): string | null {
  const existing = resolveAdapterPath(cwd, ADAPTER_MIN_VERSION);
  if (existing) return existing;

  // Distinguish "not installed" from "only stale copies" for the message;
  // either way the fix is the same install into .creek.
  const stale = resolveAdapterPath(cwd) !== null;
  consola.start(
    stale
      ? `  Updating ${ADAPTER_PKG} to >= ${ADAPTER_MIN_VERSION} (older versions cannot build)...`
      : `  Installing ${ADAPTER_PKG} (one-time setup)...`,
  );
  if (!installCreekDep(join(cwd, CREEK_DIR), ADAPTER_PKG, ADAPTER_VERSION)) {
    consola.warn(`  Could not install ${ADAPTER_PKG}`);
    return null;
  }

  const resolved = resolveAdapterPath(cwd, ADAPTER_MIN_VERSION);
  if (resolved) consola.success(`  ${ADAPTER_PKG} installed`);
  return resolved;
}

/**
 * Generate the Prisma client before the Next build when it's missing.
 * Prisma 7's `prisma-client` generator emits to a configured `output` dir that
 * the app imports; without it the build fails. Safe to run automatically —
 * generation is idempotent and has no external/persistent effect. No-op unless
 * a Prisma schema exists and its output dir is absent (see prismaNeedsGenerate).
 */
function ensurePrismaClient(cwd: string): void {
  if (!prismaNeedsGenerate(cwd)) return;
  consola.start("  Generating Prisma client (prisma generate)...");
  try {
    // `--no-install` uses the project's own prisma (a dependency) rather than
    // fetching one; the schema's datasource needs no URL to generate.
    execSync("npx --no-install prisma generate", { cwd, stdio: "pipe" });
    consola.success("  Prisma client generated");
  } catch (err) {
    // Non-fatal: the build will surface a clearer "client not found" error if
    // generation was genuinely required.
    consola.warn(
      `  prisma generate failed (${err instanceof Error ? err.message : String(err)}); continuing`,
    );
  }
}

/**
 * Ensure @prisma/adapter-d1 is resolvable at build time for the zero-change
 * Prisma-on-D1 swap. adapter-creek aliases `@prisma/adapter-better-sqlite3` to
 * a PrismaD1-backed shim that imports `@prisma/adapter-d1`; that package is an
 * OPTIONAL peer of the adapter (not shipped to non-Prisma projects), so it is
 * lazily installed into .creek only when the project actually uses the
 * better-sqlite3 Prisma adapter. Installed matching the project's Prisma
 * version — the adapter packages release in lockstep with @prisma/client, so a
 * matching driver-adapter interface avoids subtle version skew.
 *
 * No-op unless the project declares @prisma/adapter-better-sqlite3, or if
 * adapter-d1 is already resolvable (project dep or a prior .creek install).
 *
 * Exported for tests.
 */
export function ensurePrismaD1(cwd: string): void {
  // Detect intent from the project's OWN declared deps (deterministic), not
  // module resolution — resolve() walks up node_modules and would
  // false-positive on a copy hoisted elsewhere (e.g. a monorepo sibling).
  if (detectSqliteOrm(readProjectDeps(cwd)) !== "prisma") {
    return; // Not a Prisma-on-D1 (better-sqlite3 adapter) project.
  }

  // createRequire from .creek walks up into the project's node_modules too, so
  // this single check covers both a prior .creek install and a project dep.
  const creekDir = join(cwd, CREEK_DIR);
  try {
    createRequire(join(creekDir, "noop.js")).resolve(PRISMA_D1_PKG);
    return; // Already available.
  } catch {
    // Fall through to install.
  }

  let version = "latest";
  try {
    const clientPkg = JSON.parse(
      readFileSync(
        createRequire(join(cwd, "noop.js")).resolve("@prisma/client/package.json"),
        "utf-8",
      ),
    ) as { version?: string };
    if (clientPkg.version) version = clientPkg.version;
  } catch {
    // No @prisma/client version readable — fall back to latest.
  }

  consola.start(`  Installing ${PRISMA_D1_PKG}@${version} (Prisma on D1)...`);
  if (installCreekDep(creekDir, PRISMA_D1_PKG, version)) {
    consola.success(`  ${PRISMA_D1_PKG} installed`);
  } else {
    consola.warn(`  Could not install ${PRISMA_D1_PKG} — Prisma build may fail`);
  }
}

/**
 * Ensure @opennextjs/cloudflare is available in .creek/node_modules.
 * Returns the path to the opennextjs-cloudflare CLI binary.
 */
function ensureOpenNext(cwd: string): string {
  const creekDir = join(cwd, CREEK_DIR);
  const opennextBin = join(creekDir, "node_modules/.bin/opennextjs-cloudflare");

  if (existsSync(opennextBin)) return opennextBin;

  consola.start(`  Installing ${OPENNEXT_PKG} (one-time setup)...`);
  installCreekDep(creekDir, OPENNEXT_PKG, OPENNEXT_VERSION);

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
