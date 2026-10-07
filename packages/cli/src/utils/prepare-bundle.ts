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
 *   4. Detects post-build framework output (Astro CF, vinext) and refines
 *   5. Collects static assets per the plan
 *   6. Bundles the worker per the plan (5 framework-aware strategies)
 *   7. Filters worker file out of clientAssets when it lives inside
 *   8. Returns the canonical bundle envelope
 *
 * IO is not abstracted — the function calls execSync, readFileSync,
 * esbuild. Callers needing test isolation should use fixture dirs.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { build as esbuild } from "esbuild";
import { execSync } from "node:child_process";
import consola from "consola";
import {
  detectFramework,
  detectAstroCloudflareBuild,
  detectVinextBuild,
  collectVinextServerFiles,
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
  type BindingRequirement,
  type DeployPlan,
  type Framework,
  type ResolvedConfig,
  type VinextBuild,
} from "@solcreek/sdk";
import { collectAssets } from "./bundle.js";
import { bundleSSRServer } from "./ssr-bundle.js";
import { bundleWorker } from "./worker-bundle.js";
import {
  adapterOutputBuiltAt,
  describeBuildAge,
  hasAdapterOutput,
  buildNextjs,
  patchBundledWorker,
  readAdapterEntrypoint,
} from "./nextjs.js";
import { patchBareNodeImports } from "../commands/deploy.js";
import { childStdio, jsonOutput } from "./output.js";

export interface PrepareDeployBundleInput {
  /** Absolute project directory. */
  cwd: string;
  /** Pre-resolved config (creek.toml or wrangler.* parse). Required. */
  resolved: ResolvedConfig;
  /** When true, skip the build script. Caller is asserting dist/ is current. */
  skipBuild: boolean;
  /**
   * Whether the invocation wants JSON output. When true, a build/plan failure
   * emits a structured `{ ok: false, error, message }` to stdout (exit 1)
   * instead of only a human error line — so CI / scripts / agents that parse
   * stdout get a machine-readable failure rather than having to grep text.
   * Defaults to false (human output) when omitted.
   */
  jsonMode?: boolean;
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
   * vinext Cloudflare Build Output, when the framework is vinext. Carries
   * the compat settings, bindings and vars the worker was built for — the
   * deploy must use them (see `mergeFrameworkBindings`).
   */
  vinext: VinextBuild | null;
  /**
   * Render mode after post-build refinement. Equal to plan.renderMode
   * unless an adapter (e.g. Astro CF) upgraded an SPA-classified
   * project to true SSR.
   */
  effectiveRenderMode: "spa" | "ssr" | "worker";
  /** Main module name the deploy API should treat as the worker entry. */
  effectiveEntrypoint: string | null;
  /**
   * The uploaded server file that is the worker's main module, when known
   * (sent as `manifest.mainModule`; the deploy servers run it as the entry).
   * Null leaves the servers to guess by file name, as older clients do.
   */
  mainModule: string | null;
  /** Asset list (paths relative to root, with leading `/`). */
  fileList: string[];
  /** Asset bytes, base64-encoded, keyed by path. */
  assets: Record<string, string>;
  /** Server / worker files, base64-encoded. Undefined for pure SPA. */
  serverFiles?: Record<string, string>;
}

/**
 * If a build command is a package-manager script invocation
 * (`npm run <name>`, `pnpm run <name>`, `yarn run <name>`, `bun run <name>`),
 * return the script name so the caller can verify it exists before running.
 * Returns null for any other command (a real shell command we run as-is).
 *
 * Leading boolean option flags between `run` and the script name
 * (`npm run --silent build`, `npm run -s build`, `npm run --if-present build`)
 * are skipped so the flag isn't mistaken for the script name. Value-bearing
 * flags (e.g. `--workspace <name>`) are not understood — the first non-flag
 * token is taken as the script — but those are rare in a build command.
 */
export function packageScriptName(command: string): string | null {
  const tokens = command.trim().split(/\s+/);
  const [pm, sub, ...rest] = tokens;
  if (!/^(?:npm|pnpm|yarn|bun)$/.test(pm ?? "") || sub !== "run") return null;
  const script = rest.find((t) => !t.startsWith("-"));
  return script ?? null;
}

export async function prepareDeployBundle(
  input: PrepareDeployBundleInput,
): Promise<PreparedDeployBundle> {
  const { cwd, resolved, skipBuild, jsonMode = false } = input;

  // consola's start/info/success write to STDOUT in a non-TTY (CI/pipes),
  // where jsonMode is auto-enabled. Route build/bundle progress through a
  // guard so stdout stays JSON-only and the final jsonOutput is parseable
  // (mirrors deploy.ts's makeProgress). error/warn go to stderr — left as-is.
  const say = {
    start: (m: string) => {
      if (!jsonMode) consola.start(m);
    },
    info: (m: string) => {
      if (!jsonMode) consola.info(m);
    },
    success: (m: string) => {
      if (!jsonMode) consola.success(m);
    },
  };
  const fail = (error: string, message: string): never => {
    if (jsonMode) jsonOutput({ ok: false, error, message }, 1);
    consola.error(message);
    process.exit(1);
  };

  // 1. Framework detection. Trust the resolved config if it carries
  // one (creek.toml can pin it); otherwise re-read package.json. We
  // re-read here rather than rely solely on resolved so that a project
  // without creek.toml still gets the auto-detected framework when
  // running against a pre-existing wrangler.* config.
  const pkgJsonPath = join(cwd, "package.json");
  const pkg = existsSync(pkgJsonPath) ? JSON.parse(readFileSync(pkgJsonPath, "utf-8")) : null;
  const framework: Framework | null = resolved.framework ?? (pkg ? detectFramework(pkg) : null);

  const nextjsMode = framework === "nextjs" && pkg ? detectNextjsMode(pkg, cwd) : null;
  const monorepo = framework === "nextjs" ? detectMonorepo(cwd) : { isMonorepo: false, root: null };

  // 2. Build (when not skipped). Framework-specific build for Next.js
  // adapter; otherwise the user's build script.
  if (!skipBuild && resolved.buildCommand) {
    if (nextjsMode === "opennext") {
      try {
        buildNextjs(cwd, monorepo.isMonorepo);
      } catch {
        if (jsonMode)
          jsonOutput({ ok: false, error: "build_failed", message: "Next.js build failed" }, 1);
        consola.error("Next.js build failed");
        process.exit(1);
      }
    } else {
      const buildCmd = resolved.buildCommand;
      if (buildCmd.length > 500) {
        if (jsonMode)
          jsonOutput(
            {
              ok: false,
              error: "invalid_build_command",
              message: "Invalid build command (too long)",
            },
            1,
          );
        consola.error("Invalid build command (too long)");
        process.exit(1);
      }
      // An API-only worker (no frontend) has no build script, but the
      // command defaults to `npm run build`. Running it fails with a
      // cryptic "Missing script: build". When the command is a
      // package-manager script that doesn't exist, skip the build — the
      // worker is bundled downstream regardless.
      const scriptName = packageScriptName(buildCmd);
      const scripts = pkg?.scripts;
      const hasScripts = typeof scripts === "object" && scripts !== null && !Array.isArray(scripts);
      const scriptMissing =
        scriptName !== null &&
        !(hasScripts && Object.prototype.hasOwnProperty.call(scripts, scriptName));
      if (scriptMissing) {
        say.info(`  No "${scriptName}" script in package.json — skipping build step`);
      } else {
        say.start(`  ${buildCmd}`);
        try {
          execSync(buildCmd, { cwd, stdio: childStdio() });
        } catch {
          if (jsonMode)
            jsonOutput(
              { ok: false, error: "build_failed", message: `Build failed: ${buildCmd}` },
              1,
            );
          consola.error("Build failed");
          process.exit(1);
        }
        say.success("  Build complete");
      }
    }
  }

  // 3. Compute output dir. Next.js adapter writes to .creek/adapter-output;
  // everything else honours [build].output.
  const useAdapterOutput = framework === "nextjs" && hasAdapterOutput(cwd);
  const outputDir = useAdapterOutput
    ? resolve(cwd, ".creek/adapter-output")
    : resolve(cwd, resolved.buildOutput || getDefaultBuildOutput(framework, cwd));

  // 4. Post-build framework adapter detection. Astro can be either SSG
  // or CF-adapter-SSR; we only know which after build. vinext's Build
  // Output only exists once `vite build` has run.
  const astroAdapter = framework === "astro" ? detectAstroCloudflareBuild(cwd) : null;
  let vinext: VinextBuild | null = null;
  if (framework === "vinext") {
    try {
      vinext = detectVinextBuild(cwd);
    } catch (err) {
      fail("invalid_build_output", (err as Error).message);
    }
  }

  // 5. Plan the deploy shape. planDeploy is a pure function — pass in
  // detection results, get out a structured plan with explicit error
  // cases. All branching that used to be inline in deploy.ts lives in
  // deploy-plan.ts now (table-tested).
  const planResult = planDeploy({
    framework,
    workerEntry: resolved.workerEntry ?? null,
    workerEntryExists: !!resolved.workerEntry && existsSync(resolve(cwd, resolved.workerEntry)),
    buildOutput: resolved.buildOutput || "dist",
    buildOutputExists: existsSync(outputDir),
    astroCF: astroAdapter,
    vinext,
  });
  if (!planResult.ok) {
    if (jsonMode)
      jsonOutput({ ok: false, error: "nothing_to_deploy", message: planResult.reason }, 1);
    consola.error(planResult.reason);
    process.exit(1);
  }
  const plan = planResult.plan;

  if (vinext && vinext.unsupportedBindings.length > 0) {
    fail(
      "unsupported_bindings",
      `Creek can't provide these bindings from cloudflare.config.ts: ${vinext.unsupportedBindings
        .map((b) => `${b.name} (${b.type})`)
        .join(", ")}. Remove them, or the worker fails when it reads them.`,
    );
  }
  if (vinext && vinext.secrets.length > 0) {
    say.info(
      `  Secrets expected by the worker: ${vinext.secrets.join(", ")} — set them with \`creek env set <NAME> <value>\``,
    );
  }

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
    // collectAssets honours the dir's `.assetsignore`, where build tools
    // list their metadata (vinext: `.vite/manifest.json`).
    const collected = collectAssets(clientAssetsDir);
    clientAssets = collected.assets;
    fileList = collected.fileList;
  }

  // 7. Bundle server / worker. Five strategies, dispatched by either
  // (a) the framework when it's pre-bundled SSR, or (b) the plan's
  // worker.strategy for user-declared workers.
  let serverFiles: Record<string, string> | undefined;
  let workerModulePaths: string[] = [];
  // The uploaded entry's file name, where this deploy knows it for certain.
  // Sent as manifest.mainModule; the deploy servers run that file and refuse
  // the bundle if it is missing, so it is left null when only a guess is
  // possible (framework SSR output whose entry name varies by preset).
  let knownEntry: string | null = null;

  if (vinext) {
    // vinext's Build Output is a complete, pre-bundled worker.
    say.start("  Collecting vinext worker...");
    let collected: Record<string, Buffer> = {};
    try {
      collected = collectVinextServerFiles(cwd, vinext);
    } catch (err) {
      fail("invalid_build_output", (err as Error).message);
    }
    serverFiles = base64ServerFiles(collected);
    knownEntry = vinext.mainModule;
    say.success(`  vinext worker: ${Object.keys(collected).length} modules (${kb(collected)}KB)`);
  } else if (astroAdapter) {
    // Astro CF adapter writes a pre-bundled worker we just upload.
    const serverDir = resolve(cwd, astroAdapter.serverDir);
    if (existsSync(serverDir)) {
      say.start("  Collecting Astro CF server files...");
      const collected = collectServerFiles(serverDir);
      serverFiles = base64ServerFiles(collected);
      knownEntry = "entry.mjs";
      say.success(`  Astro CF worker: ${Object.keys(collected).length} files`);
    }
  } else if (isSSRFramework(framework) && framework) {
    if (framework === "nextjs" && hasAdapterOutput(cwd)) {
      // Next.js adapter output → patch bare imports, upload as-is.
      const adapterServerDir = resolve(cwd, ".creek/adapter-output/server");
      if (skipBuild) {
        // The upload is whatever the last build left behind; say how old it is.
        const builtAt = adapterOutputBuiltAt(cwd);
        if (builtAt)
          say.info(`  --skip-build: deploying .creek/adapter-output, ${describeBuildAge(builtAt)}`);
      }
      say.start("  Collecting adapter output...");
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
      // The adapter records its entry in manifest.json; declare it only when
      // that file was collected, else leave the servers to guess as before.
      const adapterEntry = readAdapterEntrypoint(cwd);
      if (adapterEntry && Object.hasOwn(collected, adapterEntry)) knownEntry = adapterEntry;
      say.success(`  Worker bundled: ${Object.keys(collected).length} files (${kb(collected)}KB)`);
    } else if (framework === "nextjs") {
      // Legacy Next.js: wrangler dry-run produces the bundle.
      const bundleDir = resolve(cwd, ".creek/bundled");
      say.start("  Bundling Next.js worker (legacy)...");
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
      say.success(`  Worker bundled: ${Object.keys(collected).length} files (${kb(collected)}KB)`);
    } else if (isPreBundledFramework(framework)) {
      // Nuxt / SvelteKit / SolidStart — the framework already produced
      // a bundled server; we just collect.
      const serverDirRel = getSSRServerDir(framework);
      if (serverDirRel) {
        const serverDir = resolve(cwd, serverDirRel);
        if (existsSync(serverDir)) {
          say.start("  Collecting SSR server files...");
          const collected = collectServerFiles(serverDir);
          serverFiles = base64ServerFiles(collected);
          say.success(`  SSR server: ${Object.keys(collected).length} files`);
        }
      }
    } else {
      // Fallback for SSR frameworks that emit a single entry file.
      const serverEntry = getSSRServerEntry(framework);
      if (serverEntry) {
        const serverEntryPath = resolve(outputDir, serverEntry);
        if (existsSync(serverEntryPath)) {
          say.start("  Bundling SSR server...");
          const bundled = await bundleSSRServer(serverEntryPath);
          serverFiles = { "server.js": Buffer.from(bundled).toString("base64") };
          say.success(`  SSR bundled (${Math.round(bundled.length / 1024)}KB)`);
        }
      }
    }
  } else if (plan.worker.strategy === "esbuild-bundle" && plan.worker.entry) {
    const workerEntryPath = resolve(cwd, plan.worker.entry);
    say.start("  Bundling worker...");
    // When the worker ships alongside static assets, embed the built
    // index.html so the wrapper can serve SPA deep-links on a miss. CF
    // Static Assets serves real files at the edge before the worker, and the
    // wrapper answers misses from the embedded shell without a second fetch.
    const indexHtmlB64 = clientAssets["index.html"] ?? clientAssets["/index.html"];
    const spaFallbackHtml =
      plan.assets.enabled && indexHtmlB64
        ? Buffer.from(indexHtmlB64, "base64").toString("utf-8")
        : undefined;
    const bundled = await bundleWorker(workerEntryPath, cwd, {
      hasClientAssets: plan.assets.enabled,
      spaFallbackHtml,
    });
    serverFiles = { "worker.js": Buffer.from(bundled).toString("base64") };
    knownEntry = "worker.js";
    say.success(`  Worker bundled (${Math.round(bundled.length / 1024)}KB)`);
  } else if (plan.worker.strategy === "upload-asis" && plan.worker.entry) {
    // Pre-bundled worker (e.g. dist/_worker.mjs from the user's own
    // esbuild step). Ship verbatim — no Creek runtime wrapper, no
    // re-bundle. This is the path that keeps deployed bundles free of
    // any @solcreek/* dependency.
    // A bundler that code-splits (rolldown, esbuild --splitting) emits chunks
    // next to the entry; ship every module the entry reaches by relative
    // import, named by its path from the entry's directory, so the imports
    // still resolve once the entry is renamed to worker.js.
    const modules = await collectWorkerModules(resolve(cwd, plan.worker.entry));
    serverFiles = base64ServerFiles(modules.files);
    // collectWorkerModules uploads the entry as worker.js.
    knownEntry = "worker.js";
    workerModulePaths = modules.absolutePaths;
    const extra = Object.keys(modules.files).length - 1;
    say.success(
      `  Worker (pre-bundled, ${kb(modules.files)}KB${extra > 0 ? `, entry + ${extra} chunk${extra > 1 ? "s" : ""}` : ""})`,
    );
  }

  // 8a. Chunks of a pre-bundled worker that live inside the asset dir are
  // worker modules, not public files.
  if (plan.assets.enabled && plan.assets.dir && workerModulePaths.length > 0) {
    const assetsRoot = resolve(cwd, plan.assets.dir);
    for (const abs of workerModulePaths) {
      const rel = relative(assetsRoot, abs).replace(/\\/g, "/");
      if (rel.startsWith("..")) continue;
      delete clientAssets[rel];
      delete clientAssets["/" + rel];
      fileList = fileList.filter((p) => p !== rel && p !== "/" + rel);
    }
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
  const effectiveRenderMode: "spa" | "ssr" | "worker" = astroAdapter ? "ssr" : plan.renderMode;
  const effectiveEntrypoint = vinext
    ? vinext.mainModule
    : astroAdapter
      ? "entry.mjs"
      : (plan.worker.entry ?? null);
  const mainModule = serverFiles ? knownEntry : null;

  // Resources declared but the deploy carries no server code: the
  // bindings get provisioned with nothing able to read them, and
  // /api/* serves static assets (unknown paths fall back to
  // index.html). Same condition as doctor's CK-RESOURCES-NO-WORKER —
  // repeated here because most deploys never run `creek doctor` first.
  const resourceBindings = resolved.bindings.filter(
    (b) => b.type === "d1" || b.type === "r2" || b.type === "kv" || b.type === "ai",
  );
  if (effectiveRenderMode === "spa" && resourceBindings.length > 0) {
    consola.warn(
      `  Resources declared (${resourceBindings.map((b) => `env.${b.name}`).join(", ")}) but no worker entry — deploying as a static SPA. /api/* will serve index.html, not server code. If that's unintended, set [build].worker in creek.toml (details: creek doctor).`,
    );
  }

  return {
    plan,
    framework,
    astroAdapter,
    vinext,
    effectiveRenderMode,
    effectiveEntrypoint,
    mainModule,
    fileList,
    assets: clientAssets,
    serverFiles,
  };
}

// --- helpers ---

/**
 * Follow a pre-bundled worker's relative imports and return every module it
 * reaches: JS chunks and the non-JS modules Workers accepts (`.json`, `.wasm`,
 * text, binary data). Imports come from esbuild's parser (static, re-export,
 * side-effect, and string-literal dynamic `import()`), so import-looking text
 * in comments or strings is not a dependency. Only JS modules are scanned for
 * further imports; a template-literal `import()` has no static target and is
 * left to the runtime.
 *
 * The entry is named `worker.js`; the rest keep their path relative to the
 * entry's directory. The deploy fails when a relative import leaves that
 * directory, when its target does not exist, or when another module would
 * also be named `worker.js`: shipping any of those leaves a dangling or
 * shadowed import that only breaks when a request reaches it.
 */
export async function collectWorkerModules(entryAbs: string): Promise<{
  files: Record<string, Buffer>;
  absolutePaths: string[];
}> {
  const root = dirname(entryAbs);
  const files: Record<string, Buffer> = {};
  const absolutePaths: string[] = [];
  const seen = new Set<string>();
  const queue = [entryAbs];
  const isJs = (path: string) => /\.(m?js|cjs)$/.test(path);
  const nameOf = (path: string) => relative(root, path).replace(/\\/g, "/");
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const name = file === entryAbs ? "worker.js" : nameOf(file);
    if (file !== entryAbs && name === "worker.js") {
      throw new Error(
        `worker entry ${basename(entryAbs)} imports a module also named worker.js, the name the entry is uploaded as; rename that module or bundle it into the entry`,
      );
    }
    files[name] = readFileSync(file);
    absolutePaths.push(file);
    if (!isJs(file)) continue;
    const from = file === entryAbs ? basename(entryAbs) : name;
    for (const spec of await relativeImports(file)) {
      if (spec.includes("*")) continue; // template-literal import(): no static target
      const target = resolve(dirname(file), spec);
      if (nameOf(target).startsWith("..")) {
        throw new Error(
          `worker module ${from} imports "${spec}", which is outside the worker's directory ${root}; bundle it into the worker first`,
        );
      }
      if (!existsSync(target) || !statSync(target).isFile()) {
        throw new Error(
          `worker module ${from} imports "${spec}", but ${target} does not exist; rebuild the worker or bundle it into one file`,
        );
      }
      queue.push(target);
    }
  }
  return { files, absolutePaths };
}

/** Relative import specifiers of one JS module, as esbuild's parser sees them. */
async function relativeImports(file: string): Promise<string[]> {
  const result = await esbuild({
    entryPoints: [file],
    bundle: true,
    write: false,
    metafile: true,
    format: "esm",
    platform: "neutral",
    logLevel: "silent",
    plugins: [
      {
        name: "collect-imports",
        setup(b) {
          // Record every import without resolving or loading it.
          b.onResolve({ filter: /.*/ }, (args) =>
            args.kind === "entry-point" ? undefined : { path: args.path, external: true },
          );
        },
      },
    ],
  });
  const input = Object.values(result.metafile!.inputs)[0];
  return (input?.imports ?? [])
    .map((i) => i.path)
    .filter((p) => p.startsWith("./") || p.startsWith("../"));
}

/**
 * Add the bindings a framework's build output declares (vinext:
 * `cloudflare.config.ts`) to those from creek.toml / wrangler.*. Config
 * wins on a binding-name conflict, so an explicit declaration is never
 * overridden.
 */
export function mergeFrameworkBindings(
  base: BindingRequirement[],
  vinext: VinextBuild | null,
): BindingRequirement[] {
  if (!vinext) return base;
  const taken = new Set(base.map((b) => b.bindingName));
  const extra = vinext.bindings
    .filter(
      (b): b is typeof b & { type: BindingRequirement["type"] } =>
        ["d1", "r2", "kv", "ai"].includes(b.type) && !taken.has(b.name),
    )
    .map((b) => ({ type: b.type, bindingName: b.name }));
  return [...base, ...extra];
}

function base64ServerFiles(collected: Record<string, Buffer>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(collected).map(([p, buf]) => [p, buf.toString("base64")]),
  );
}

function kb(collected: Record<string, Buffer>): number {
  return Math.round(Object.values(collected).reduce((s, b) => s + b.length, 0) / 1024);
}
