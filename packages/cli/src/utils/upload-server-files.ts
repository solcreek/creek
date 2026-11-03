import { CreekApiError } from "@solcreek/sdk";
import { isNetworkFailure } from "./request-ledger.js";

/**
 * Upload a deployment's server files (PUT /serverfile, one per module) in
 * parallel, each with a timeout and retries.
 *
 * A vinext worker is hundreds of modules. Sent one after another, every
 * request waits out the API's auth and database round trips (~1–3 s from
 * Asia), so a 321-module worker took 6–15 minutes. One stalled request then
 * hung the whole deploy, with no timeout and no retry.
 *
 * PUT /serverfile only writes the file to staging under its name, so sending
 * it again is safe: a network failure, a timeout, a 429 or a 5xx is retried.
 * Any other 4xx is a refusal and stops the upload.
 */

export interface ServerFileUploader {
  uploadServerFile(
    projectId: string,
    deploymentId: string,
    name: string,
    bytes: Uint8Array,
    options?: { signal?: AbortSignal },
  ): Promise<{ ok: boolean }>;
}

export interface UploadServerFilesOptions {
  /** Requests in flight at once. */
  concurrency?: number;
  /**
   * Bytes in flight at once. A request starts past this only when nothing
   * else is in flight, so one file larger than the cap still goes alone.
   */
  maxInFlightBytes?: number;
  /** Attempts per file, the first included. */
  attempts?: number;
  /** Timeout for one attempt, given the file's size. */
  timeoutMs?: (bytes: number) => number;
  /** Delay before retry number `retry` (1-based). */
  backoffMs?: (retry: number) => number;
  /** Called after each file is stored. */
  onProgress?: (done: number, total: number, bytesDone: number, bytesTotal: number) => void;
  /** Called before a retry. */
  onRetry?: (name: string, retry: number, reason: string) => void;
}

export const DEFAULT_CONCURRENCY = 8;
export const DEFAULT_MAX_IN_FLIGHT_BYTES = 32 * 1024 * 1024;
export const DEFAULT_ATTEMPTS = 4;

/**
 * 60 s, plus the time the file needs at 16 KB/s: a large worker on a slow
 * link still finishes, and a stalled request still ends.
 */
export function defaultTimeoutMs(bytes: number): number {
  return 60_000 + Math.ceil(bytes / 16);
}

/** 1 s, 2 s, 4 s, … capped at 15 s, with ±25% jitter. */
export function defaultBackoffMs(retry: number): number {
  const base = Math.min(15_000, 1000 * 2 ** (retry - 1));
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

/** A timed-out attempt, reported like undici's own read timeout. */
export class UploadTimeoutError extends TypeError {
  constructor(name: string, ms: number) {
    const cause = Object.assign(
      new Error(`server file ${name} got no answer within ${Math.round(ms / 1000)}s`),
      { code: "ETIMEDOUT" },
    );
    super("fetch failed", { cause });
  }
}

/** Why an attempt failed, when another attempt may succeed; else null. */
export function retryReason(err: unknown): string | null {
  if (err instanceof UploadTimeoutError) return "timed out";
  if (isNetworkFailure(err)) {
    const cause = err.cause as { code?: unknown; message?: unknown } | undefined;
    const detail = typeof cause?.code === "string" ? cause.code : cause?.message;
    return typeof detail === "string" ? `${err.message} (${detail})` : err.message;
  }
  if (err instanceof CreekApiError && (err.status === 429 || err.status >= 500)) {
    return `HTTP ${err.status}`;
  }
  return null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function uploadServerFiles(
  client: ServerFileUploader,
  projectId: string,
  deploymentId: string,
  files: Array<[name: string, bytes: Uint8Array]>,
  opts: UploadServerFilesOptions = {},
): Promise<void> {
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  const maxBytes = opts.maxInFlightBytes ?? DEFAULT_MAX_IN_FLIGHT_BYTES;
  const attempts = Math.max(1, opts.attempts ?? DEFAULT_ATTEMPTS);
  const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs;
  const backoffMs = opts.backoffMs ?? defaultBackoffMs;

  const total = files.length;
  const bytesTotal = files.reduce((n, [, b]) => n + b.byteLength, 0);
  let done = 0;
  let bytesDone = 0;

  async function uploadOne(name: string, bytes: Uint8Array): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const ms = timeoutMs(bytes.byteLength);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ms);
      try {
        await client.uploadServerFile(projectId, deploymentId, name, bytes, {
          signal: controller.signal,
        });
        return;
      } catch (raw) {
        const err = controller.signal.aborted ? new UploadTimeoutError(name, ms) : raw;
        const reason = retryReason(err);
        if (reason === null || attempt >= attempts) throw err;
        opts.onRetry?.(name, attempt, reason);
        await sleep(backoffMs(attempt));
      } finally {
        clearTimeout(timer);
      }
    }
  }

  // A small pool: start files in order while both limits allow, stop
  // starting new ones at the first failure, and report it once the
  // requests already in flight have settled.
  let next = 0;
  let inFlight = 0;
  let inFlightBytes = 0;
  let failure: { err: unknown } | null = null;

  await new Promise<void>((resolve) => {
    const pump = () => {
      while (!failure && next < total && inFlight < concurrency) {
        const [name, bytes] = files[next];
        if (inFlight > 0 && inFlightBytes + bytes.byteLength > maxBytes) break;
        next++;
        inFlight++;
        inFlightBytes += bytes.byteLength;
        uploadOne(name, bytes)
          .then(
            () => {
              done++;
              bytesDone += bytes.byteLength;
              opts.onProgress?.(done, total, bytesDone, bytesTotal);
            },
            (err) => {
              failure ??= { err };
            },
          )
          .finally(() => {
            inFlight--;
            inFlightBytes -= bytes.byteLength;
            pump();
          });
      }
      if (inFlight === 0 && (failure || next >= total)) resolve();
    };
    pump();
  });

  if (failure) throw (failure as { err: unknown }).err;
}
