import { it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureGitignoreEntries } from "./gitignore.js";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "creek-gitignore-"));
}

function ignoredLines(content: string): string[] {
  return content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

it("creates .gitignore when none exists and returns what it added", () => {
  const dir = makeTmp();
  try {
    const added = ensureGitignoreEntries(dir);
    const content = readFileSync(join(dir, ".gitignore"), "utf-8");
    expect(ignoredLines(content)).toEqual([".creek", ".claude/settings.local.json"]);
    // Disclosure: the return value lists every entry written so init can
    // surface the .gitignore mutation instead of editing it silently.
    expect(added).toEqual([".creek", ".claude/settings.local.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("never ignores team-shared agent configuration directories", () => {
  const dir = makeTmp();
  try {
    ensureGitignoreEntries(dir);
    const lines = ignoredLines(readFileSync(join(dir, ".gitignore"), "utf-8"));
    for (const shared of [
      ".claude",
      ".cursor",
      ".github/copilot*",
      ".windsurf",
      ".agents",
      ".agent",
      ".cline",
      ".roo",
      ".kiro",
    ]) {
      expect(lines).not.toContain(shared);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("appends missing entries to existing .gitignore and returns only the new ones", () => {
  const dir = makeTmp();
  try {
    writeFileSync(join(dir, ".gitignore"), "node_modules\n.env\n.creek\n");
    const added = ensureGitignoreEntries(dir);
    const content = readFileSync(join(dir, ".gitignore"), "utf-8");
    expect(content).toContain("node_modules");
    const creekCount = content.split("\n").filter((l) => l.trim() === ".creek").length;
    expect(creekCount).toBe(1);
    // .creek was already present → not reported as added.
    expect(added).toEqual([".claude/settings.local.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("is a no-op when all entries already present and returns []", () => {
  const dir = makeTmp();
  try {
    ensureGitignoreEntries(dir);
    const first = readFileSync(join(dir, ".gitignore"), "utf-8");
    const added = ensureGitignoreEntries(dir);
    const second = readFileSync(join(dir, ".gitignore"), "utf-8");
    expect(second).toBe(first);
    expect(added).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
