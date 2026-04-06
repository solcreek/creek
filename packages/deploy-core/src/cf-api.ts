import type { DeployEnv } from "./types.js";

/**
 * Cloudflare API helper for WfP operations.
 */
export async function cfApi(
  env: DeployEnv,
  method: string,
  path: string,
  body?: unknown,
  authToken?: string,
): Promise<any> {
  const url = `https://api.cloudflare.com/client/v4${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${authToken ?? env.CLOUDFLARE_API_TOKEN}`,
  };

  const init: RequestInit = { method, headers };

  if (body !== undefined) {
    if (body instanceof FormData) {
      init.body = body;
    } else {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
  }

  const res = await fetch(url, init);
  const json = (await res.json()) as any;

  if (!json.success && json.errors?.length) {
    throw new Error(`CF API error: ${JSON.stringify(json.errors)}`);
  }

  return json.result;
}
