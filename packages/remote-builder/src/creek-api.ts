/**
 * Creek API client for remote builder — creates projects, deployments, uploads bundles.
 * Uses the same API endpoints as the CLI (POST /deployments, PUT /bundle, GET status).
 */

export interface DeployResult {
  success: true;
  url: string | null;
  previewUrl: string;
  deploymentId: string;
  projectSlug: string;
}

export interface DeployError {
  success: false;
  status: string;
  failedStep?: string;
  errorMessage?: string;
}

export async function deployToCreek(
  apiUrl: string,
  token: string,
  slug: string,
  framework: string | undefined,
  bundle: Record<string, unknown>,
): Promise<DeployResult | DeployError> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": token,
  };

  // 1. Get or create project
  let projectId: string;
  const getRes = await fetch(`${apiUrl}/projects/${slug}`, { headers });
  if (getRes.ok) {
    const project = await getRes.json() as any;
    projectId = project.id;
  } else {
    const createRes = await fetch(`${apiUrl}/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({ slug, framework }),
    });
    if (!createRes.ok) {
      const err = await createRes.json().catch(() => ({})) as any;
      throw new Error(`Failed to create project: ${err.message || createRes.statusText}`);
    }
    const created = await createRes.json() as any;
    projectId = created.project?.id || created.id;
  }

  // 2. Create deployment
  const deployRes = await fetch(`${apiUrl}/projects/${projectId}/deployments`, {
    method: "POST",
    headers,
    body: JSON.stringify({ triggerType: "remote" }),
  });
  if (!deployRes.ok) {
    throw new Error(`Failed to create deployment: ${deployRes.statusText}`);
  }
  const { deployment } = await deployRes.json() as any;

  // 3. Upload bundle
  const uploadRes = await fetch(`${apiUrl}/projects/${projectId}/deployments/${deployment.id}/bundle`, {
    method: "PUT",
    headers,
    body: JSON.stringify(bundle),
  });
  if (!uploadRes.ok && uploadRes.status !== 202) {
    const err = await uploadRes.json().catch(() => ({})) as any;
    throw new Error(`Failed to upload bundle: ${err.message || uploadRes.statusText}`);
  }

  // 4. Poll for status
  const POLL_TIMEOUT = 120_000;
  const POLL_INTERVAL = 2_000;
  const start = Date.now();

  while (Date.now() - start < POLL_TIMEOUT) {
    const statusRes = await fetch(`${apiUrl}/projects/${projectId}/deployments/${deployment.id}`, { headers });
    if (!statusRes.ok) break;

    const data = await statusRes.json() as any;
    const status = data.deployment?.status;

    if (status === "active") {
      return {
        success: true,
        url: data.url,
        previewUrl: data.previewUrl,
        deploymentId: deployment.id,
        projectSlug: slug,
      };
    }

    if (status === "failed") {
      return {
        success: false,
        status: "failed",
        failedStep: data.deployment?.failedStep,
        errorMessage: data.deployment?.errorMessage,
      };
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }

  return {
    success: false,
    status: "timeout",
    errorMessage: "Deployment did not complete within 2 minutes",
  };
}
