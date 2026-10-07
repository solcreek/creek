/**
 * SSR server file utilities for pre-bundled frameworks.
 *
 * Key insight: SSR frameworks (Nuxt, SvelteKit, etc.) pre-bundle their server
 * output into chunked modules. You should NOT re-bundle with esbuild — upload
 * the entire server directory as worker modules.
 *
 * Discovered via PoC (2026-03-27): esbuild re-bundle of Nuxt's .output/server/index.mjs
 * fails because of dynamic imports and chunk references. Direct upload works.
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Framework } from "../types/index.js";

/**
 * Maps framework to the relative path of its pre-bundled server output directory.
 * Returns null for SPA frameworks or unknown frameworks.
 */
export function getSSRServerDir(framework: Framework | null): string | null {
  switch (framework) {
    case "nuxt":
      return ".output/server";
    case "solidstart":
      return ".output/server";
    case "nextjs":
      return ".open-next/server-functions/default";
    case "sveltekit":
      return ".svelte-kit/output/server";
    case "react-router":
      return "build/server";
    case "tanstack-start":
      return "dist/server";
    default:
      return null;
  }
}

/**
 * Returns true for frameworks that pre-bundle their server output.
 * These should NOT be re-bundled with esbuild — upload the server dir directly.
 */
export function isPreBundledFramework(framework: Framework | null): boolean {
  return getSSRServerDir(framework) !== null;
}

/**
 * Post-build detection for Astro + `@astrojs/cloudflare` adapter.
 *
 * Astro's adapter layer only picks a target at build time, so we can't
 * tell pre-install whether a project is "Astro SSG" (`dist/`), "Astro
 * with Node adapter" (`dist/server/entry.mjs`, node-targeted, we can't
 * run), or "Astro with CF adapter" (`dist/server/entry.mjs`
 * workerd-targeted + `dist/client/`).
 *
 * The distinguishing fingerprint is `dist/server/wrangler.json` —
 * that file is **only** emitted by `@astrojs/cloudflare`, because it's
 * the adapter writing down the resolved CF bindings for downstream
 * deploy tools. The Node adapter does not emit it.
 *
 * Returns the split output directories, or null if this isn't a CF
 * adapter build. Callers should still guard on `framework === "astro"`
 * to avoid false positives in unrelated projects that happen to have
 * a `dist/server/` (unlikely but cheap to check).
 */
export function detectAstroCloudflareBuild(cwd: string): {
  /** Relative path to the pre-bundled Worker output (`entry.mjs` + chunks). */
  serverDir: string;
  /** Relative path to the static client assets. */
  assetsDir: string;
} | null {
  if (
    existsSync(join(cwd, "dist/server/entry.mjs")) &&
    existsSync(join(cwd, "dist/server/wrangler.json"))
  ) {
    return { serverDir: "dist/server", assetsDir: "dist/client" };
  }
  return null;
}

// Names the deploy servers take as a worker's main module: deploy-core
// (sandbox) and the control-plane's copy each pick the FIRST file, in
// upload order, whose name is one of theirs, else the first file. They do
// not read the manifest's entrypoint. Only deploy-core knows `entry.mjs`.
const CONTROL_PLANE_MAIN_MODULES = ["worker.js", "server.js", "index.js", "index.mjs"];
const DEPLOY_CORE_MAIN_MODULES = [...CONTROL_PLANE_MAIN_MODULES, "entry.mjs"];

/**
 * Whether both deploy servers will take `mainModule` as the entry of a
 * worker made of `names`, whatever order the files arrive in: both must
 * know its name, and no other name either of them knows may be present.
 */
export function isEntryModuleSelected(names: string[], mainModule: string): boolean {
  if (!names.includes(mainModule) || !CONTROL_PLANE_MAIN_MODULES.includes(mainModule)) {
    return false;
  }
  return names.every((n) => n === mainModule || !DEPLOY_CORE_MAIN_MODULES.includes(n));
}

// Files to skip when collecting server output
const SKIP_DIRS = new Set(["node_modules", ".git"]);

// Only these extensions are valid CF Workers module types
const VALID_WORKER_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs", // JavaScript modules
  ".json", // JSON modules
  ".wasm", // WebAssembly
  ".txt", // Text modules
  ".html", // Text modules
]);

// Config-style files that adapters may drop into the server output
// directory but that are NOT runtime modules. Uploading them as Worker
// modules makes CF's module uploader reject the whole deploy with
// code 10162 ("unsupported Content-Type application/json").
//
// Example: @astrojs/cloudflare writes dist/server/wrangler.json with
// the adapter-resolved bindings for downstream `wrangler deploy`; it
// is never imported by entry.mjs.
const SKIP_FILENAMES = new Set(["wrangler.json", "wrangler.jsonc", "wrangler.toml", ".wrangler"]);

function shouldSkipFile(name: string): boolean {
  if (name.endsWith(".map")) return true;
  if (SKIP_FILENAMES.has(name)) return true;

  // Skip files without a valid worker module extension
  // (e.g., BUILD_ID, LICENSE, .meta files, binary files)
  const lastDot = name.lastIndexOf(".");
  if (lastDot === -1) return true; // no extension (e.g., BUILD_ID)
  const ext = name.slice(lastDot);
  if (!VALID_WORKER_EXTENSIONS.has(ext)) return true;

  return false;
}

/**
 * Recursively collect all files from a directory into Record<relativePath, Buffer>.
 *
 * Skips:
 * - .map files (source maps break WfP module parsing)
 * - node_modules/ (too large, not needed)
 *
 * Throws when the directory holds more than `maxFiles` modules: a worker
 * uploaded with some of its chunks missing fails at runtime, on whichever
 * route imports them, so a partial collection is never usable.
 *
 * `include` drops files by their relative path before they count toward
 * `maxFiles`.
 *
 * The caller is responsible for base64 encoding if needed.
 */
export function collectServerFiles(
  dir: string,
  options?: { maxFiles?: number; include?: (relPath: string) => boolean },
): Record<string, Buffer> {
  const maxFiles = options?.maxFiles ?? 500;
  const include = options?.include ?? (() => true);
  const result: Record<string, Buffer> = {};

  if (!existsSync(dir)) return result;

  _collectRecursive(dir, dir, result, maxFiles, include);
  return result;
}

function _collectRecursive(
  dir: string,
  base: string,
  out: Record<string, Buffer>,
  maxFiles: number,
  include: (relPath: string) => boolean,
): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;

    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      _collectRecursive(full, base, out, maxFiles, include);
    } else if (entry.isFile() && !shouldSkipFile(entry.name)) {
      const rel = relative(base, full);
      if (!include(rel)) continue;
      if (Object.keys(out).length >= maxFiles) {
        throw new Error(
          `${base} has more than ${maxFiles} worker modules; refusing to upload a partial worker`,
        );
      }
      out[rel] = readFileSync(full);
    }
  }
}
