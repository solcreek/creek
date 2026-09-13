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
}

const DEFAULT_TIMEOUT_MS = 10_000;
const TITLE_RE = /<title[^>]*>([^<]*)<\/title>/i;

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

  let body = "";
  try {
    body = await res.text();
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Failed to read response body", {
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
