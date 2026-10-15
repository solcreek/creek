import type { DeploymentStatusResponse } from "../types/index.js";

/**
 * The statuses a deployment never leaves. Matches the MCP server's
 * `wait_for_deployment` (packages/mcp-server/src/tools.ts), so the CLI and
 * MCP agree on when a deploy is over.
 */
export const TERMINAL_DEPLOYMENT_STATUSES: ReadonlySet<string> = new Set([
  "active",
  "failed",
  "cancelled",
]);

/**
 * One deployment, shaped for an agent to act on: where it is, why it failed,
 * where it lives. The field names are those of the MCP `get_deployment` tool,
 * plus `final` (the same value as `terminal`).
 */
export interface DeploymentView {
  project: string;
  deploymentId: string;
  version: number | null;
  status: string | null;
  /** True once the status is final: active, failed or cancelled. */
  terminal: boolean;
  /** Same as `terminal`. */
  final: boolean;
  branch: string | null;
  commitSha: string | null;
  triggerType: string | null;
  failedStep: string | null;
  errorMessage: string | null;
  /** Server-classified failure reason; present only on a failed deploy. */
  errorCode: string | null;
  errorHint: string | null;
  /** The production URL when it serves production, else its preview URL once active. */
  url: string | null;
  previewUrl: string | null;
  isProduction: boolean;
  createdAt: number | null;
}

/** GET /projects/:slug/deployments/:id → {@link DeploymentView}. */
export function toDeploymentView(
  project: string,
  requestedId: string,
  res: Partial<DeploymentStatusResponse> | null | undefined,
): DeploymentView {
  const d = (res?.deployment ?? {}) as unknown as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  const status = str(d.status);
  const terminal = status !== null && TERMINAL_DEPLOYMENT_STATUSES.has(status);
  const productionUrl = str(res?.url);
  const previewUrl = str(res?.previewUrl);
  return {
    project,
    deploymentId: str(d.id) ?? requestedId,
    version: num(d.version),
    status,
    terminal,
    final: terminal,
    branch: str(d.branch),
    commitSha: str(d.commitSha),
    triggerType: str(d.triggerType),
    failedStep: str(d.failedStep),
    errorMessage: str(d.errorMessage),
    errorCode: str(res?.errorCode),
    errorHint: str(res?.errorHint),
    // A deployment's own preview URL answers only once it is active.
    url: productionUrl ?? (status === "active" ? previewUrl : null),
    previewUrl,
    isProduction: productionUrl !== null,
    createdAt: num(d.createdAt),
  };
}

/** What {@link CreekClient.waitForDeployment} saw. */
export interface WaitForDeploymentResult {
  /** The last read; null only when the budget ran out before any read finished. */
  view: DeploymentView | null;
  /** The budget ran out before the deployment reached a final status. */
  timedOut: boolean;
  waitedMs: number;
}

export interface WaitForDeploymentOptions {
  /** Total budget, id resolution included. Default 120 000 ms. */
  timeoutMs?: number;
  /** Pause between reads. Default 2 000 ms. */
  intervalMs?: number;
  /** Called after every read. */
  onPoll?: (view: DeploymentView) => void;
}
