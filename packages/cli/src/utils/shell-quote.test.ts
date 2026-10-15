import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { shellQuote } from "./shell-quote.js";

/** Let a real POSIX shell split `words`, one argument per line. */
function shellSplit(words: string): string[] {
  return execFileSync("sh", ["-c", `for a in ${words}; do printf '%s\\n' "$a"; done`], {
    encoding: "utf-8",
  })
    .split("\n")
    .slice(0, -1);
}

describe("shellQuote", () => {
  it("leaves plain words alone", () => {
    expect(shellQuote("demo")).toBe("demo");
    expect(shellQuote("my-app_2")).toBe("my-app_2");
    expect(shellQuote("./dist")).toBe("./dist");
  });

  it.each(["my app", "it's", "a;rm -rf x", "$HOME", "`x`", "", "<dir>", "a*b"])(
    "keeps %j one argument through a real shell",
    (word) => {
      expect(shellSplit(shellQuote(word))).toEqual([word]);
    },
  );
});
