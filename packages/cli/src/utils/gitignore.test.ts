import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureGitignoreEntries } from "./gitignore.js";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "creek-gitignore-"));
}

afterEach(() => {});

it("creates .gitignore when none exists and returns what it added", () => {
  const dir = makeTmp();
  try {
    const added = ensureGitignoreEntries(dir);
    const content = readFileSync(join(dir, ".gitignore"), "utf-8");
    expect(content).toContain(".creek");
    expect(content).toContain(".claude");
    expect(content).toContain(".windsurf");
    expect(content).toContain(".cursor");
    expect(content).toContain("# Creek & AI agent configs");
    // Disclosure: the return value lists every entry written so init can
    // surface the .gitignore mutation instead of editing it silently.
    expect(added).toContain(".creek");
    expect(added).toContain(".claude");
    expect(added.length).toBeGreaterThan(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("appends missing entries to existing .gitignore and returns only the new ones", () => {
  const dir = makeTmp();
  try {
    writeFileSync(join(dir, ".gitignore"), "node_modules\n.env\n.claude\n");
    const added = ensureGitignoreEntries(dir);
    const content = readFileSync(join(dir, ".gitignore"), "utf-8");
    expect(content).toContain("node_modules");
    expect(content).toContain(".creek");
    expect(content).toContain(".windsurf");
    const claudeCount = content.split("\n").filter((l) => l.trim() === ".claude").length;
    expect(claudeCount).toBe(1);
    // .claude was already present → not reported as added; .creek is new.
    expect(added).not.toContain(".claude");
    expect(added).toContain(".creek");
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
