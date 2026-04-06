/**
 * GitHub API client for Creek's GitHub App integration.
 *
 * Handles: JWT creation (RS256), installation token exchange, repo operations,
 * commit statuses, and PR comments.
 */

import type { Env } from "../../types.js";

const GITHUB_API = "https://api.github.com";

// --- JWT Creation (RS256) ---

/**
 * Create a GitHub App JWT for authenticating as the App.
 * Signed with RS256 using the App's private key (PKCS#8 PEM format).
 *
 * Note: GitHub App private keys are often PKCS#1 format. Convert with:
 *   openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in key.pem -out key-pkcs8.pem
 */
export async function createAppJWT(appId: string, privateKeyPem: string): Promise<string> {
  // Strip PEM headers/footers and whitespace
  const pemBody = privateKeyPem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/-----BEGIN RSA PRIVATE KEY-----/, "")
    .replace(/-----END RSA PRIVATE KEY-----/, "")
    .replace(/\s/g, "");

  const keyData = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({
    iss: appId,
    iat: now - 60,  // 60s clock skew tolerance
    exp: now + 600, // 10 min max
  }));

  const data = new TextEncoder().encode(`${header}.${payload}`);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, data);
  const sigB64 = base64url(sig);

  return `${header}.${payload}.${sigB64}`;
}

// --- Installation Token Exchange ---

// Cache: installationId → { token, expiresAt }
const tokenCache = new Map<number, { token: string; expiresAt: number }>();

/**
 * Exchange a GitHub App JWT for an installation access token.
 * Tokens are cached for 50 minutes (they expire after 1 hour).
 */
export async function exchangeInstallationToken(
  env: Env,
  installationId: number,
): Promise<string> {
  // Check cache
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  const jwt = await createAppJWT(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);

  const res = await fetch(
    `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "Creek-Deploy",
      },
    },
  );

  if (!res.ok) {
    throw new Error(`Failed to exchange installation token: ${res.status} ${await res.text()}`);
  }

  const { token } = await res.json() as { token: string };

  // Cache for 50 minutes (tokens expire after 1 hour)
  tokenCache.set(installationId, {
    token,
    expiresAt: Date.now() + 50 * 60 * 1000,
  });

  return token;
}

/** Clear token cache (for testing) */
export function clearTokenCache(): void {
  tokenCache.clear();
}

// --- Repo Operations ---

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  language: string | null;
  pushed_at: string | null;
}

/**
 * List repositories accessible to an installation.
 */
export async function listInstallationRepos(token: string): Promise<GitHubRepo[]> {
  const repos: GitHubRepo[] = [];
  let page = 1;

  while (page <= 10) { // Safety limit
    const res = await githubFetch(token, `/installation/repositories?per_page=100&page=${page}`);
    const data = await res.json() as { repositories: GitHubRepo[]; total_count: number };
    repos.push(...data.repositories);
    if (repos.length >= data.total_count || data.repositories.length < 100) break;
    page++;
  }

  return repos;
}

/**
 * Get file content from a repo. Returns null if file doesn't exist (404).
 */
export async function getRepoContents(
  token: string,
  owner: string,
  repo: string,
  path: string,
): Promise<string | null> {
  const res = await githubFetch(token, `/repos/${owner}/${repo}/contents/${path}`);

  if (res.status === 404) return null;
  if (!res.ok) return null;

  const data = await res.json() as { content?: string; encoding?: string };
  if (data.encoding === "base64" && data.content) {
    return atob(data.content.replace(/\n/g, ""));
  }
  return null;
}

// --- Commit Status ---

export type CommitStatusState = "pending" | "success" | "failure" | "error";

export async function createCommitStatus(
  token: string,
  owner: string,
  repo: string,
  sha: string,
  state: CommitStatusState,
  options: {
    targetUrl?: string;
    description?: string;
    context?: string;
  } = {},
): Promise<void> {
  await githubFetch(token, `/repos/${owner}/${repo}/statuses/${sha}`, {
    method: "POST",
    body: JSON.stringify({
      state,
      target_url: options.targetUrl,
      description: options.description?.slice(0, 140),
      context: options.context ?? "Creek",
    }),
  });
}

// --- PR Comments ---

/**
 * Create a comment on a PR. If a Creek comment already exists, update it.
 */
export async function createOrUpdatePRComment(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
): Promise<void> {
  // Check for existing Creek comment
  const commentsRes = await githubFetch(token, `/repos/${owner}/${repo}/issues/${prNumber}/comments`);
  if (commentsRes.ok) {
    const comments = await commentsRes.json() as Array<{ id: number; body: string; user: { login: string } }>;
    const existing = comments.find((c) =>
      c.body.includes("<!-- creek-preview -->"),
    );

    if (existing) {
      // Update existing comment
      await githubFetch(token, `/repos/${owner}/${repo}/issues/comments/${existing.id}`, {
        method: "PATCH",
        body: JSON.stringify({ body: `<!-- creek-preview -->\n${body}` }),
      });
      return;
    }
  }

  // Create new comment
  await githubFetch(token, `/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
    method: "POST",
    body: JSON.stringify({ body: `<!-- creek-preview -->\n${body}` }),
  });
}

/**
 * Format a PR comment for a preview deployment.
 */
export function formatPreviewComment(
  previewUrl: string,
  buildTimeMs: number,
  framework: string | null,
  assetCount: number,
  serverFileCount: number,
): string {
  const buildTime = Math.round(buildTimeMs / 1000);
  const parts = [framework, `${assetCount} assets`];
  if (serverFileCount > 0) parts.push(`${serverFileCount} server files`);

  return [
    `### Creek Preview`,
    "",
    `| Status | URL |`,
    `|--------|-----|`,
    `| Ready | [${previewUrl}](https://${previewUrl}) |`,
    "",
    `**Built in ${buildTime}s** · ${parts.join(" · ")}`,
    "",
    `<sub>Deployed by [Creek](https://creek.dev)</sub>`,
  ].join("\n");
}

// --- Helpers ---

async function githubFetch(token: string, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "Creek-Deploy",
      "Content-Type": "application/json",
      ...(init?.headers as Record<string, string> || {}),
    },
  });
}

function base64url(input: string | ArrayBuffer): string {
  const str = typeof input === "string"
    ? btoa(input)
    : btoa(String.fromCharCode(...new Uint8Array(input)));
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
