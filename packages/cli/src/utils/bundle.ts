import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface BundleAssets {
  assets: Record<string, string>; // path -> base64
  fileList: string[];
}

const IGNORED_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg", ".next", ".nuxt", ".output",
]);

const IGNORED_FILES = new Set([
  ".DS_Store", "Thumbs.db", ".env", ".env.local", ".env.production",
  ".gitignore", ".npmrc", ".eslintcache",
]);

function isIgnored(name: string): boolean {
  return name.startsWith(".") && IGNORED_FILES.has(name)
    || IGNORED_FILES.has(name)
    || name.endsWith("~")
    || name.endsWith(".swp");
}

export function collectAssets(dir: string, baseDir?: string): BundleAssets {
  const base = baseDir ?? dir;
  const assets: Record<string, string> = {};
  const fileList: string[] = [];

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;

    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = collectAssets(fullPath, base);
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
