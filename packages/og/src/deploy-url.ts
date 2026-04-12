/**
 * Shared deploy URL parsing.
 *
 * Used by both `apps/www`'s `/deploy/[...slug]` server component and
 * the og-api worker's `/deploy/*` route, so a single source of truth
 * governs what is (and isn't) a valid deploy URL.
 *
 * ## URL shape
 *
 *   /deploy/{provider}/{owner}/{repo}
 *   /deploy/{provider}/{owner}/{repo}/tree/{branch}
 *   /deploy/{provider}/{owner}/{repo}/tree/{branch}/{subpath}
 *
 * Examples:
 *   /deploy/gh/satnaing/astro-paper
 *   /deploy/gh/withastro/docs
 *   /deploy/gh/vuejs/docs/tree/main
 *   /deploy/gh/vitejs/vite/tree/main/docs
 *
 * The format mirrors GitHub's `tree/{branch}/{path}` URL tail so users
 * can copy the portion of a GitHub URL after `github.com/` and paste
 * it onto `creek.dev/deploy/gh/`.
 *
 * ## Provider shortcodes
 *
 * Both short (`gh`, `gl`, `bb`) and long (`github`, `gitlab`,
 * `bitbucket`) forms are accepted and case-insensitive.
 *
 * ## Known limitations
 *
 * - Branch names containing `/` are NOT supported. Git allows slashes
 *   in branch names but GitHub URLs make them ambiguous with subpath
 *   segments (GitHub resolves the ambiguity by trying the longest
 *   branch match via its API). For deploy URLs, we require a
 *   single-segment branch name. If a repo only has slashed branches,
 *   use the generic `/new?repo=<url>` flow instead.
 * - Subpath depth is capped at 10 segments to bound abuse.
 */

export interface ProviderInfo {
  host: string;
  displayName: string;
}

export const PROVIDER_MAP: Record<string, ProviderInfo> = {
  gh: { host: "github.com", displayName: "GitHub" },
  github: { host: "github.com", displayName: "GitHub" },
  gl: { host: "gitlab.com", displayName: "GitLab" },
  gitlab: { host: "gitlab.com", displayName: "GitLab" },
  bb: { host: "bitbucket.org", displayName: "Bitbucket" },
  bitbucket: { host: "bitbucket.org", displayName: "Bitbucket" },
};

export interface ParsedDeploySlug {
  /** Resolved provider info (host + display name). */
  provider: ProviderInfo;
  /** The normalised provider shortcode the user supplied (e.g. "gh"). */
  providerKey: string;
  /** Repo owner (validated). */
  owner: string;
  /** Repo name (validated, with `.git` suffix stripped). */
  repo: string;
  /** Branch name if the slug contains a `/tree/{branch}` segment. */
  branch: string | null;
  /** Subpath within the repo, slash-joined; null if deploying from root. */
  subpath: string | null;
}

const SEGMENT_RE = /^[a-zA-Z0-9._-]+$/;
const ALL_DOTS_RE = /^\.+$/;
const MAX_SUBPATH_DEPTH = 10;

function isValidSegment(s: string | undefined | null): s is string {
  if (!s) return false;
  // Reject dot-only segments (".", "..", "...") to prevent path traversal
  // attempts and because no real GitHub owner/repo/branch/path segment is
  // just a run of dots.
  if (ALL_DOTS_RE.test(s)) return false;
  return SEGMENT_RE.test(s);
}

/**
 * Parse the path segments after `/deploy/` into a structured slug.
 *
 * Returns `null` for any malformed input — callers should fall back to
 * a generic brand card / error shell instead of surfacing the error.
 */
export function parseDeploySlug(
  slug: readonly string[] | null | undefined,
): ParsedDeploySlug | null {
  if (!slug || slug.length < 3) return null;

  const providerKey = slug[0]?.toLowerCase();
  const ownerRaw = slug[1];
  const repoRaw = slug[2];
  if (!providerKey || !ownerRaw || !repoRaw) return null;

  const provider = PROVIDER_MAP[providerKey];
  if (!provider) return null;

  const repo = repoRaw.replace(/\.git$/, "");
  if (!isValidSegment(ownerRaw) || !isValidSegment(repo)) return null;

  // Case 1: no tree/branch — plain repo root
  if (slug.length === 3) {
    return {
      provider,
      providerKey,
      owner: ownerRaw,
      repo,
      branch: null,
      subpath: null,
    };
  }

  // slug[3] must be the literal `tree` keyword
  if (slug[3] !== "tree") return null;

  // slug[4] is the branch — required when `tree` is present
  const branch = slug[4];
  if (!isValidSegment(branch)) return null;

  // Case 2: tree/branch with no subpath
  if (slug.length === 5) {
    return {
      provider,
      providerKey,
      owner: ownerRaw,
      repo,
      branch,
      subpath: null,
    };
  }

  // Case 3: tree/branch/subpath — validate every segment + cap depth
  const subpathSegments = slug.slice(5);
  if (subpathSegments.length > MAX_SUBPATH_DEPTH) return null;
  for (const seg of subpathSegments) {
    if (!isValidSegment(seg)) return null;
  }

  return {
    provider,
    providerKey,
    owner: ownerRaw,
    repo,
    branch,
    subpath: subpathSegments.join("/"),
  };
}

/**
 * Build the canonical deploy URL path (without domain) from a parsed slug.
 * Inverse of parseDeploySlug: round-trips any valid ParsedDeploySlug.
 */
export function buildDeployPath(parsed: ParsedDeploySlug): string {
  const base = `${parsed.providerKey}/${parsed.owner}/${parsed.repo}`;
  if (parsed.branch === null) return base;
  if (parsed.subpath === null) return `${base}/tree/${parsed.branch}`;
  return `${base}/tree/${parsed.branch}/${parsed.subpath}`;
}
