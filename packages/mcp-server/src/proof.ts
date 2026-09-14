/**
 * GET a sandbox preview URL so MCP deploy can close the loop the same
 * way `creek deploy --sandbox` attaches `proof`. Never throws.
 */

const TITLE_RE = /<title[^>]*>([^<]*)<\/title>/i;
/** Default cap for preview proof — 2 MiB. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

export interface PreviewProof {
  ok: boolean;
  url: string;
  status: number | null;
  title: string | null;
  ttfbMs: number;
  error?: string;
}

export interface ProvePreviewOpts {
  timeoutMs?: number;
  /** Body size cap in bytes. Defaults to MAX_BODY_BYTES (2 MiB). */
  maxBodyBytes?: number;
}

function responseTooLarge(bytes: number, max: number): string {
  return `Response too large (${bytes} bytes; max ${max} bytes)`;
}

class BodyTooLargeError extends Error {
  readonly received: number;
  constructor(received: number, max: number) {
    super(responseTooLarge(received, max));
    this.name = "BodyTooLargeError";
    this.received = received;
  }
}

/**
 * Read `res` as UTF-8, aborting if the stream exceeds `maxBytes`.
 * Caller must already have rejected an oversize Content-Length.
 */
async function readBodyCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;
    received += value.byteLength;
    if (received > maxBytes) {
      chunks.length = 0;
      await reader.cancel();
      throw new BodyTooLargeError(received, maxBytes);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

export async function provePreview(
  url: string,
  opts: ProvePreviewOpts = {},
): Promise<PreviewProof> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxBodyBytes = opts.maxBodyBytes ?? MAX_BODY_BYTES;
  const started = Date.now();
  const fail = (error: string, extra: Partial<PreviewProof> = {}): PreviewProof => ({
    ok: false,
    url,
    status: extra.status ?? null,
    title: extra.title ?? null,
    ttfbMs: extra.ttfbMs ?? Date.now() - started,
    error,
  });

  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
    });
    const ttfbMs = Date.now() - started;
    const status = res.status;

    const contentLengthRaw = res.headers.get("content-length");
    if (contentLengthRaw != null && contentLengthRaw !== "") {
      const declared = Number(contentLengthRaw);
      if (Number.isFinite(declared) && declared > maxBodyBytes) {
        void res.body?.cancel()?.catch(() => {});
        return fail(responseTooLarge(declared, maxBodyBytes), { status, ttfbMs });
      }
    }

    let body = "";
    try {
      body = await readBodyCapped(res, maxBodyBytes);
    } catch (err) {
      const message =
        err instanceof BodyTooLargeError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Failed to read body";
      return fail(message, { status, ttfbMs });
    }
    const titleMatch = TITLE_RE.exec(body);
    const title = titleMatch ? titleMatch[1].trim() : null;
    const statusOk = status >= 200 && status < 400;
    return {
      ok: statusOk,
      url: res.url || url,
      status,
      title,
      ttfbMs,
      ...(!statusOk ? { error: `HTTP ${status}` } : {}),
    };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return fail(`Timed out after ${timeoutMs}ms`);
    }
    return fail(err instanceof Error ? err.message : String(err));
  }
}
