import { describe, test, expect, vi, afterEach } from "vitest";
import { cfApi } from "./cf-api.js";
import type { DeployEnv } from "./types.js";

const env: DeployEnv = {
  CLOUDFLARE_API_TOKEN: "test-token",
  CLOUDFLARE_ACCOUNT_ID: "test-account",
  DISPATCH_NAMESPACE: "test-ns",
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("cfApi", () => {
  test("sends GET with auth header", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ success: true, result: { id: "abc" } })));

    const result = await cfApi(env, "GET", "/test/path");

    const call = (globalThis.fetch as any).mock.calls[0];
    expect(call[0]).toBe("https://api.cloudflare.com/client/v4/test/path");
    expect(call[1].method).toBe("GET");
    expect(call[1].headers.Authorization).toBe("Bearer test-token");
    expect(result).toEqual({ id: "abc" });
  });

  test("sends POST with JSON body", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ success: true, result: { ok: true } })));

    await cfApi(env, "POST", "/create", { name: "test" });

    const call = (globalThis.fetch as any).mock.calls[0];
    expect(call[1].method).toBe("POST");
    expect(call[1].headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(call[1].body)).toEqual({ name: "test" });
  });

  test("uses custom auth token when provided", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ success: true, result: {} })));

    await cfApi(env, "GET", "/path", undefined, "custom-token");

    const call = (globalThis.fetch as any).mock.calls[0];
    expect(call[1].headers.Authorization).toBe("Bearer custom-token");
  });

  test("sends FormData without Content-Type override", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ success: true, result: {} })));

    const form = new FormData();
    form.append("file", "content");
    await cfApi(env, "PUT", "/upload", form);

    const call = (globalThis.fetch as any).mock.calls[0];
    expect(call[1].body).toBe(form);
    // FormData should not have Content-Type set (browser sets multipart boundary)
    expect(call[1].headers["Content-Type"]).toBeUndefined();
  });

  test("throws on CF API error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: false,
          errors: [{ code: 10000, message: "Authentication error" }],
        }),
      ),
    );

    await expect(cfApi(env, "GET", "/fail")).rejects.toThrow("CF API error");
  });

  test("returns result on success even with empty result", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ success: true, result: null })));

    const result = await cfApi(env, "GET", "/empty");
    expect(result).toBeNull();
  });

  test("passes an AbortSignal so a request can't hang forever", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ success: true, result: {} })));

    await cfApi(env, "GET", "/path");

    const call = (globalThis.fetch as any).mock.calls[0];
    expect(call[1].signal).toBeInstanceOf(AbortSignal);
  });

  test("surfaces a timeout as a classifiable 'timed out' error, without retrying", async () => {
    // AbortSignal.timeout fires a TimeoutError; the message must contain
    // "timed out" so classifyDeployFailure maps it to *_timeout.
    const timeoutErr = Object.assign(new Error("aborted"), { name: "TimeoutError" });
    const fetchMock = vi.fn().mockRejectedValue(timeoutErr);
    globalThis.fetch = fetchMock;

    await expect(cfApi(env, "PUT", "/script", { a: 1 }, undefined, { timeoutMs: 5 })).rejects.toThrow(
      /timed out/i,
    );
    // A timeout is ambiguous — must NOT retry a non-idempotent request.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("retries 503 with backoff, then returns the eventual success", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValue(new Response(JSON.stringify({ success: true, result: { ok: 1 } })));
    globalThis.fetch = fetchMock;

    const result = await cfApi(env, "POST", "/upload", { x: 1 }, undefined, { backoffBaseMs: 1 });

    expect(result).toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("retries 429 honoring Retry-After, then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValue(new Response(JSON.stringify({ success: true, result: {} })));
    globalThis.fetch = fetchMock;

    await cfApi(env, "GET", "/rl", undefined, undefined, { backoffBaseMs: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("drains the response body before retrying (connection-reuse hygiene)", async () => {
    const first = new Response("unavailable", { status: 503 });
    const cancelSpy = vi.spyOn(first.body!, "cancel");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValue(new Response(JSON.stringify({ success: true, result: {} })));
    globalThis.fetch = fetchMock;

    await cfApi(env, "GET", "/x", undefined, undefined, { backoffBaseMs: 1 });
    expect(cancelSpy).toHaveBeenCalled();
  });

  test("gives up after maxRetries on persistent 503 with an HTTP error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("busy", { status: 503 }));
    globalThis.fetch = fetchMock;

    await expect(
      cfApi(env, "GET", "/down", undefined, undefined, { maxRetries: 1, backoffBaseMs: 1 }),
    ).rejects.toThrow(/CF API HTTP 503/);
    expect(fetchMock).toHaveBeenCalledTimes(2); // first + 1 retry
  });

  test("does not retry a non-retryable 5xx (500) and surfaces the status", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("boom", { status: 500 }));
    globalThis.fetch = fetchMock;

    await expect(cfApi(env, "GET", "/err")).rejects.toThrow(/CF API HTTP 500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
