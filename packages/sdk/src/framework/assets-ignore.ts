/**
 * `.assetsignore` — asset exclusion patterns read from the root of the
 * assets directory, as Wrangler does. Build tools write one to keep build
 * metadata out of the public asset bundle (vinext lists `.vite`, whose
 * `manifest.json` would otherwise be served).
 *
 * Patterns follow gitignore, matched by the `ignore` package — the same
 * matcher Wrangler uses — so a file Wrangler would keep private stays
 * private here too. The file itself is never uploaded.
 */

import ignore from "ignore";

export const ASSETS_IGNORE_FILE = ".assetsignore";

/** Compile `.assetsignore` content into a predicate over asset paths. */
export function parseAssetsIgnore(content: string): (relPath: string) => boolean {
  const matcher = ignore().add(content);
  return (relPath: string) => {
    const path = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
    if (path === ASSETS_IGNORE_FILE) return true;
    return matcher.ignores(path);
  };
}

/**
 * Drop ignored entries from collected assets. `assets` keys and `fileList`
 * entries are paths relative to the assets dir, with or without a leading
 * `/`. Returns the inputs unchanged when there is no `.assetsignore`.
 */
export function applyAssetsIgnore<T>(
  ignoreContent: string | null,
  assets: Record<string, T>,
  fileList: string[],
): { assets: Record<string, T>; fileList: string[] } {
  if (ignoreContent === null) return { assets, fileList };
  const ignored = parseAssetsIgnore(ignoreContent);
  return {
    assets: Object.fromEntries(Object.entries(assets).filter(([p]) => !ignored(p))),
    fileList: fileList.filter((p) => !ignored(p)),
  };
}
