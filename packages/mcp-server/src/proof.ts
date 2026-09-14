/**
 * GET a sandbox preview URL so MCP deploy can close the loop the same
 * way `creek deploy --sandbox` attaches `proof`. Never throws.
 */

const TITLE_RE = /<title[^>]*>([^<]*)<\/title>/i;

export interface PreviewProof {
  ok: boolean;
  url: string;
  status: number | null;
  title: string | null;
  ttfbMs: number;
  error?: string;
}

export async function provePreview(
  url: string,
  opts: { timeoutMs?: number } = {},
): Promise<PreviewProof> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
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
    let body = "";
    try {
      body = await res.text();
    } catch (err) {
      return fail(err instanceof Error ? err.message : "Failed to read body", { status, ttfbMs });
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
