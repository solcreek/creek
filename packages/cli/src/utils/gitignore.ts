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

/**
 * Append Creek + AI-agent ignore entries to .gitignore (creating it if
 * absent), skipping any already present.
 *
 * Returns the entries it actually appended so callers can disclose the
 * mutation — `creek init` writes this to its human output and --json
 * payload rather than silently editing the user's .gitignore. Returns
 * `[]` when nothing changed (file already had every entry).
 */
export function ensureGitignoreEntries(dir: string): string[] {
  const gitignorePath = join(dir, ".gitignore");
  const existing = existsSync(gitignorePath)
    ? readFileSync(gitignorePath, "utf-8")
    : "";
  const lines = new Set(existing.split("\n").map((l) => l.trim()));

  const missing = ENTRIES.filter((entry) => !lines.has(entry));
  if (!missing.length) return [];

  const block = `\n# Creek & AI agent configs\n${missing.join("\n")}\n`;
  appendFileSync(gitignorePath, block);
  return missing;
}
