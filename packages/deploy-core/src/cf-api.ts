import type { DeployEnv } from "./types.js";

/**
 * Default per-request timeout for a Cloudflare API call. A bare `fetch` with no
 * signal can hang indefinitely; when that happens inside a deploy job the whole
 * activation just sits until the 10-minute stale-deploy reaper sweeps it — the
 * "stuck 10-12 minutes then failed with no reason" a customer hit. Bounding each
 * request well under the reaper turns a hang into a fast, classifiable failure
 * ("timed out" → activation_timeout). 120s is generous: a single WfP script PUT
 * or asset-bucket POST is far smaller than a whole bundle.
 */
export const CF_API_TIMEOUT_MS = 120_000;

/**
 * Statuses safe to retry for ANY method: the request was provably not applied
 * (429 rate-limited, 503 unavailable), so retrying can't double-execute a
 * non-idempotent op (e.g. a provisioning create). Timeouts and network errors
 * are deliberately NOT retried — those are ambiguous (the op may have taken
 * effect), so we surface them instead of risking a duplicate.
 */
const RETRYABLE_STATUS = new Set([429, 503]);
const DEFAULT_MAX_RETRIES = 2; // 3 attempts total
const DEFAULT_BACKOFF_BASE_MS = 500;

export interface CfApiOptions {
  /** Per-attempt timeout. Defaults to {@link CF_API_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Extra attempts after the first, for 429/503 only. Default 2. */
  maxRetries?: number;
  /** Base for exponential backoff between retries. Default 500ms. */
  backoffBaseMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Cloudflare API helper for WfP operations.
 *
 * Adds a bounded per-request timeout (fail fast instead of hanging until the
 * reaper) and a conservative retry for 429/503 with exponential backoff (honors
 * `Retry-After` when present). Only 429/503 are retried, so a non-idempotent
 * request is never re-sent after an ambiguous timeout/network error.
 */
export async function cfApi(
  env: DeployEnv,
  method: string,
  path: string,
  body?: unknown,
  authToken?: string,
  opts?: CfApiOptions,
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

  const timeoutMs = opts?.timeoutMs ?? CF_API_TIMEOUT_MS;
  const maxRetries = opts?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const backoffBaseMs = opts?.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      // AbortSignal.timeout fires a TimeoutError. Surface it as a clear,
      // classifiable "timed out" message rather than retrying (ambiguous).
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new Error(`CF API request timed out after ${timeoutMs}ms: ${method} ${path}`);
      }
      throw err;
    }

    if (RETRYABLE_STATUS.has(res.status) && attempt < maxRetries) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : backoffBaseMs * 2 ** attempt;
      // Drain the unread body before retrying: an undrained response can pin the
      // undici connection and prevent reuse (or leak) across attempts.
      await res.body?.cancel().catch(() => {});
      await sleep(backoff);
      continue;
    }

    // Non-2xx that we didn't retry: surface the status (the body may be HTML,
    // not the JSON envelope) instead of failing obscurely on res.json().
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`CF API HTTP ${res.status}: ${text.slice(0, 300)}`);
    }

    const json = (await res.json()) as any;
    if (!json.success && json.errors?.length) {
      throw new Error(`CF API error: ${JSON.stringify(json.errors)}`);
    }
    return json.result;
  }
}
