import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { ParsedRepoUrl } from "./repo-url.js";

export interface CloneOptions {
  subpath?: string | null;
  timeoutMs?: number;    // default: 60_000 (60s)
  maxSizeMb?: number;    // default: 500
}

export interface CloneResult {
  tmpDir: string;       // root of cloned repo (for cleanup)
  workDir: string;      // tmpDir or tmpDir/subpath (for resolveConfig)
  sizeMb: number;
}

/**
 * Check if git CLI is available. Throws with install instructions if not.
 */
export function checkGitInstalled(): void {
  try {
    execFileSync("git", ["--version"], { stdio: "pipe" });
  } catch {
    throw new GitCloneError(
      "Git is not installed.\n" +
      "  Install it from: https://git-scm.com/downloads\n" +
      "  Or deploy a local directory: creek deploy ./my-project",
    );
  }
}

/**
 * Clone a repository with full security hardening.
 *
 * Security measures:
 * - --depth 1 (shallow, limits disk usage)
 * - --single-branch (don't fetch other branches)
 * - --no-recurse-submodules (prevent submodule attacks)
 * - core.hooksPath=/dev/null (disable git hooks)
 * - protocol.ext.allow=never (block ext:: protocol handler)
 * - protocol.file.allow=never (block file:// protocol)
 * - GIT_TERMINAL_PROMPT=0 (disable interactive auth)
 * - .git directory deleted immediately after clone
 * - Post-clone size check
 */
export function cloneRepo(parsed: ParsedRepoUrl, options: CloneOptions = {}): CloneResult {
  const { subpath, timeoutMs = 60_000, maxSizeMb = 500 } = options;

  const tmpDir = mkdtempSync(join(tmpdir(), "creek-repo-"));

  try {
    const args = [
      "clone",
      "--depth", "1",
      "--single-branch",
      ...(parsed.branch ? ["--branch", parsed.branch] : []),
      "--no-recurse-submodules",
      "--config", "core.hooksPath=/dev/null",
      "--config", "protocol.ext.allow=never",
      "--config", "protocol.file.allow=never",
      parsed.cloneUrl,
      tmpDir,
    ];

    execFileSync("git", args, {
      stdio: "pipe",
      timeout: timeoutMs,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "/bin/echo",
      },
    });
  } catch (err) {
    // Parse git error for helpful messages
    const stderr = err instanceof Error && "stderr" in err
      ? String((err as any).stderr)
      : "";

    cleanupDir(tmpDir);

    if (stderr.includes("Repository not found") || stderr.includes("not found")) {
      throw new GitCloneError(`Repository not found: ${parsed.displayUrl}`);
    }
    if (stderr.includes("Authentication failed") || stderr.includes("could not read Username")) {
      throw new GitCloneError(
        `This appears to be a private repository: ${parsed.displayUrl}\n` +
        "  Creek currently supports public repos only.\n" +
        "  To deploy a private repo, clone it locally first:\n" +
        `    git clone ${parsed.cloneUrl} && cd ${parsed.repo} && creek deploy`,
      );
    }
    if (stderr.includes("empty repository") || stderr.includes("warning: You appear to have cloned an empty repository")) {
      throw new GitCloneError(`Repository is empty: ${parsed.displayUrl}`);
    }
    if (err instanceof Error && "killed" in err && (err as any).killed) {
      throw new GitCloneError(
        `Clone timed out after ${Math.round(timeoutMs / 1000)}s: ${parsed.displayUrl}\n` +
        "  The repository may be too large for direct deploy.\n" +
        "  Try cloning locally: git clone --depth 1 " + parsed.cloneUrl,
      );
    }
    if (stderr.includes("Remote branch") && stderr.includes("not found")) {
      throw new GitCloneError(`Branch '${parsed.branch}' not found in ${parsed.displayUrl}`);
    }

    throw new GitCloneError(`Failed to clone ${parsed.displayUrl}: ${stderr || (err instanceof Error ? err.message : String(err))}`);
  }

  // Immediately remove .git directory (prevent hook attacks, save disk)
  rmSync(join(tmpDir, ".git"), { recursive: true, force: true });

  // Also remove .gitmodules if present (prevent submodule tricks)
  const gitmodulesPath = join(tmpDir, ".gitmodules");
  if (existsSync(gitmodulesPath)) {
    rmSync(gitmodulesPath, { force: true });
  }

  // Check repo size
  const sizeMb = getDirSizeMb(tmpDir);
  if (sizeMb > maxSizeMb) {
    cleanupDir(tmpDir);
    throw new GitCloneError(
      `Repository is too large (${Math.round(sizeMb)}MB, limit is ${maxSizeMb}MB).\n` +
      "  Clone locally and use creek deploy from the directory instead.",
    );
  }

  // Resolve subpath if specified
  let workDir = tmpDir;
  if (subpath) {
    workDir = resolve(tmpDir, subpath);
    // Belt-and-suspenders: verify resolved path is within tmpDir
    if (!resolve(workDir).startsWith(resolve(tmpDir))) {
      cleanupDir(tmpDir);
      throw new GitCloneError("Subpath resolved outside the repository (path traversal blocked)");
    }
    if (!existsSync(workDir)) {
      cleanupDir(tmpDir);
      throw new GitCloneError(
        `Subdirectory '${subpath}' not found in ${parsed.displayUrl}.\n` +
        `  Available directories: ${listTopDirs(tmpDir).join(", ") || "(none)"}`,
      );
    }
  }

  return { tmpDir, workDir, sizeMb };
}

// --- Package manager detection ---

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/**
 * Detect package manager from lock file.
 */
export function detectPackageManager(cwd: string): PackageManager {
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock"))) return "bun";
  return "npm";
}

/**
 * Install dependencies using the detected package manager.
 */
export function installDependencies(cwd: string, pm: PackageManager): void {
  const commands: Record<PackageManager, string[]> = {
    npm: ["npm", "install", "--no-audit", "--no-fund"],
    pnpm: ["pnpm", "install"],
    yarn: ["yarn", "install"],
    bun: ["bun", "install"],
  };

  const [cmd, ...args] = commands[pm];
  try {
    execFileSync(cmd, args, {
      cwd,
      stdio: "pipe",
      timeout: 120_000,
    });
  } catch (err) {
    const stderr = err instanceof Error && "stderr" in err
      ? String((err as any).stderr).slice(0, 500)
      : "";
    throw new GitCloneError(
      `Failed to install dependencies with ${pm}.\n` +
      (stderr ? `  ${stderr}\n` : "") +
      `  Try: cd ${cwd} && ${cmd} ${args.join(" ")}`,
    );
  }
}

// --- Helpers ---

function getDirSizeMb(dir: string): number {
  try {
    const output = execFileSync("du", ["-sk", dir], { stdio: "pipe" }).toString();
    const kb = parseInt(output.split("\t")[0], 10);
    return kb / 1024;
  } catch {
    return 0; // Can't determine size, allow it
  }
}

function listTopDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name)
      .slice(0, 10);
  } catch {
    return [];
  }
}

export function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort
  }
}

// --- Error ---

export class GitCloneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitCloneError";
  }
}
