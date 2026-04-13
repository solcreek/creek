/**
 * prepareDeployBundle — single source of truth for "given a project,
 * produce the bundle that gets shipped to either sandbox-api or
 * control-plane". Both `deploySandbox` and `deployAuthenticated` call
 * this; they only differ in (a) whether they auth/look-up a project
 * and (b) which API receives the bundle.
 *
 * Historically these two paths each rolled their own copy of the
 * detect → build → collect → bundle pipeline. They drifted: the
 * sandbox path was missing the worker branch for ~2 weeks (cli@0.4.6
 * regression) and again missed the workers+assets coexist pattern.
 * That divergence is the architectural smell — this file kills it.
 *
 * The function:
 *   1. Reads framework from package.json (or accepts pre-resolved one)
 *   2. Runs the build script (skip with skipBuild: true)
 *   3. Calls SDK's planDeploy() to decide spa/ssr/worker shape
 *   4. Detects post-build framework adapters (Astro CF) and refines
 *   5. Collects static assets per the plan
 *   6. Bundles the worker per the plan (5 framework-aware strategies)
 *   7. Filters worker file out of clientAssets when it lives inside
 *   8. Returns the canonical bundle envelope
 *
 * IO is not abstracted — the function calls execSync, readFileSync,
 * esbuild. Callers needing test isolation should use fixture dirs.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import consola from "consola";
import {
  detectFramework,
  detectAstroCloudflareBuild,
  detectMonorepo,
  detectNextjsMode,
  getSSRServerDir,
  getSSRServerEntry,
  getClientAssetsDir,
  getDefaultBuildOutput,
  isSSRFramework,
  isPreBundledFramework,
  collectServerFiles,
  planDeploy,
  type DeployPlan,
  type Framework,
  type ResolvedConfig,
} from "@solcreek/sdk";
import { collectAssets } from "./bundle.js";
import { bundleSSRServer } from "./ssr-bundle.js";
import { bundleWorker } from "./worker-bundle.js";
import { hasAdapterOutput, buildNextjs, patchBundledWorker } from "./nextjs.js";
import { patchBareNodeImports } from "../commands/deploy.js";

export interface PrepareDeployBundleInput {
  /** Absolute project directory. */
  cwd: string;
  /** Pre-resolved config (creek.toml or wrangler.* parse). Required. */
  resolved: ResolvedConfig;
  /** When true, skip the build script. Caller is asserting dist/ is current. */
  skipBuild: boolean;
}

export interface PreparedDeployBundle {
  /** The plan that drove preparation — passed back so callers can
   *  inspect renderMode / worker strategy without re-deriving. */
  plan: DeployPlan;
  /** Framework detected (or pre-resolved). null = static / vanilla worker. */
  framework: Framework | null;
  /** Whether Astro `@astrojs/cloudflare` adapter fired post-build. */
  astroAdapter: { serverDir: string; assetsDir: string } | null;
  /**
   * Render mode after post-build refinement. Equal to plan.renderMode
   * unless an adapter (e.g. Astro CF) upgraded an SPA-classified
   * project to true SSR.
   */
  effectiveRenderMode: "spa" | "ssr" | "worker";
  /** Main module name the deploy API should treat as the worker entry. */
  effectiveEntrypoint: string | null;
  /** Asset list (paths relative to root, with leading `/`). */
  fileList: string[];
  /** Asset bytes, base64-encoded, keyed by path. */
  assets: Record<string, string>;
  /** Server / worker files, base64-encoded. Undefined for pure SPA. */
  serverFiles?: Record<string, string>;
}

export async function prepareDeployBundle(
  input: PrepareDeployBundleInput,
): Promise<PreparedDeployBundle> {
  const { cwd, resolved, skipBuild } = input;

  // 1. Framework detection. Trust the resolved config if it carries
  // one (creek.toml can pin it); otherwise re-read package.json. We
  // re-read here rather than rely solely on resolved so that a project
  // without creek.toml still gets the auto-detected framework when
  // running against a pre-existing wrangler.* config.
  const pkgJsonPath = join(cwd, "package.json");
  const pkg = existsSync(pkgJsonPath)
    ? JSON.parse(readFileSync(pkgJsonPath, "utf-8"))
    : null;
  const framework: Framework | null =
    resolved.framework ?? (pkg ? detectFramework(pkg) : null);

  const nextjsMode = framework === "nextjs" && pkg ? detectNextjsMode(pkg, cwd) : null;
  const monorepo = framework === "nextjs" ? detectMonorepo(cwd) : { isMonorepo: false, root: null };

  // 2. Build (when not skipped). Framework-specific build for Next.js
  // adapter; otherwise the user's build script.
  if (!skipBuild && resolved.buildCommand) {
    if (nextjsMode === "opennext") {
      try {
        buildNextjs(cwd, monorepo.isMonorepo);
      } catch {
        consola.error("Next.js build failed");
        process.exit(1);
      }
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

  // 3. Compute output dir. Next.js adapter writes to .creek/adapter-output;
  // everything else honours [build].output.
  const useAdapterOutput = framework === "nextjs" && hasAdapterOutput(cwd);
  const outputDir = useAdapterOutput
    ? resolve(cwd, ".creek/adapter-output")
    : resolve(cwd, resolved.buildOutput || getDefaultBuildOutput(framework));

  // 4. Post-build framework adapter detection. Astro can be either SSG
  // or CF-adapter-SSR; we only know which after build.
  const astroAdapter =
    framework === "astro" ? detectAstroCloudflareBuild(cwd) : null;

  // 5. Plan the deploy shape. planDeploy is a pure function — pass in
  // detection results, get out a structured plan with explicit error
  // cases. All branching that used to be inline in deploy.ts lives in
  // deploy-plan.ts now (table-tested).
  const planResult = planDeploy({
    framework,
    workerEntry: resolved.workerEntry ?? null,
    workerEntryExists:
      !!resolved.workerEntry &&
      existsSync(resolve(cwd, resolved.workerEntry)),
    buildOutput: resolved.buildOutput || "dist",
    buildOutputExists: existsSync(outputDir),
    astroCF: astroAdapter,
  });
  if (!planResult.ok) {
    consola.error(planResult.reason);
    process.exit(1);
  }
  const plan = planResult.plan;

  // 6. Collect client assets. The dir depends on framework (Next.js
  // adapter, Astro CF split output) but the inclusion decision is the
  // plan's call.
  let clientAssets: Record<string, string> = {};
  let fileList: string[] = [];
  if (plan.assets.enabled && plan.assets.dir) {
    let clientAssetsDir: string;
    if (useAdapterOutput) {
      clientAssetsDir = resolve(outputDir, "assets");
    } else if (astroAdapter) {
      clientAssetsDir = resolve(cwd, astroAdapter.assetsDir);
    } else {
      clientAssetsDir = resolve(cwd, plan.assets.dir);
      // SSR frameworks split client assets into a sub-dir of buildOutput.
      if (isSSRFramework(framework) && framework) {
        const subdir = getClientAssetsDir(framework);
        if (subdir) clientAssetsDir = resolve(clientAssetsDir, subdir);
      }
    }
    const collected = collectAssets(clientAssetsDir);
    clientAssets = collected.assets;
    fileList = collected.fileList;
  }

  // 7. Bundle server / worker. Five strategies, dispatched by either
  // (a) the framework when it's pre-bundled SSR, or (b) the plan's
  // worker.strategy for user-declared workers.
  let serverFiles: Record<string, string> | undefined;

  if (astroAdapter) {
    // Astro CF adapter writes a pre-bundled worker we just upload.
    const serverDir = resolve(cwd, astroAdapter.serverDir);
    if (existsSync(serverDir)) {
      consola.start("  Collecting Astro CF server files...");
      const collected = collectServerFiles(serverDir);
      serverFiles = base64ServerFiles(collected);
      consola.success(`  Astro CF worker: ${Object.keys(collected).length} files`);
    }
  } else if (isSSRFramework(framework) && framework) {
    if (framework === "nextjs" && hasAdapterOutput(cwd)) {
      // Next.js adapter output → patch bare imports, upload as-is.
      const adapterServerDir = resolve(cwd, ".creek/adapter-output/server");
      consola.start("  Collecting adapter output...");
      const collected: Record<string, Buffer> = {};
      if (existsSync(adapterServerDir)) {
        for (const f of readdirSync(adapterServerDir)) {
          const fp = join(adapterServerDir, f);
          if (!statSync(fp).isFile() || f.endsWith(".map")) continue;
          let content = readFileSync(fp);
          if (f.endsWith(".js") || f.endsWith(".mjs")) {
            content = Buffer.from(patchBareNodeImports(content.toString("utf-8")));
          }
          collected[f] = content;
        }
      }
      serverFiles = base64ServerFiles(collected);
      consola.success(
        `  Worker bundled: ${Object.keys(collected).length} files (${kb(collected)}KB)`,
      );
    } else if (framework === "nextjs") {
      // Legacy Next.js: wrangler dry-run produces the bundle.
      const bundleDir = resolve(cwd, ".creek/bundled");
      consola.start("  Bundling Next.js worker (legacy)...");
      execSync(`npx wrangler deploy --dry-run --outdir "${bundleDir}"`, { cwd, stdio: "pipe" });
      patchBundledWorker(bundleDir, resolve(cwd, ".open-next"));
      const collected: Record<string, Buffer> = {};
      if (existsSync(bundleDir)) {
        for (const f of readdirSync(bundleDir)) {
          const fp = join(bundleDir, f);
          if (!statSync(fp).isFile() || f.endsWith(".map") || f === "README.md") continue;
          collected[f] = readFileSync(fp);
        }
      }
      serverFiles = base64ServerFiles(collected);
      consola.success(
        `  Worker bundled: ${Object.keys(collected).length} files (${kb(collected)}KB)`,
      );
    } else if (isPreBundledFramework(framework)) {
      // Nuxt / SvelteKit / SolidStart — the framework already produced
      // a bundled server; we just collect.
      const serverDirRel = getSSRServerDir(framework);
      if (serverDirRel) {
        const serverDir = resolve(cwd, serverDirRel);
        if (existsSync(serverDir)) {
          consola.start("  Collecting SSR server files...");
          const collected = collectServerFiles(serverDir);
          serverFiles = base64ServerFiles(collected);
          consola.success(`  SSR server: ${Object.keys(collected).length} files`);
        }
      }
    } else {
      // Fallback for SSR frameworks that emit a single entry file.
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
  } else if (plan.worker.strategy === "esbuild-bundle" && plan.worker.entry) {
    const workerEntryPath = resolve(cwd, plan.worker.entry);
    consola.start("  Bundling worker...");
    const bundled = await bundleWorker(workerEntryPath, cwd, {
      hasClientAssets: plan.assets.enabled,
    });
    serverFiles = { "worker.js": Buffer.from(bundled).toString("base64") };
    consola.success(`  Worker bundled (${Math.round(bundled.length / 1024)}KB)`);
  } else if (plan.worker.strategy === "upload-asis" && plan.worker.entry) {
    // Pre-bundled worker (e.g. dist/_worker.mjs from the user's own
    // esbuild step). Ship verbatim — no Creek runtime wrapper, no
    // re-bundle. This is the path that keeps deployed bundles free of
    // any @solcreek/* dependency.
    const bytes = readFileSync(resolve(cwd, plan.worker.entry));
    serverFiles = { "worker.js": bytes.toString("base64") };
    consola.success(`  Worker (pre-bundled, ${Math.round(bytes.length / 1024)}KB)`);
  }

  // 8. When the worker bundle lives INSIDE the asset dir
  // (dist/_worker.mjs), drop it from clientAssets so it isn't also
  // served as a publicly accessible static file.
  if (plan.assets.excludeFile) {
    delete clientAssets[plan.assets.excludeFile];
    delete clientAssets["/" + plan.assets.excludeFile];
    fileList = fileList.filter(
      (p) => p !== plan.assets.excludeFile && p !== "/" + plan.assets.excludeFile,
    );
  }

  // 9. Resolve effective render mode + entrypoint. Astro CF post-build
  // detection upgrades a pre-build "spa" classification to true SSR.
  const effectiveRenderMode: "spa" | "ssr" | "worker" = astroAdapter
    ? "ssr"
    : plan.renderMode;
  const effectiveEntrypoint = astroAdapter
    ? "entry.mjs"
    : (plan.worker.entry ?? null);

  return {
    plan,
    framework,
    astroAdapter,
    effectiveRenderMode,
    effectiveEntrypoint,
    fileList,
    assets: clientAssets,
    serverFiles,
  };
}

// --- helpers ---

function base64ServerFiles(collected: Record<string, Buffer>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(collected).map(([p, buf]) => [p, buf.toString("base64")]),
  );
}

function kb(collected: Record<string, Buffer>): number {
  return Math.round(
    Object.values(collected).reduce((s, b) => s + b.length, 0) / 1024,
  );
}

