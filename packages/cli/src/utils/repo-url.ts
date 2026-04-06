/**
 * Git repository URL parsing and security validation.
 *
 * Security model:
 * - HTTPS only (no git://, ssh://, file://, ext::)
 * - Hostname allowlist (github.com, gitlab.com, bitbucket.org only)
 * - Owner/repo validated against strict character set
 * - No embedded credentials
 * - Subpath validated against traversal attacks
 */

export interface ParsedRepoUrl {
  provider: "github" | "gitlab" | "bitbucket";
  owner: string;
  repo: string;
  branch: string | null;
  cloneUrl: string;
  displayUrl: string;
}

// --- Allowed hostnames (SSRF prevention) ---

const PROVIDER_HOSTS: Record<string, ParsedRepoUrl["provider"]> = {
  "github.com": "github",
  "www.github.com": "github",
  "gitlab.com": "gitlab",
  "www.gitlab.com": "gitlab",
  "bitbucket.org": "bitbucket",
  "www.bitbucket.org": "bitbucket",
};

const SHORTHAND_PREFIXES: Record<string, ParsedRepoUrl["provider"]> = {
  "github:": "github",
  "gitlab:": "gitlab",
  "bitbucket:": "bitbucket",
};

// Strict character set for owner and repo names
const SAFE_NAME = /^[a-zA-Z0-9._-]+$/;

// --- Public API ---

/**
 * Quick check: does this string look like a repo URL or shorthand?
 * Used to route between directory deploy and repo deploy.
 */
export function isRepoUrl(input: string): boolean {
  if (!input) return false;
  // Shorthand: github:user/repo
  for (const prefix of Object.keys(SHORTHAND_PREFIXES)) {
    if (input.startsWith(prefix)) return true;
  }
  // HTTPS URL to known host
  try {
    const url = new URL(input.split("#")[0]);
    return url.protocol === "https:" && url.hostname in PROVIDER_HOSTS;
  } catch {
    return false;
  }
}

/**
 * Parse a repo URL or shorthand into structured components.
 * Supports:
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo.git
 *   https://github.com/owner/repo#branch
 *   https://github.com/owner/repo/tree/branch
 *   github:owner/repo
 *   github:owner/repo#branch
 */
export function parseRepoUrl(input: string): ParsedRepoUrl {
  if (!input || typeof input !== "string") {
    throw new RepoUrlError("Empty or invalid input");
  }

  // Shorthand: github:owner/repo#branch
  for (const [prefix, provider] of Object.entries(SHORTHAND_PREFIXES)) {
    if (input.startsWith(prefix)) {
      return parseShorthand(input.slice(prefix.length), provider);
    }
  }

  // Full URL
  return parseFullUrl(input);
}

/**
 * Validate a parsed repo URL for security.
 * Throws RepoUrlError on any violation.
 */
export function validateRepoUrl(parsed: ParsedRepoUrl): void {
  // Protocol: only HTTPS (enforced during parsing, but belt-and-suspenders)
  if (!parsed.cloneUrl.startsWith("https://")) {
    throw new RepoUrlError("Only HTTPS URLs are allowed");
  }

  // Owner and repo name: strict character set
  if (!SAFE_NAME.test(parsed.owner)) {
    throw new RepoUrlError(`Invalid owner name: ${JSON.stringify(parsed.owner)}`);
  }
  if (!SAFE_NAME.test(parsed.repo)) {
    throw new RepoUrlError(`Invalid repo name: ${JSON.stringify(parsed.repo)}`);
  }

  // Branch: strict character set (if present)
  if (parsed.branch !== null && !/^[a-zA-Z0-9._\/-]+$/.test(parsed.branch)) {
    throw new RepoUrlError(`Invalid branch name: ${JSON.stringify(parsed.branch)}`);
  }

  // No null bytes anywhere
  const allParts = [parsed.owner, parsed.repo, parsed.branch, parsed.cloneUrl].filter(Boolean);
  for (const part of allParts) {
    if (part!.includes("\0")) {
      throw new RepoUrlError("Null bytes are not allowed");
    }
  }
}

/**
 * Validate a --path subdirectory argument.
 * Prevents path traversal and other filesystem attacks.
 */
export function validateSubpath(path: string): void {
  if (!path || !path.trim()) {
    throw new RepoUrlError("Subpath cannot be empty");
  }

  // No absolute paths
  if (path.startsWith("/") || path.startsWith("\\")) {
    throw new RepoUrlError("Subpath must be relative, not absolute");
  }

  // No path traversal
  const segments = path.split(/[/\\]/);
  if (segments.some((s) => s === "..")) {
    throw new RepoUrlError("Path traversal (..) is not allowed in subpath");
  }

  // No null bytes
  if (path.includes("\0")) {
    throw new RepoUrlError("Null bytes are not allowed in subpath");
  }

  // Only safe characters
  if (!/^[a-zA-Z0-9._\/-]+$/.test(path)) {
    throw new RepoUrlError("Subpath contains invalid characters");
  }
}

// --- Internal parsers ---

function parseShorthand(rest: string, provider: ParsedRepoUrl["provider"]): ParsedRepoUrl {
  // Split on # for branch
  const [pathPart, ...branchParts] = rest.split("#");
  const branch = branchParts.length > 0 ? branchParts.join("#") : null;

  const segments = pathPart.replace(/\.git$/, "").split("/").filter(Boolean);
  if (segments.length !== 2) {
    throw new RepoUrlError(`Expected owner/repo format, got: ${pathPart}`);
  }

  const [owner, repo] = segments;
  const host = provider === "github" ? "github.com" : provider === "gitlab" ? "gitlab.com" : "bitbucket.org";

  return {
    provider,
    owner,
    repo,
    branch: branch || null,
    cloneUrl: `https://${host}/${owner}/${repo}.git`,
    displayUrl: `${owner}/${repo}${branch ? `#${branch}` : ""}`,
  };
}

function parseFullUrl(input: string): ParsedRepoUrl {
  // Extract branch from fragment before parsing URL
  const [urlPart, ...fragmentParts] = input.split("#");
  const fragment = fragmentParts.length > 0 ? fragmentParts.join("#") : null;

  let url: URL;
  try {
    // Strip query params and trailing slash
    const cleanUrl = urlPart.split("?")[0].replace(/\/$/, "");
    url = new URL(cleanUrl);
  } catch {
    throw new RepoUrlError(`Invalid URL: ${input}`);
  }

  // Protocol check
  if (url.protocol !== "https:") {
    throw new RepoUrlError(`Only HTTPS URLs are allowed. Got: ${url.protocol}`);
  }

  // Hostname allowlist (SSRF prevention)
  const hostname = url.hostname.toLowerCase();
  const provider = PROVIDER_HOSTS[hostname];
  if (!provider) {
    throw new RepoUrlError(
      `Unsupported host: ${hostname}. Supported: github.com, gitlab.com, bitbucket.org`,
    );
  }

  // No embedded credentials
  if (url.username || url.password) {
    throw new RepoUrlError("URLs with embedded credentials are not allowed");
  }

  // Parse path segments: /owner/repo[/tree/branch][.git]
  const pathSegments = url.pathname.split("/").filter(Boolean);

  if (pathSegments.length < 2) {
    throw new RepoUrlError(`Expected /{owner}/{repo} in URL path, got: ${url.pathname}`);
  }

  const owner = pathSegments[0];
  const repo = pathSegments[1].replace(/\.git$/, "");

  // Extract branch from /tree/branch path (GitHub convention)
  let branch = fragment;
  if (pathSegments.length >= 4 && pathSegments[2] === "tree") {
    branch = pathSegments.slice(3).join("/");
  }

  return {
    provider,
    owner,
    repo,
    branch: branch || null,
    cloneUrl: `https://${hostname}/${owner}/${repo}.git`,
    displayUrl: `${owner}/${repo}${branch ? `#${branch}` : ""}`,
  };
}

// --- Error ---

export class RepoUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoUrlError";
  }
}
