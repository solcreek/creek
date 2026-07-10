import type { Env } from "../../types.js";

/**
 * Minimal server-side client for the creekd admin API (the Go daemon in
 * solcreek/creekd). Only the surface CreekdFleetTarget needs: spawn an app,
 * blue-green redeploy an existing one, and poll it healthy. Talks the real wire
 * format — SpawnRequest / DeployRequest / ErrorResponse — over bearer auth.
 *
 * Uses global fetch so MSW can intercept it in tests (see creekd-fleet.msw.test.ts).
 */

export interface CreekdConfig {
  adminUrl: string; // e.g. https://fleet-1.june.app:9080
  dispatchUrl?: string; // e.g. https://fleet-1.june.app:9000 (health polling)
  token?: string; // bearer
}

/** Mirror of creekd's SpawnRequest (only the fields we set). */
export interface SpawnRequest {
  id: string;
  command?: string;
  args?: string[];
  runtime?: "bun" | "node" | "deno";
  entry?: string;
  env?: string[]; // KEY=VALUE
  port: number;
  health_check_path?: string;
}

/** Mirror of creekd's DeployRequest (blue-green redeploy of an existing app). */
export type DeployRequest = Omit<SpawnRequest, "id">;

/** creekd's error envelope: { code, error }. */
interface CreekdError {
  code?: string;
  error?: string;
}

/**
 * Read + validate the creekd-fleet config from env. Throws a clear, actionable
 * error if the instance selected DEPLOY_TARGET=creekd-fleet but didn't configure
 * the daemon endpoint — the one hard requirement.
 */
export function creekdConfigFromEnv(env: Env): CreekdConfig {
  if (!env.CREEKD_ADMIN_URL) {
    throw new Error(
      "DEPLOY_TARGET=creekd-fleet requires CREEKD_ADMIN_URL (the creekd admin API base)",
    );
  }
  return {
    adminUrl: env.CREEKD_ADMIN_URL.replace(/\/$/, ""),
    dispatchUrl: env.CREEKD_DISPATCH_URL?.replace(/\/$/, ""),
    token: env.CREEKD_TOKEN,
  };
}

/**
 * creekd app ids must match `^[a-z0-9][a-z0-9-]{0,62}$` (≤ 63 chars). The id is
 * also used as the hostname label, so the same rule doubles as a DNS-label check.
 * Validate before calling creekd so an over-long/invalid derived id fails here
 * with a clear message rather than as an opaque creekd 400 mid-deploy.
 */
const CREEKD_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
export function assertValidCreekdId(appId: string): void {
  if (!CREEKD_ID.test(appId)) {
    throw new Error(
      `derived creekd app id "${appId}" (${appId.length} chars) is invalid — must match ` +
        `${CREEKD_ID} (≤ 63 chars, lowercase alphanumeric/hyphen, no leading hyphen). ` +
        `Shorten the project and/or team slug.`,
    );
  }
}

function authHeaders(cfg: CreekdConfig): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (cfg.token) h["authorization"] = `Bearer ${cfg.token}`;
  return h;
}

async function readError(res: Response): Promise<CreekdError> {
  try {
    return (await res.json()) as CreekdError;
  } catch {
    return { error: res.statusText };
  }
}

/**
 * Spawn a new app on creekd. Returns "created" on success, or "exists" if the
 * id is already running (409 already_running) — the signal for the caller to
 * redeploy instead. Any other non-2xx throws with creekd's code + message.
 */
export async function spawnApp(cfg: CreekdConfig, req: SpawnRequest): Promise<"created" | "exists"> {
  const res = await fetch(`${cfg.adminUrl}/v1/apps`, {
    method: "POST",
    headers: authHeaders(cfg),
    body: JSON.stringify(req),
  });
  if (res.ok) return "created";
  const err = await readError(res);
  if (res.status === 409 && err.code === "already_running") return "exists";
  throw new Error(`creekd spawn failed (${res.status} ${err.code ?? "error"}): ${err.error ?? ""}`);
}

/** Blue-green redeploy an existing app (POST /v1/apps/{id}/deploy). */
export async function deployApp(
  cfg: CreekdConfig,
  id: string,
  req: DeployRequest,
): Promise<void> {
  const res = await fetch(`${cfg.adminUrl}/v1/apps/${encodeURIComponent(id)}/deploy`, {
    method: "POST",
    headers: authHeaders(cfg),
    body: JSON.stringify(req),
  });
  if (res.ok) return;
  const err = await readError(res);
  throw new Error(`creekd deploy failed (${res.status} ${err.code ?? "error"}): ${err.error ?? ""}`);
}

/**
 * Poll creekd dispatch until the app answers its health path. creekd's dispatch
 * routes by the `x-creek-app` header (id → app). No-op when no dispatchUrl is
 * configured (a real fleet always sets it; skipping keeps single-host dev simple).
 */
export async function waitHealthy(
  cfg: CreekdConfig,
  id: string,
  opts: { path?: string; timeoutMs?: number; intervalMs?: number; requestTimeoutMs?: number } = {},
): Promise<void> {
  if (!cfg.dispatchUrl) return;
  const path = opts.path ?? "/health";
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const intervalMs = opts.intervalMs ?? 250;
  // Per-request timeout: without it a single hung fetch (stalled connection, no
  // response) would block forever and the loop would never reach the deadline
  // check below — the whole deploy hangs. Abort each probe so polling always
  // makes progress toward `timeoutMs`.
  const requestTimeoutMs = opts.requestTimeoutMs ?? Math.min(5_000, timeoutMs);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ac = new AbortController();
    const abortTimer = setTimeout(() => ac.abort(), requestTimeoutMs);
    try {
      const res = await fetch(`${cfg.dispatchUrl}${path}`, {
        headers: { "x-creek-app": id },
        signal: ac.signal,
      });
      if (res.ok) return;
    } catch {
      // dispatch not ready / app booting / request aborted — keep polling
    } finally {
      clearTimeout(abortTimer);
    }
    if (Date.now() >= deadline) {
      throw new Error(`creekd app ${id} did not become healthy within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
