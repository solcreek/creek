import { describe, it, expect, vi, afterEach } from "vitest";
import {
  CreekdClient,
  CreekdApiError,
  CreekdResourceVersionMismatchError,
} from "./creekd-client.js";

const BASE = "http://127.0.0.1:9080";

/**
 * Build a fetch-mock that captures the request init so each test
 * can assert the If-Match header behaviour. Returns both the mock
 * (to install on globalThis.fetch) and a reference to the last
 * captured init.
 */
function fetchMock(body: unknown, status = 200, headers: Record<string, string> = {}) {
  const captured: { init: RequestInit | undefined } = { init: undefined };
  const fn = vi.fn(async (_url: string, init?: RequestInit) => {
    captured.init = init;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status >= 200 && status < 300 ? "OK" : "Error",
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
      headers: new Map(Object.entries(headers)),
    } as unknown as Response;
  });
  return { fn, captured };
}

describe("CreekdClient sends If-Match when configured", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("stopApp passes ifMatch through as If-Match header", async () => {
    const { fn, captured } = fetchMock(null, 204);
    globalThis.fetch = fn as unknown as typeof fetch;

    const client = new CreekdClient(BASE, "");
    await client.stopApp("my-app", { ifMatch: "42" });

    const headers = (captured.init?.headers ?? {}) as Record<string, string>;
    expect(headers["If-Match"]).toBe("42");
    expect(captured.init?.method).toBe("DELETE");
  });

  it("rollbackApp passes ifMatch and target seq", async () => {
    const { fn, captured } = fetchMock({ uid: "u", phase: "Active" });
    globalThis.fetch = fn as unknown as typeof fetch;

    const client = new CreekdClient(BASE, "");
    await client.rollbackApp("my-app", 7, { ifMatch: "99" });

    expect(fn).toHaveBeenCalledWith(
      `${BASE}/v1/apps/my-app/rollback?to=7`,
      expect.objectContaining({ method: "POST" }),
    );
    const headers = (captured.init?.headers ?? {}) as Record<string, string>;
    expect(headers["If-Match"]).toBe("99");
  });

  it("omits If-Match when ifMatch is not provided (unconditional write)", async () => {
    const { fn, captured } = fetchMock(null, 204);
    globalThis.fetch = fn as unknown as typeof fetch;

    const client = new CreekdClient(BASE, "");
    await client.stopApp("my-app");

    const headers = (captured.init?.headers ?? {}) as Record<string, string>;
    expect("If-Match" in headers).toBe(false);
  });

  it("restartApp does NOT send If-Match — restart is an operation, not a spec mutation", async () => {
    const { fn, captured } = fetchMock({
      id: "x", command: "c", port: 1, status: "running",
      pid: 1, uptime_ms: 0, restart_count: 0, health_failures: 0,
    });
    globalThis.fetch = fn as unknown as typeof fetch;

    const client = new CreekdClient(BASE, "");
    await client.restartApp("x");

    const headers = (captured.init?.headers ?? {}) as Record<string, string>;
    expect("If-Match" in headers).toBe(false);
  });
});

describe("412 → CreekdResourceVersionMismatchError", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("throws the typed subclass with currentResourceVersion + attempted", async () => {
    const { fn } = fetchMock(
      { code: "resource_version_mismatch", error: "expected 5, got 3", currentResourceVersion: "5" },
      412,
    );
    globalThis.fetch = fn as unknown as typeof fetch;

    const client = new CreekdClient(BASE, "");
    const promise = client.stopApp("x", { ifMatch: "3" });
    await expect(promise).rejects.toBeInstanceOf(CreekdResourceVersionMismatchError);
    try {
      await promise;
    } catch (e) {
      const err = e as CreekdResourceVersionMismatchError;
      expect(err.currentResourceVersion).toBe("5");
      expect(err.attemptedResourceVersion).toBe("3");
      // Subclass: generic catch still picks it up.
      expect(err).toBeInstanceOf(CreekdApiError);
    }
  });

  it("does NOT specialise on 412 with a non-rv code (some other 412 reason)", async () => {
    const { fn } = fetchMock({ code: "something_else", error: "huh" }, 412);
    globalThis.fetch = fn as unknown as typeof fetch;

    const client = new CreekdClient(BASE, "");
    try {
      await client.stopApp("x", { ifMatch: "3" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CreekdApiError);
      expect(e).not.toBeInstanceOf(CreekdResourceVersionMismatchError);
    }
  });

  it("tolerates 412 body missing currentResourceVersion field", async () => {
    // Daemon contract is to include it; legacy / edge behaviour
    // must still produce a typed error rather than crash on the
    // missing field.
    const { fn } = fetchMock({ code: "resource_version_mismatch", error: "..." }, 412);
    globalThis.fetch = fn as unknown as typeof fetch;

    const client = new CreekdClient(BASE, "");
    try {
      await client.stopApp("x", { ifMatch: "3" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CreekdResourceVersionMismatchError);
      expect((e as CreekdResourceVersionMismatchError).currentResourceVersion).toBe("");
    }
  });
});
