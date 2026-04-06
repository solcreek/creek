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
): Promise<void> {
  const message = body.type === "template"
    ? { buildId, repoUrl: "https://github.com/solcreek/templates", path: body.template, templateData: body.data }
    : { buildId, repoUrl: normalizeRepoUrl(body.repo!), branch: body.branch, path: body.path };

  await env.WEB_BUILDS.send(message);
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
