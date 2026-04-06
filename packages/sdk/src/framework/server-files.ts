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

// Files to skip when collecting server output
const SKIP_DIRS = new Set(["node_modules", ".git"]);

// Only these extensions are valid CF Workers module types
const VALID_WORKER_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs",  // JavaScript modules
  ".json",                 // JSON modules
  ".wasm",                 // WebAssembly
  ".txt",                  // Text modules
  ".html",                 // Text modules
]);

function shouldSkipFile(name: string): boolean {
  if (name.endsWith(".map")) return true;

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
 * The caller is responsible for base64 encoding if needed.
 */
export function collectServerFiles(
  dir: string,
  options?: { maxFiles?: number },
): Record<string, Buffer> {
  const maxFiles = options?.maxFiles ?? 500;
  const result: Record<string, Buffer> = {};

  if (!existsSync(dir)) return result;

  _collectRecursive(dir, dir, result, maxFiles);
  return result;
}

function _collectRecursive(
  dir: string,
  base: string,
  out: Record<string, Buffer>,
  maxFiles: number,
): void {
  if (Object.keys(out).length >= maxFiles) return;

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (Object.keys(out).length >= maxFiles) return;
    if (SKIP_DIRS.has(entry.name)) continue;

    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      _collectRecursive(full, base, out, maxFiles);
    } else if (entry.isFile() && !shouldSkipFile(entry.name)) {
      const rel = relative(base, full);
      out[rel] = readFileSync(full);
    }
  }
}
