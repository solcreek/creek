import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What `creek init` keeps out of git: only machine-local state.
 *
 * - `.creek` — Creek's local dev state (`.creek/dev/` holds the local
 *   database and storage), never meant to be committed.
 * - `.claude/settings.local.json` — Claude Code's per-user settings
 *   (personal permission allowlists); the shared `.claude/settings.json`,
 *   skills and commands next to it stay committable.
 *
 * Agent configuration directories (`.claude`, `.cursor`, `.github/copilot*`,
 * `.windsurf`, …) are deliberately NOT ignored: they hold team-shared rules,
 * skills and instructions, and hiding them by default works against an
 * agent-first workflow.
 */
const ENTRIES = [".creek", ".claude/settings.local.json"];

/**
 * Append Creek's local-state ignore entries to .gitignore (creating it if
 * absent), skipping any already present.
 *
 * Returns the entries it actually appended so callers can disclose the
 * mutation — `creek init` writes this to its human output and --json
 * payload rather than silently editing the user's .gitignore. Returns
 * `[]` when nothing changed (file already had every entry).
 */
export function ensureGitignoreEntries(dir: string): string[] {
  const gitignorePath = join(dir, ".gitignore");
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf-8") : "";
  const lines = new Set(existing.split("\n").map((l) => l.trim()));

  const missing = ENTRIES.filter((entry) => !lines.has(entry));
  if (!missing.length) return [];

  const block = `\n# Creek local state\n${missing.join("\n")}\n`;
  appendFileSync(gitignorePath, block);
  return missing;
}
