import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { applyAssetsIgnore, ASSETS_IGNORE_FILE } from "@solcreek/sdk";

export interface BundleAssets {
  assets: Record<string, string>; // path -> base64
  fileList: string[];
}

const IGNORED_DIRS = new Set(["node_modules", ".git", ".svn", ".hg", ".next", ".nuxt", ".output"]);

const IGNORED_FILES = new Set([
  ".DS_Store",
  "Thumbs.db",
  ".env",
  ".env.local",
  ".env.production",
  ".gitignore",
  ".npmrc",
  ".eslintcache",
  "creek.toml",
  "wrangler.toml",
  "wrangler.json",
  "wrangler.jsonc",
]);

function isIgnored(name: string): boolean {
  return (
    (name.startsWith(".") && IGNORED_FILES.has(name)) ||
    IGNORED_FILES.has(name) ||
    name.endsWith("~") ||
    name.endsWith(".swp")
  );
}

/**
 * Collect every asset under `dir`, minus what the `.assetsignore` at its
 * root excludes (Wrangler's asset exclusion file). Every asset upload —
 * framework builds and `creek deploy <dir>` alike — goes through here, so
 * the exclusions hold on all of them.
 */
export function collectAssets(dir: string): BundleAssets {
  const collected = collectTree(dir, dir);
  const ignorePath = join(dir, ASSETS_IGNORE_FILE);
  const ignoreContent = existsSync(ignorePath) ? readFileSync(ignorePath, "utf-8") : null;
  return applyAssetsIgnore(ignoreContent, collected.assets, collected.fileList);
}

function collectTree(dir: string, base: string): BundleAssets {
  const assets: Record<string, string> = {};
  const fileList: string[] = [];

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;

    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = collectTree(fullPath, base);
      Object.assign(assets, sub.assets);
      fileList.push(...sub.fileList);
    } else if (entry.isFile() && !isIgnored(entry.name)) {
      const relPath = relative(base, fullPath);
      const content = readFileSync(fullPath);
      assets[relPath] = content.toString("base64");
      fileList.push(relPath);
    }
  }

  return { assets, fileList };
}
