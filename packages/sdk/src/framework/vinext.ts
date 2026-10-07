/**
 * vinext (Next.js API surface on Vite) — Cloudflare build output.
 *
 * `vinext init --platform=cloudflare` sets the project up for `cf` and the
 * Cloudflare Vite plugin, and `vite build` then writes a complete,
 * pre-bundled Worker to `.cloudflare/output/v0/workers/default/`:
 *
 *   worker.config.json   compat date/flags, bindings, assets options,
 *                        `manifest.mainModule`
 *   bundle/              worker modules (entry + chunks)
 *   assets/              static assets, with vinext's `.assetsignore`
 *
 * Creek deploys that output as-is: `bundle/` as the worker's modules,
 * `assets/` as Static Assets. The worker reads its own assets through
 * `env.ASSETS`, so it deploys in `worker` render mode — Creek attaches the
 * ASSETS binding only there.
 *
 * The legacy Wrangler setup (`--legacy-wrangler-cloudflare-init`) is not
 * supported: it writes no Build Output, and its wrangler `main` is a
 * package path (`vinext/server/fetch-handler`), not a file.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BindingDeclaration } from "../config/resolved-config.js";
import { collectServerFiles, isEntryModuleSelected } from "./server-files.js";

export const VINEXT_OUTPUT_DIR = ".cloudflare/output/v0/workers/default";
export const VINEXT_SERVER_DIR = `${VINEXT_OUTPUT_DIR}/bundle`;
export const VINEXT_ASSETS_DIR = `${VINEXT_OUTPUT_DIR}/assets`;
const WORKER_CONFIG = `${VINEXT_OUTPUT_DIR}/worker.config.json`;

export interface VinextBuild {
  /** Worker modules, relative to the project root. */
  serverDir: string;
  /** Static assets, relative to the project root. */
  assetsDir: string;
  /** Entry module, relative to `serverDir`. */
  mainModule: string;
  /**
   * `assets.runWorkerFirst`: paths the worker must handle before Static
   * Assets. vinext's static-assets cache sets it to keep private cache
   * artifacts from being served directly.
   */
  runWorkerFirst: boolean | string[] | null;
  compatibilityDate: string | null;
  compatibilityFlags: string[];
  /** KV / D1 / R2 / AI bindings the worker declares, under its own names. */
  bindings: BindingDeclaration[];
  /** Plain-text bindings (`bindings.text()`), deployed as vars. */
  vars: Record<string, string>;
  /** Secret names the worker expects; Creek does not create them. */
  secrets: string[];
  /** Bindings Creek cannot provide. A deploy with any of these must stop. */
  unsupportedBindings: { type: string; name: string }[];
}

/**
 * Read the vinext build output under `cwd`. Returns null when there is no
 * `worker.config.json` (not built, or built with the legacy Wrangler setup).
 * Throws when the file exists but is not a usable worker config.
 */
export function detectVinextBuild(cwd: string): VinextBuild | null {
  const configPath = join(cwd, WORKER_CONFIG);
  if (!existsSync(configPath)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    throw new Error(`${WORKER_CONFIG} is not valid JSON`);
  }
  return parseVinextWorkerConfig(raw);
}

/** Pure half of `detectVinextBuild`: map a parsed `worker.config.json`. */
export function parseVinextWorkerConfig(raw: unknown): VinextBuild {
  if (!isObject(raw)) throw new Error(`${WORKER_CONFIG} is not a JSON object`);

  const manifest = isObject(raw.manifest) ? raw.manifest : {};
  const mainModule = typeof manifest.mainModule === "string" ? manifest.mainModule : null;
  if (!mainModule) throw new Error(`${WORKER_CONFIG} has no manifest.mainModule`);

  const assets = isObject(raw.assets) ? raw.assets : {};
  const rwf = assets.runWorkerFirst;
  const runWorkerFirst =
    typeof rwf === "boolean"
      ? rwf
      : Array.isArray(rwf) && rwf.every((p) => typeof p === "string")
        ? (rwf as string[])
        : null;

  const build: VinextBuild = {
    serverDir: VINEXT_SERVER_DIR,
    assetsDir: VINEXT_ASSETS_DIR,
    mainModule,
    runWorkerFirst,
    compatibilityDate: typeof raw.compatibilityDate === "string" ? raw.compatibilityDate : null,
    compatibilityFlags: Array.isArray(raw.compatibilityFlags)
      ? raw.compatibilityFlags.filter((f): f is string => typeof f === "string")
      : [],
    bindings: [],
    vars: {},
    secrets: [],
    unsupportedBindings: [],
  };

  const env = isObject(raw.env) ? raw.env : {};
  for (const [name, value] of Object.entries(env)) {
    const type = isObject(value) && typeof value.type === "string" ? value.type : "unknown";
    switch (type) {
      case "kv":
      case "d1":
      case "r2":
      case "ai":
        build.bindings.push({ type, name });
        break;
      case "assets":
        // Creek attaches Static Assets as `ASSETS` in worker mode, which is
        // the name vinext reads. Any other name would come up undefined.
        if (name !== "ASSETS") build.unsupportedBindings.push({ type, name });
        break;
      case "text":
        if (isObject(value) && typeof value.value === "string") build.vars[name] = value.value;
        else build.unsupportedBindings.push({ type, name });
        break;
      case "secret":
        build.secrets.push(name);
        break;
      default:
        build.unsupportedBindings.push({ type, name });
    }
  }

  return build;
}

/**
 * Collect the worker modules of a vinext build. JSON files in `bundle/`
 * are build metadata (`.vite/manifest.json`, `vinext-server.json`) that no
 * module imports — the bundler inlines JSON imports — and the Workers
 * upload API rejects a JSON module part (code 10162), so they are left out.
 *
 * Throws unless the deploy servers will take `manifest.mainModule` as the
 * entry: they pick it by file name, not from the manifest.
 */
export function collectVinextServerFiles(cwd: string, build: VinextBuild): Record<string, Buffer> {
  const files = collectServerFiles(join(cwd, build.serverDir));
  const modules = Object.fromEntries(
    Object.entries(files).filter(([name]) => !name.endsWith(".json")),
  );
  if (!isEntryModuleSelected(Object.keys(modules), build.mainModule)) {
    throw new Error(
      `vinext worker entry ${build.mainModule} is missing from ${build.serverDir}, or another module would be picked as the entry`,
    );
  }
  return modules;
}

/**
 * The package.json script that runs vinext's build. A project migrated with
 * `vinext init` keeps `build` as `next build` and gets `build:vinext`
 * alongside it; a `create-vinext-app` project has only `build`.
 */
export function vinextBuildScript(packageJson: { scripts?: Record<string, string> }): string {
  return packageJson.scripts?.["build:vinext"] ? "build:vinext" : "build";
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
