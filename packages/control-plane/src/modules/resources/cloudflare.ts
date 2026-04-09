import type { Env } from "../../types.js";

// --- Internal CF API helper ---

async function cfApi(
  env: Env,
  method: string,
  path: string,
  body?: unknown,
): Promise<any> {
  const url = `https://api.cloudflare.com/client/v4${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
  };

  const init: RequestInit = { method, headers };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  const res = await fetch(url, init);
  const json = (await res.json()) as any;

  if (!json.success && json.errors?.length) {
    throw new Error(`CF API error: ${JSON.stringify(json.errors)}`);
  }

  return json.result;
}

// --- Custom Hostnames (CF for SaaS) ---

export interface CustomHostnameResult {
  id: string;
  hostname: string;
  status: string;
  ownership_verification: {
    type: string;
    name: string;
    value: string;
  } | null;
  ownership_verification_http: {
    http_url: string;
    http_body: string;
  } | null;
  ssl: {
    status: string;
    method: string;
    type: string;
    validation_records: unknown[] | null;
  };
}

export async function createCustomHostname(
  env: Env,
  hostname: string,
): Promise<CustomHostnameResult> {
  return cfApi(
    env,
    "POST",
    `/zones/${env.CLOUDFLARE_ZONE_ID}/custom_hostnames`,
    {
      hostname,
      ssl: { method: "http", type: "dv" },
    },
  );
}

export async function getCustomHostname(
  env: Env,
  customHostnameId: string,
): Promise<CustomHostnameResult> {
  return cfApi(
    env,
    "GET",
    `/zones/${env.CLOUDFLARE_ZONE_ID}/custom_hostnames/${customHostnameId}`,
  );
}

export async function deleteCustomHostname(
  env: Env,
  customHostnameId: string,
): Promise<void> {
  await cfApi(
    env,
    "DELETE",
    `/zones/${env.CLOUDFLARE_ZONE_ID}/custom_hostnames/${customHostnameId}`,
  );
}

// --- D1 ---

export async function createD1Database(
  env: Env,
  name: string,
): Promise<string> {
  const result = await cfApi(env, "POST", `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database`, {
    name,
  });
  return result.uuid;
}

export async function getD1Database(
  env: Env,
  name: string,
): Promise<string | null> {
  try {
    const result = await cfApi(
      env,
      "GET",
      `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database?name=${encodeURIComponent(name)}`,
    );
    const dbs = Array.isArray(result) ? result : [];
    const match = dbs.find((db: any) => db.name === name);
    return match?.uuid ?? null;
  } catch {
    return null;
  }
}

export async function deleteD1Database(env: Env, databaseId: string): Promise<void> {
  await cfApi(env, "DELETE", `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${databaseId}`);
}

// --- R2 ---

export async function createR2Bucket(env: Env, name: string): Promise<void> {
  // R2 create bucket uses S3-compatible API via CF REST
  await cfApi(env, "POST", `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/r2/buckets`, {
    name,
    locationHint: "apac",
  });
}

export async function getR2Bucket(env: Env, name: string): Promise<boolean> {
  try {
    await cfApi(env, "GET", `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${name}`);
    return true;
  } catch {
    return false;
  }
}

export async function deleteR2Bucket(env: Env, name: string): Promise<void> {
  await cfApi(env, "DELETE", `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${name}`);
}

// --- KV ---

export async function createKVNamespace(env: Env, name: string): Promise<string> {
  const result = await cfApi(
    env,
    "POST",
    `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces`,
    { title: name },
  );
  return result.id;
}

export async function getKVNamespace(
  env: Env,
  name: string,
): Promise<string | null> {
  try {
    const result = await cfApi(
      env,
      "GET",
      `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces?per_page=100`,
    );
    const namespaces = Array.isArray(result) ? result : [];
    const match = namespaces.find((ns: any) => ns.title === name);
    return match?.id ?? null;
  } catch {
    return null;
  }
}

export async function deleteKVNamespace(env: Env, namespaceId: string): Promise<void> {
  await cfApi(
    env,
    "DELETE",
    `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${namespaceId}`,
  );
}

// --- Queues ---

export async function createQueue(env: Env, name: string): Promise<string> {
  const result = await cfApi(
    env,
    "POST",
    `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/queues`,
    { queue_name: name },
  );
  return result.queue_id;
}

export async function getQueue(env: Env, name: string): Promise<string | null> {
  try {
    const result = await cfApi(
      env,
      "GET",
      `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/queues?name=${encodeURIComponent(name)}`,
    );
    const queues = Array.isArray(result) ? result : [];
    const match = queues.find((q: any) => q.queue_name === name);
    return match?.queue_id ?? null;
  } catch {
    return null;
  }
}

export async function deleteQueue(env: Env, queueId: string): Promise<void> {
  await cfApi(
    env,
    "DELETE",
    `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/queues/${queueId}`,
  );
}

/**
 * Register a WfP dispatch namespace script as a queue consumer.
 */
export async function setQueueConsumer(
  env: Env,
  queueId: string,
  scriptName: string,
): Promise<void> {
  await cfApi(
    env,
    "POST",
    `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/queues/${queueId}/consumers`,
    {
      type: "worker",
      script_name: scriptName,
      settings: {
        batch_size: 10,
        max_retries: 3,
        max_wait_time_ms: 5000,
      },
    },
  );
}
