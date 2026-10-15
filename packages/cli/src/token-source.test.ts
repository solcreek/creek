import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The saved API key is bound to the API `creek login` verified it against,
 * and getToken() (utils/config.ts) enforces that binding against
 * getApiUrl(). This scan keeps every command on that one route:
 *
 * - no other module reads the CLI config (by name, under an alias, or
 *   through a namespace import of config.js);
 * - only the key commands that enforce the binding themselves (and login,
 *   which writes it) look at it through getTokenInfo();
 * - every CreekClient is built on getApiUrl(), the URL getToken() checked
 *   the key against. login is the exception: it binds the key to the one
 *   URL it captured for verification.
 */
const SRC = dirname(fileURLToPath(import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test(-d)?\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Files (relative to src/) whose source `test` flags. */
function filesWhere(test: (source: string) => boolean): string[] {
  return sources(SRC)
    .filter((file) => test(readFileSync(file, "utf8")))
    .map((file) => relative(SRC, file))
    .sort();
}

/**
 * Whether a module can reach readCliConfig: it names it anywhere (a call,
 * `import { readCliConfig as cfg }`, a re-export), or imports config.js as
 * a namespace (`import * as config`, `await import(".../config.js")`).
 */
export function readsCliConfig(source: string): boolean {
  return (
    /\breadCliConfig\b/.test(source) ||
    /import\s*\*\s*as\s+\w+\s+from\s*["'][^"']*\/config(\.js)?["']/.test(source) ||
    /\bimport\s*\(\s*["'][^"']*\/config(\.js)?["']\s*\)/.test(source)
  );
}

/** The first argument of every `new CreekClient(...)` that is not getApiUrl(). */
export function clientBasesOtherThanGetApiUrl(source: string): string[] {
  return [...source.matchAll(/new\s+CreekClient\s*\(\s*([^,]*?)\s*,/g)]
    .map((m) => m[1].trim())
    .filter((base) => base !== "getApiUrl()");
}

describe("the scan's rules", () => {
  it.each([
    ["a direct call", 'import { readCliConfig } from "../utils/config.js";\nreadCliConfig();'],
    [
      "an aliased import",
      'import { readCliConfig as cfg } from "../utils/config.js";\ncfg().token;',
    ],
    ["a namespace import", 'import * as config from "../utils/config.js";\nconfig.getApiUrl();'],
    ["a dynamic import", 'const c = await import("./utils/config.js");'],
    ["a re-export", 'export { readCliConfig } from "./config.js";'],
  ])("flags %s of the CLI config", (_, source) => {
    expect(readsCliConfig(source)).toBe(true);
  });

  it("does not flag the named getters", () => {
    expect(readsCliConfig('import { getToken, getApiUrl } from "../utils/config.js";')).toBe(false);
  });

  it("flags a CreekClient on any base URL but getApiUrl()", () => {
    expect(
      clientBasesOtherThanGetApiUrl(
        "new CreekClient(getApiUrl(), token);\nnew CreekClient(apiUrl, token);\nnew CreekClient( process.env.X!, t)",
      ),
    ).toEqual(["apiUrl", "process.env.X!"]);
  });
});

describe("the saved API key is read only through getToken()", () => {
  it("only config.ts and login (which writes it) can reach the CLI config", () => {
    expect(filesWhere(readsCliConfig)).toEqual(["commands/login.ts", "utils/config.ts"]);
  });

  it("only the key commands, which check the binding themselves, use getTokenInfo()", () => {
    expect(filesWhere((s) => /\bgetTokenInfo\s*\(/.test(s))).toEqual([
      "commands/keys.ts",
      "commands/login.ts",
      "commands/logout.ts",
      "commands/whoami.ts",
      "utils/config.ts",
    ]);
  });

  it("nothing else opens ~/.creek/config.json", () => {
    expect(filesWhere((s) => /["'`]config\.json["'`]/.test(s))).toEqual(["utils/config.ts"]);
  });

  it("every CreekClient is built on getApiUrl() (login excepted)", () => {
    const offenders = filesWhere((s) => clientBasesOtherThanGetApiUrl(s).length > 0);
    expect(offenders).toEqual(["commands/login.ts"]);
  });
});
