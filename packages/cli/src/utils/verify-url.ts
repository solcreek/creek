/**
 * GET a preview URL and report whether it is actually live.
 *
 * Used by `creek verify` and attached as `proof` on sandbox deploy
 * JSON so an agent can close the loop without a second command.
 * Never throws — network/parse failures become `{ ok: false, error }`.
 */

export interface ContainsCheck {
  needle: string;
  found: boolean;
}

export interface VerifyResult {
  ok: boolean;
  url: string;
  status: number | null;
  title: string | null;
  ttfbMs: number;
  contentType: string | null;
  sandboxId: string | null;
  contains: ContainsCheck[];
  error?: string;
}

export interface VerifyUrlOpts {
  contains?: string[];
  timeoutMs?: number;
  /** Body size cap in bytes. Defaults to MAX_BODY_BYTES (2 MiB). */
  maxBodyBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
/** Default cap for `creek verify` / attachProof — 2 MiB. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
const TITLE_RE = /<title[^>]*>([^<]*)<\/title>/i;

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

export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export async function verifyUrl(url: string, opts: VerifyUrlOpts = {}): Promise<VerifyResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const needles = opts.contains ?? [];
  const started = Date.now();

  const fail = (error: string, extra: Partial<VerifyResult> = {}): VerifyResult => ({
    ok: false,
    url,
    status: extra.status ?? null,
    title: extra.title ?? null,
    ttfbMs: extra.ttfbMs ?? Date.now() - started,
    contentType: extra.contentType ?? null,
    sandboxId: extra.sandboxId ?? null,
    contains: needles.map((needle) => ({ needle, found: false })),
    error,
  });

  if (!isHttpUrl(url)) {
    return fail("URL must be http or https");
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return fail(`Timed out after ${timeoutMs}ms`);
    }
    return fail(err instanceof Error ? err.message : String(err));
  }

  const ttfbMs = Date.now() - started;
  const contentType = res.headers.get("content-type");
  const sandboxId = res.headers.get("x-sandbox-id");
  const status = res.status;
  const maxBodyBytes = opts.maxBodyBytes ?? MAX_BODY_BYTES;

  const contentLengthRaw = res.headers.get("content-length");
  if (contentLengthRaw != null && contentLengthRaw !== "") {
    const declared = Number(contentLengthRaw);
    if (Number.isFinite(declared) && declared > maxBodyBytes) {
      void res.body?.cancel()?.catch(() => {});
      return fail(responseTooLarge(declared, maxBodyBytes), {
        status,
        ttfbMs,
        contentType,
        sandboxId,
      });
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
          : "Failed to read response body";
    return fail(message, {
      status,
      ttfbMs,
      contentType,
      sandboxId,
    });
  }

  const titleMatch = TITLE_RE.exec(body);
  const title = titleMatch ? titleMatch[1].trim() : null;
  const contains = needles.map((needle) => ({
    needle,
    found: body.includes(needle),
  }));
  const containsOk = contains.every((c) => c.found);
  const statusOk = status >= 200 && status < 400;

  return {
    ok: statusOk && containsOk,
    url: res.url || url,
    status,
    title,
    ttfbMs,
    contentType,
    sandboxId,
    contains,
    ...(!statusOk
      ? { error: `HTTP ${status}` }
      : !containsOk
        ? {
            error: `Missing: ${contains
              .filter((c) => !c.found)
              .map((c) => c.needle)
              .join(", ")}`,
          }
        : {}),
  };
}
