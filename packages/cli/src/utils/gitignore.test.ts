import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureGitignoreEntries } from "./gitignore.js";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "creek-gitignore-"));
}

afterEach(() => {});

it("creates .gitignore when none exists", () => {
  const dir = makeTmp();
  try {
    ensureGitignoreEntries(dir);
    const content = readFileSync(join(dir, ".gitignore"), "utf-8");
    expect(content).toContain(".creek");
    expect(content).toContain(".claude");
    expect(content).toContain(".windsurf");
    expect(content).toContain(".cursor");
    expect(content).toContain("# Creek & AI agent configs");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("appends missing entries to existing .gitignore", () => {
  const dir = makeTmp();
  try {
    writeFileSync(join(dir, ".gitignore"), "node_modules\n.env\n.claude\n");
    ensureGitignoreEntries(dir);
    const content = readFileSync(join(dir, ".gitignore"), "utf-8");
    expect(content).toContain("node_modules");
    expect(content).toContain(".creek");
    expect(content).toContain(".windsurf");
    const claudeCount = content.split("\n").filter((l) => l.trim() === ".claude").length;
    expect(claudeCount).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("is a no-op when all entries already present", () => {
  const dir = makeTmp();
  try {
    ensureGitignoreEntries(dir);
    const first = readFileSync(join(dir, ".gitignore"), "utf-8");
    ensureGitignoreEntries(dir);
    const second = readFileSync(join(dir, ".gitignore"), "utf-8");
    expect(second).toBe(first);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
