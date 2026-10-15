import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The saved API key is bound to the API `creek login` verified it against,
 * and getToken() (utils/config.ts) enforces that binding. This scan keeps
 * every command on that one route: no other module reads the saved token
 * from the config, and only the key commands that enforce the binding
 * themselves (and login, which writes it) look at it through
 * getTokenInfo().
 */
const SRC = dirname(fileURLToPath(import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test(-d)?\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Files that use `pattern`, relative to src/. */
function usersOf(pattern: RegExp): string[] {
  return sources(SRC)
    .filter((file) => pattern.test(readFileSync(file, "utf8")))
    .map((file) => relative(SRC, file))
    .sort();
}

describe("the saved API key is read only through getToken()", () => {
  it("only config.ts and login (which writes it) read the CLI config", () => {
    expect(usersOf(/\breadCliConfig\s*\(/)).toEqual(["commands/login.ts", "utils/config.ts"]);
  });

  it("only the key commands, which check the binding themselves, use getTokenInfo()", () => {
    expect(usersOf(/\bgetTokenInfo\s*\(/)).toEqual([
      "commands/keys.ts",
      "commands/login.ts",
      "commands/logout.ts",
      "commands/whoami.ts",
      "utils/config.ts",
    ]);
  });

  it("nothing else opens ~/.creek/config.json", () => {
    expect(usersOf(/["'`]config\.json["'`]/)).toEqual(["utils/config.ts"]);
  });
});
