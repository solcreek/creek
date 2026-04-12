/**
 * Web-deploy: enqueue a build request to the creek-web-builds Queue.
 *
 * The Queue consumer (remote-builder) handles the full pipeline:
 * build → validate → sandbox deploy → KV status update.
 *
 * This function only enqueues — no waitUntil, no time limits.
 */

export interface DeployRequest {
  type: "template" | "repo";
  template?: string;
  data?: Record<string, string>;
  repo?: string;
  branch?: string;
  path?: string;
}

export interface WebDeployEnv {
  BUILD_STATUS: KVNamespace;
  WEB_BUILDS: Queue;
}

export async function buildAndDeploy(
  buildId: string,
  body: DeployRequest,
  env: WebDeployEnv,
  commitSha?: string | null,
): Promise<void> {
  const message = body.type === "template"
    ? { buildId, repoUrl: "https://github.com/solcreek/templates", path: body.template, templateData: body.data }
    : { buildId, repoUrl: normalizeRepoUrl(body.repo!), branch: body.branch, path: body.path, commitSha: commitSha ?? undefined };

  await env.WEB_BUILDS.send(message);
}

/**
 * Fetch the latest commit SHA for a GitHub repo ref.
 * Returns the short (12-char) SHA, or null on failure.
 * Uses CF edge cache with 60s TTL to bound GitHub API calls.
 */
export async function fetchCommitSha(
  repoUrl: string,
  branch: string,
): Promise<string | null> {
  try {
    const url = new URL(repoUrl);
    if (url.hostname !== "github.com") return null;
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length < 2) return null;
    const [owner, repo] = segments;
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo.replace(/\.git$/, "")}/git/refs/heads/${branch}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "creek-web-deploy",
        },
        cf: { cacheTtl: 60, cacheEverything: true },
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { object?: { sha?: string } };
    return data.object?.sha?.slice(0, 12) ?? null;
  } catch {
    return null;
  }
}

export async function updateStatus(
  env: Pick<WebDeployEnv, "BUILD_STATUS">,
  buildId: string,
  data: Record<string, unknown>,
) {
  await env.BUILD_STATUS.put(
    `build:${buildId}`,
    JSON.stringify({ buildId, ...data, updatedAt: new Date().toISOString() }),
    { expirationTtl: 3600 },
  );
}

function normalizeRepoUrl(repo: string): string {
  return repo.startsWith("http") ? repo : `https://github.com/${repo}`;
}

export function hashIp(ip: string): string {
  let hash = 0;
  for (let i = 0; i < ip.length; i++) {
    hash = ((hash << 5) - hash) + ip.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}
