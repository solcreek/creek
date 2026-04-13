/**
 * planDeploy — pure resolver for the "what shape is this deploy?" question.
 *
 * Given the inputs that detection has already extracted (framework, worker
 * entry, build output state, optional Astro CF adapter result), return a
 * single explicit plan describing what the CLI / build-container should
 * do. No filesystem IO, no execSync — IO happens upstream and the result
 * is fed in. Anything that can branch is captured as a discriminated
 * union so callers cannot quietly miss a case.
 *
 * The CLI's two deploy paths (`deploySandbox`, `deployAuthenticated`)
 * historically each rolled their own ad-hoc combination of `isWorker`,
 * `isSSR`, `framework`, `workerHasClientAssets`. They drifted: the
 * sandbox path was missing the worker branch entirely (cli@0.4.6 bug),
 * and neither supported "static frontend framework + custom Worker"
 * coexist. This file is the single source of truth they now both use.
 *
 * Test surface: `deploy-plan.test.ts`. Add a row there for any new
 * scenario before adjusting this function.
 */

import { isSSRFramework, type Framework } from "../types/index.js";

export interface PlanDeployInput {
  /** Detected framework, or null for "no framework / vanilla Worker / static". */
  framework: Framework | null;
  /**
   * Worker entry path from creek.toml `[build].worker`, relative to the
   * project root. Null when the project has no custom worker.
   */
  workerEntry: string | null;
  /** Whether the worker entry file actually exists on disk. */
  workerEntryExists: boolean;
  /** Build output dir from creek.toml `[build].output`, relative to root. */
  buildOutput: string;
  /** Whether the build output dir exists on disk. */
  buildOutputExists: boolean;
  /**
   * Astro `@astrojs/cloudflare` adapter post-build detection. Null when
   * the framework isn't Astro or the adapter wasn't used.
   */
  astroCF: { serverDir: string; assetsDir: string } | null;
}

/**
 * Strategy for producing the worker bundle that will be uploaded.
 *
 *   none           — no worker; SPA / static-only deploy.
 *   ssr-framework  — framework already produced bundled server files; copy them.
 *   esbuild-bundle — workerEntry is TS / unbundled JS; CLI runs esbuild.
 *   upload-asis    — workerEntry is already a bundled JS/MJS file (lives
 *                    inside buildOutput); upload bytes verbatim, no wrap.
 */
export type WorkerStrategy =
  | "none"
  | "ssr-framework"
  | "esbuild-bundle"
  | "upload-asis";

export interface DeployPlan {
  /**
   * Render mode the deploy API expects. "worker" is treated as an alias
   * of "ssr" by deploy-core (both upload `serverFiles` as the main
   * module); the distinction is preserved for telemetry / debugging.
   */
  renderMode: "spa" | "ssr" | "worker";
  /**
   * Whether to collect static client assets at all, the directory to
   * collect from (relative to project root), and an optional file path
   * to exclude (used when the prebundled worker lives inside that dir).
   */
  assets: {
    enabled: boolean;
    dir: string | null;
    excludeFile: string | null;
  };
  /** Worker bundling strategy + the source path it applies to. */
  worker: {
    strategy: WorkerStrategy;
    entry: string | null;
  };
}

export type PlanDeployResult =
  | { ok: true; plan: DeployPlan }
  | { ok: false; reason: string };

/**
 * `dist/_worker.mjs` lives inside `dist/` → return relative path
 * `_worker.mjs` so the asset collector can skip it. `server/worker.ts`
 * outside `dist/` → return null (no exclusion needed because the source
 * file isn't in the asset dir to begin with).
 */
function workerInsideAssets(
  workerEntry: string,
  buildOutput: string,
): string | null {
  const wParts = normalize(workerEntry).split("/");
  const oParts = normalize(buildOutput).split("/");
  if (wParts.length <= oParts.length) return null;
  for (let i = 0; i < oParts.length; i++) {
    if (wParts[i] !== oParts[i]) return null;
  }
  return wParts.slice(oParts.length).join("/");
}

function isPrebundledExt(path: string): boolean {
  return /\.(js|mjs|cjs)$/.test(path);
}

function normalize(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

export function planDeploy(input: PlanDeployInput): PlanDeployResult {
  const { framework, workerEntry, workerEntryExists, buildOutput, buildOutputExists, astroCF } = input;
  const isSSR = isSSRFramework(framework);
  const hasWorker = !!workerEntry;

  // 1. Worker entry declared but file missing → hard fail. The user
  //    explicitly pointed at it; don't silently fall back to SPA.
  if (hasWorker && !workerEntryExists) {
    return { ok: false, reason: `worker entry not found: ${workerEntry}` };
  }

  // 2. Astro + @astrojs/cloudflare adapter — wins regardless of any
  //    user-declared workerEntry, because the adapter's pre-bundled
  //    output is what we deploy. If the user ALSO declared a custom
  //    worker, that's an unsupported combination.
  if (astroCF) {
    if (hasWorker) {
      return { ok: false, reason: "astro CF adapter conflicts with custom workerEntry" };
    }
    return {
      ok: true,
      plan: {
        renderMode: "ssr",
        assets: { enabled: true, dir: astroCF.assetsDir, excludeFile: null },
        worker: { strategy: "ssr-framework", entry: astroCF.serverDir },
      },
    };
  }

  // 3. SSR framework (Nuxt / SvelteKit / Next / TanStack Start / etc.)
  //    handles its own server bundling. A user-declared workerEntry on
  //    top is ambiguous — refuse rather than silently picking one.
  if (isSSR && framework) {
    if (hasWorker) {
      return { ok: false, reason: `framework ${framework} already provides server bundle; remove [build].worker or pick one` };
    }
    return {
      ok: true,
      plan: {
        renderMode: "ssr",
        assets: { enabled: true, dir: buildOutput, excludeFile: null },
        worker: { strategy: "ssr-framework", entry: null },
      },
    };
  }

  // 4. User-declared worker present (with or without a static frontend
  //    framework). This is the Workers + (optional) Static Assets case.
  if (hasWorker && workerEntry) {
    const insideAssets = workerInsideAssets(workerEntry, buildOutput);
    const prebundled = isPrebundledExt(workerEntry) && insideAssets !== null;
    const strategy: WorkerStrategy = prebundled ? "upload-asis" : "esbuild-bundle";

    // Asset collection: enabled when buildOutput exists and contains
    // anything besides the worker file itself. Without a frontend
    // framework AND with a prebundled worker that IS the buildOutput,
    // there's still nothing to serve as static — but the asset dir
    // existing is the right gate; collectAssets just returns [] if
    // there's nothing else.
    const assetsEnabled = buildOutputExists;

    return {
      ok: true,
      plan: {
        renderMode: "worker",
        assets: {
          enabled: assetsEnabled,
          dir: assetsEnabled ? buildOutput : null,
          excludeFile: assetsEnabled ? insideAssets : null,
        },
        worker: { strategy, entry: workerEntry },
      },
    };
  }

  // 5. No worker, no SSR framework. Plain static / SPA — must have a
  //    build output to upload, otherwise there's nothing to deploy.
  if (!buildOutputExists) {
    return { ok: false, reason: `nothing to deploy: build output ${buildOutput} not found and no [build].worker declared` };
  }
  return {
    ok: true,
    plan: {
      renderMode: "spa",
      assets: { enabled: true, dir: buildOutput, excludeFile: null },
      worker: { strategy: "none", entry: null },
    },
  };
}
