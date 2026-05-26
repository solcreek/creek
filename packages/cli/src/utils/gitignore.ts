import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const ENTRIES = [
  ".creek",
  ".agent",
  ".agents",
  ".augment",
  ".claude",
  ".cline",
  ".cursor",
  ".github/copilot*",
  ".kilocode",
  ".kiro",
  ".qoder",
  ".qwen",
  ".roo",
  ".trae",
  ".windsurf",
];

export function ensureGitignoreEntries(dir: string): void {
  const gitignorePath = join(dir, ".gitignore");
  const existing = existsSync(gitignorePath)
    ? readFileSync(gitignorePath, "utf-8")
    : "";
  const lines = new Set(existing.split("\n").map((l) => l.trim()));

  const missing = ENTRIES.filter((entry) => !lines.has(entry));
  if (!missing.length) return;

  const block = `\n# Creek & AI agent configs\n${missing.join("\n")}\n`;
  appendFileSync(gitignorePath, block);
}
