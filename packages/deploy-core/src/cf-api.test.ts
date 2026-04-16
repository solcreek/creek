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
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, result: { id: "abc" } })),
    );

    const result = await cfApi(env, "GET", "/test/path");

    const call = (globalThis.fetch as any).mock.calls[0];
    expect(call[0]).toBe("https://api.cloudflare.com/client/v4/test/path");
    expect(call[1].method).toBe("GET");
    expect(call[1].headers.Authorization).toBe("Bearer test-token");
    expect(result).toEqual({ id: "abc" });
  });

  test("sends POST with JSON body", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, result: { ok: true } })),
    );

    await cfApi(env, "POST", "/create", { name: "test" });

    const call = (globalThis.fetch as any).mock.calls[0];
    expect(call[1].method).toBe("POST");
    expect(call[1].headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(call[1].body)).toEqual({ name: "test" });
  });

  test("uses custom auth token when provided", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, result: {} })),
    );

    await cfApi(env, "GET", "/path", undefined, "custom-token");

    const call = (globalThis.fetch as any).mock.calls[0];
    expect(call[1].headers.Authorization).toBe("Bearer custom-token");
  });

  test("sends FormData without Content-Type override", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, result: {} })),
    );

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
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, result: null })),
    );

    const result = await cfApi(env, "GET", "/empty");
    expect(result).toBeNull();
  });
});
