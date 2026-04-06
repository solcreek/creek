import consola from "consola";
import { getSandboxApiUrl } from "./config.js";
import { isTTY } from "./output.js";
import type { TosAcceptance } from "./tos.js";

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

  const res = await fetch(`${apiUrl}/api/sandbox/deploy`, {
    method: "POST",
    headers,
    body: JSON.stringify(bundle),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText })) as any;
    throw new Error(err.message ?? `Sandbox deploy failed (${res.status})`);
  }

  return res.json() as Promise<SandboxDeployResponse>;
}

/**
 * Poll sandbox status until terminal state.
 */
export async function pollSandboxStatus(statusUrl: string): Promise<SandboxStatusResponse> {
  const POLL_INTERVAL = 1000;
  const POLL_TIMEOUT = 60_000;
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

  throw new Error("Sandbox deploy timed out");
}

/**
 * Print sandbox success message with claim instructions.
 */
export function printSandboxSuccess(previewUrl: string, expiresAt: string, sandboxId: string) {
  consola.success(`  Live → ${previewUrl}`);
  consola.info("");
  consola.info("  Free preview — available for 60 minutes.");
  consola.info("  Make it permanent: creek login && creek claim " + sandboxId);
}
