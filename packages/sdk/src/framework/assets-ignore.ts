/**
 * `.assetsignore` — asset exclusion patterns read from the root of the
 * assets directory, as Wrangler does. Build tools write one to keep build
 * metadata out of the public asset bundle (vinext lists `.vite`, whose
 * `manifest.json` would otherwise be served).
 *
 * Supports the gitignore subset these files use in practice: comments,
 * `!` negation (last match wins), `*` / `**` / `?` globs, a trailing `/`
 * for directories, and anchoring by a leading or inner `/`. A pattern that
 * matches a directory excludes everything under it, and a negation cannot
 * re-include a file inside an excluded directory. The file itself is
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

  // Last matching rule wins: true = ignored, false = re-included, null = no match.
  const decide = (path: string, isDir: boolean): boolean | null => {
    let state: boolean | null = null;
    for (const rule of rules) {
      if (rule.dirOnly && !isDir) continue;
      if (rule.regex.test(path)) state = !rule.negate;
    }
    return state;
  };

  return (relPath: string) => {
    const path = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
    if (path === ASSETS_IGNORE_FILE) return true;
    // As in gitignore, a file under an ignored directory stays ignored —
    // a negation can re-include the directory, but not a file inside it.
    const segments = path.split("/");
    for (let i = 1; i < segments.length; i++) {
      if (decide(segments.slice(0, i).join("/"), true) === true) return true;
    }
    return decide(path, false) === true;
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
