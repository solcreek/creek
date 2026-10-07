/**
 * `.assetsignore` — asset exclusion patterns read from the root of the
 * assets directory, as Wrangler does. Build tools write one to keep build
 * metadata out of the public asset bundle (vinext lists `.vite`, whose
 * `manifest.json` would otherwise be served).
 *
 * Supports the gitignore subset these files use in practice: comments,
 * `!` negation (last match wins), `*` / `**` / `?` globs, a trailing `/`
 * for directories, and anchoring by a leading or inner `/`. A pattern that
 * matches a directory excludes everything under it. The file itself is
 * never uploaded.
 */

export const ASSETS_IGNORE_FILE = ".assetsignore";

interface Rule {
  negate: boolean;
  dirOnly: boolean;
  regex: RegExp;
}

/** Compile `.assetsignore` content into a predicate over asset paths. */
export function parseAssetsIgnore(content: string): (relPath: string) => boolean {
  const rules: Rule[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const negate = line.startsWith("!");
    if (negate) line = line.slice(1);
    const dirOnly = line.endsWith("/");
    if (dirOnly) line = line.replace(/\/+$/, "");
    const anchored = line.includes("/");
    line = line.replace(/^\/+/, "");
    if (!line) continue;
    const body = globToRegex(line);
    rules.push({
      negate,
      dirOnly,
      regex: new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`),
    });
  }

  return (relPath: string) => {
    const path = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
    if (path === ASSETS_IGNORE_FILE) return true;
    // Test the file and each ancestor directory: ignoring a directory
    // ignores its contents.
    const segments = path.split("/");
    let ignored = false;
    for (const rule of rules) {
      for (let i = 1; i <= segments.length; i++) {
        const isDir = i < segments.length;
        if (rule.dirOnly && !isDir) continue;
        if (rule.regex.test(segments.slice(0, i).join("/"))) {
          ignored = !rule.negate;
          break;
        }
      }
    }
    return ignored;
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

function globToRegex(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` matches zero or more directories; a bare `**` matches anything.
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return out;
}
