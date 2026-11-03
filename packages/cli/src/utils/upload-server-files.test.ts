import { CreekApiError } from "@solcreek/sdk";
import {
  uploadServerFiles,
  retryReason,
  defaultTimeoutMs,
  UploadTimeoutError,
  type ServerFileUploader,
} from "./upload-server-files.js";
import { serverFileProgress } from "../commands/deploy.js";

const fetchFailed = (code: string) =>
  new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });

function files(n: number, size = 4): Array<[string, Uint8Array]> {
  return Array.from({ length: n }, (_, i) => [`m${i}.js`, new Uint8Array(size)]);
}

/** A client whose uploads take `delay` ms and fail per `fail(name, attempt)`. */
function fakeClient(opts: { delay?: number; fail?: (name: string, attempt: number) => unknown }) {
  const attempts = new Map<string, number>();
  const stored: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const client: ServerFileUploader = {
    async uploadServerFile(_p, _d, name, _bytes, options) {
      const attempt = (attempts.get(name) ?? 0) + 1;
      attempts.set(name, attempt);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, opts.delay ?? 1);
          options?.signal?.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new DOMException("aborted", "AbortError"));
          });
        });
        const err = opts.fail?.(name, attempt);
        if (err) throw err;
        stored.push(name);
        return { ok: true };
      } finally {
        inFlight--;
      }
    },
  };
  return { client, attempts, stored, maxInFlight: () => maxInFlight };
}

const noBackoff = { backoffMs: () => 0 };

describe("uploadServerFiles", () => {
  it("uploads every file, at most `concurrency` at once", async () => {
    const c = fakeClient({ delay: 5 });
    await uploadServerFiles(c.client, "p", "d", files(50), { concurrency: 8 });
    expect(new Set(c.stored).size).toBe(50);
    expect(c.maxInFlight()).toBe(8);
  });

  it("is much faster than one at a time when each request waits on latency", async () => {
    const c = fakeClient({ delay: 20 });
    const t0 = Date.now();
    await uploadServerFiles(c.client, "p", "d", files(40), { concurrency: 8 });
    // Sequential would be 40 × 20 ms = 800 ms; 8 at a time is ~100 ms.
    expect(Date.now() - t0).toBeLessThan(400);
  });

  it("keeps in-flight bytes under the cap, but still sends a file larger than it alone", async () => {
    const c = fakeClient({ delay: 5 });
    await uploadServerFiles(
      c.client,
      "p",
      "d",
      [...files(6, 10), ["big.wasm", new Uint8Array(100)]],
      {
        concurrency: 8,
        maxInFlightBytes: 30,
      },
    );
    expect(c.stored).toHaveLength(7);
    expect(c.maxInFlight()).toBeLessThanOrEqual(3);
  });

  it("retries network failures, 5xx and 429, then succeeds", async () => {
    const errs = [
      fetchFailed("ECONNRESET"),
      new CreekApiError(502, "unknown", "bad gateway"),
      new CreekApiError(429, "rate_limited", "slow down"),
    ];
    const c = fakeClient({
      fail: (name, attempt) => (name === "m1.js" ? errs[attempt - 1] : undefined),
    });
    const retries: string[] = [];
    await uploadServerFiles(c.client, "p", "d", files(3), {
      ...noBackoff,
      onRetry: (name, n, reason) => retries.push(`${name}#${n}:${reason}`),
    });
    expect(c.attempts.get("m1.js")).toBe(4);
    expect(c.stored).toContain("m1.js");
    expect(retries).toEqual([
      "m1.js#1:fetch failed (ECONNRESET)",
      "m1.js#2:HTTP 502",
      "m1.js#3:HTTP 429",
    ]);
  });

  it("aborts a stalled request at its timeout and retries it", async () => {
    // First attempt of m0 hangs far past the 30 ms timeout.
    let first = true;
    const c = fakeClient({ delay: 2 });
    const orig = c.client.uploadServerFile.bind(c.client);
    c.client.uploadServerFile = async (p, d, name, bytes, options) => {
      if (name === "m0.js" && first) {
        first = false;
        await new Promise((_, reject) =>
          options?.signal?.addEventListener("abort", () =>
            reject(new DOMException("a", "AbortError")),
          ),
        );
      }
      return orig(p, d, name, bytes, options);
    };
    const retries: string[] = [];
    await uploadServerFiles(c.client, "p", "d", files(2), {
      ...noBackoff,
      timeoutMs: () => 30,
      onRetry: (name, _n, reason) => retries.push(`${name}:${reason}`),
    });
    expect(retries).toEqual(["m0.js:timed out"]);
    expect(c.stored.sort()).toEqual(["m0.js", "m1.js"]);
  });

  it("gives up after `attempts` and reports the last failure as a timeout network error", async () => {
    const c = fakeClient({ delay: 1000 });
    const err = await uploadServerFiles(c.client, "p", "d", files(1), {
      ...noBackoff,
      attempts: 2,
      timeoutMs: () => 10,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(UploadTimeoutError);
    expect(err.message).toBe("fetch failed");
    expect(err.cause.code).toBe("ETIMEDOUT");
    expect(c.attempts.get("m0.js")).toBe(2);
  });

  it("does not retry a 4xx refusal, and starts no new file after a failure", async () => {
    const c = fakeClient({
      delay: 5,
      fail: (name) =>
        name === "m2.js" ? new CreekApiError(400, "validation", "bad name") : undefined,
    });
    await expect(
      uploadServerFiles(c.client, "p", "d", files(100), { ...noBackoff, concurrency: 4 }),
    ).rejects.toThrow(/bad name/);
    expect(c.attempts.get("m2.js")).toBe(1);
    // Only the files already started when m2 failed went out.
    expect(c.attempts.size).toBeLessThan(10);
  });

  it("passes a missing-route 404 through untouched, for the inline fallback", async () => {
    const c = fakeClient({ fail: () => new CreekApiError(404, "unknown", "404 Not Found") });
    const err = await uploadServerFiles(c.client, "p", "d", files(5), noBackoff).catch((e) => e);
    expect(err).toBeInstanceOf(CreekApiError);
    expect(err.status).toBe(404);
  });

  it("handles an empty list", async () => {
    const c = fakeClient({});
    await uploadServerFiles(c.client, "p", "d", []);
    expect(c.stored).toEqual([]);
  });
});

describe("retryReason", () => {
  it("does not retry other errors", () => {
    expect(retryReason(new CreekApiError(403, "forbidden", "no"))).toBeNull();
    expect(retryReason(new Error("boom"))).toBeNull();
  });
});

describe("defaultTimeoutMs", () => {
  it("allows 60 s plus 16 KB/s", () => {
    expect(defaultTimeoutMs(0)).toBe(60_000);
    expect(defaultTimeoutMs(16 * 1024 * 1024)).toBe(60_000 + 1_048_576);
  });
});

describe("serverFileProgress", () => {
  it("prints a line per tenth, a retry warning, and a summary", () => {
    const lines: string[] = [];
    let t = 0;
    const opts = serverFileProgress(
      { info: (m) => lines.push(`i:${m.trim()}`), warn: (m) => lines.push(`w:${m.trim()}`) },
      () => t,
    );
    for (let i = 1; i <= 321; i++) {
      if (i === 5) opts.onRetry!("m4.js", 1, "fetch failed (ECONNRESET)");
      t = i * 100;
      opts.onProgress!(i, 321, i * 1024 * 1024 * 0.04, 321 * 1024 * 1024 * 0.04);
    }
    expect(lines.filter((l) => l.startsWith("i:"))).toHaveLength(10);
    expect(lines).toContain("w:Server file m4.js: fetch failed (ECONNRESET), retrying (1)");
    expect(lines.at(-1)).toBe("i:Server files: 321/321 (12.8 MB) in 32.1s");
  });
});
