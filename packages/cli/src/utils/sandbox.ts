import consola from "consola";
import { gzipSync } from "node:zlib";
import { getSandboxApiUrl } from "./config.js";
import { isTTY } from "./output.js";
import type { TosAcceptance } from "./tos.js";

// Bundles with many base64-encoded assets are large (tens of MB). gzip the
// JSON body so the upload is ~6x smaller; the sandbox-api decompresses when it
// sees the X-Creek-Body-Encoding header (and still accepts plain JSON).
const GZIP_MIN_BYTES = 256 * 1024;

interface SandboxDeployResponse {
  sandboxId: string;
  status: string;
  statusUrl: string;
  previewUrl: string;
  expiresAt: string;
  tier?: string;
}

interface SandboxStatusResponse {
  sandboxId: string;
  status: string;
  previewUrl: string;
  deployDurationMs?: number;
  expiresAt: string;
  expiresInSeconds: number;
  claimable: boolean;
  failedStep?: string;
  errorMessage?: string;
}

/**
 * Deploy a bundle to the sandbox API (no auth required).
 * Manifest is optional — the API derives asset list from the assets keys.
 */
export async function sandboxDeploy(
  bundle: {
    manifest?: { assets: string[]; hasWorker: boolean; entrypoint: string | null; renderMode: string };
    assets: Record<string, string>;
    serverFiles?: Record<string, string>;
    framework?: string;
    templateId?: string;
    source: string;
    /**
     * Binding declarations from creek.toml / wrangler.*. Sandbox-api
     * provisions ephemeral D1/R2/KV per entry so `env.DB` etc. work
     * in the user's Worker without any auth or extra setup.
     */
    bindings?: Array<{ type: string; bindingName: string }>;
    /**
     * User migrations (prisma/migrations, drizzle/, …) collected by the CLI.
     * Sandbox-api applies them to the provisioned ephemeral D1 so DB-backed
     * routes work in the preview without `creek db migrate`.
     */
    migrations?: Array<{ name: string; statements: string[] }>;
    /** Compat overrides — required for Node-API-heavy bundles. */
    compatibilityDate?: string;
    compatibilityFlags?: string[];
    /** Framework-aware hint (admin URL, warnings) for the UI layer. */
    hint?: { adminPath?: string; adminLabel?: string; warnings?: string[] };
  },
  opts?: {
    tos?: TosAcceptance;
    agentToken?: string;
  },
): Promise<SandboxDeployResponse> {
  const apiUrl = getSandboxApiUrl();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  // Signal TTY status for tiered rate limiting
  if (isTTY) headers["X-Creek-TTY"] = "1";

  // Agent token for elevated rate limit
  if (opts?.agentToken) headers["Authorization"] = `Bearer ${opts.agentToken}`;

  // ToS acceptance metadata
  if (opts?.tos) {
    headers["X-Creek-ToS-Version"] = opts.tos.version;
    headers["X-Creek-ToS-Accepted-At"] = opts.tos.acceptedAt;
  }

  const json = JSON.stringify(bundle);
  // gzip large bodies; send the raw string for small ones (compression
  // overhead isn't worth it and keeps the simple path simple).
  let body: string | Uint8Array = json;
  if (Buffer.byteLength(json) >= GZIP_MIN_BYTES) {
    body = gzipSync(json);
    headers["X-Creek-Body-Encoding"] = "gzip";
  }

  const res = await fetch(`${apiUrl}/api/sandbox/deploy`, {
    method: "POST",
    headers,
    body,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText })) as any;
    throw new Error(err.message ?? `Sandbox deploy failed (${res.status})`);
  }

  return res.json() as Promise<SandboxDeployResponse>;
}

/**
 * Activation didn't reach a terminal state within the poll window. Tagged so
 * the caller can tell this (usually deterministic — a repeat timeout is almost
 * always the upload volume, not a transient blip) apart from genuinely
 * transient failures, and advise checking the cause instead of a naked retry.
 */
export class SandboxTimeoutError extends Error {
  readonly code = "deploy_timeout";
  constructor(timeoutMs: number) {
    super(
      `Sandbox deploy timed out after ${Math.round(timeoutMs / 60_000)} min. ` +
        `A repeat timeout is usually the upload volume (asset count/size), not a ` +
        `transient blip — reduce assets or check the deploy status before retrying.`,
    );
    this.name = "SandboxTimeoutError";
  }
}

/**
 * Poll sandbox status until terminal state. `timeoutMs`/`intervalMs` are
 * injectable for tests; the defaults match production.
 */
export async function pollSandboxStatus(
  statusUrl: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<SandboxStatusResponse> {
  const POLL_INTERVAL = opts.intervalMs ?? 1000;
  // Server-side activation (decode assets + upload to WfP + provision
  // resources) can take a few minutes for asset-heavy apps (tens of MB / 100+
  // assets). Poll up to 5 min so the client doesn't give up while the server is
  // still legitimately uploading — matched to the server-side stuck-deploy
  // reaper window so the two don't fight.
  const POLL_TIMEOUT = opts.timeoutMs ?? 300_000;
  const start = Date.now();

  while (Date.now() - start < POLL_TIMEOUT) {
    const res = await fetch(statusUrl);
    if (!res.ok) throw new Error(`Status check failed (${res.status})`);

    const status = (await res.json()) as SandboxStatusResponse;

    if (status.status === "active") return status;
    if (status.status === "failed") {
      const step = status.failedStep ? ` at ${status.failedStep}` : "";
      throw new Error(`Sandbox deploy failed${step}: ${status.errorMessage ?? "Unknown error"}`);
    }
    if (status.status === "expired") {
      throw new Error("Sandbox expired before activation");
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }

  throw new SandboxTimeoutError(POLL_TIMEOUT);
}

/**
 * Compute minutes-remaining until expiresAt (ISO string). Clamps at 0.
 * Returned integer is ceiling, so a sandbox with 60:01 left reports 61.
 */
export function expiresInMinutes(expiresAt: string): number {
  const ms = new Date(expiresAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 60_000));
}

/**
 * Format expiresAt as a local-clock wall time ("HH:MM") for users who
 * don't want to mentally parse ISO timestamps in UTC.
 */
export function expiresAtLocal(expiresAt: string): string {
  const d = new Date(expiresAt);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * Print sandbox success message with claim instructions.
 */
export function printSandboxSuccess(previewUrl: string, expiresAt: string, sandboxId: string) {
  const mins = expiresInMinutes(expiresAt);
  consola.success(`  Live → ${previewUrl}`);
  consola.info("");
  consola.info(`  Expires in ${mins} minutes (local ${expiresAtLocal(expiresAt)}).`);
  consola.info("  Make it permanent: creek login && creek claim " + sandboxId);
}
