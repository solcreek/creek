import { describe, it, expect, vi, afterEach } from "vitest";
import { CreekdClient, type Release } from "./creekd-client.js";

const BASE = "http://127.0.0.1:9080";

function fetchMock(body: unknown, status = 200) {
  const captured: { url?: string; init?: RequestInit } = {};
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    captured.url = url;
    captured.init = init;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: "OK",
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
    } as unknown as Response;
  });
  return { fn, captured };
}

describe("CreekdClient.spawnApp", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("POSTs to /v1/apps with the body", async () => {
    const { fn, captured } = fetchMock({
      id: "x",
      command: "c",
      port: 1,
      status: "running",
      pid: 0,
      uptime_ms: 0,
      restart_count: 0,
      health_failures: 0,
    });
    globalThis.fetch = fn as unknown as typeof fetch;

    const client = new CreekdClient(BASE);
    await client.spawnApp({ id: "x", port: 1, command: "c" });

    expect(captured.url).toBe(`${BASE}/v1/apps`);
    expect(captured.init?.method).toBe("POST");
    // spawnApp deliberately does NOT take ifMatch — spawning a brand-
    // new app has no prior rv to match against. The signature
    // wouldn't even allow it; this is the runtime confirmation.
    const headers = (captured.init?.headers ?? {}) as Record<string, string>;
    expect("If-Match" in headers).toBe(false);
  });
});

describe("CreekdClient.deployApp", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("POSTs to /v1/apps/{id}/deploy with If-Match when provided", async () => {
    const { fn, captured } = fetchMock({
      id: "x",
      command: "c",
      port: 1,
      status: "running",
      pid: 0,
      uptime_ms: 0,
      restart_count: 0,
      health_failures: 0,
    });
    globalThis.fetch = fn as unknown as typeof fetch;

    const client = new CreekdClient(BASE);
    await client.deployApp("x", { port: 1, command: "c" }, { ifMatch: "42" });

    expect(captured.url).toBe(`${BASE}/v1/apps/x/deploy`);
    expect(captured.init?.method).toBe("POST");
    const headers = (captured.init?.headers ?? {}) as Record<string, string>;
    expect(headers["If-Match"]).toBe("42");
  });

  it("encodes the app ID for safe URLs", async () => {
    const { fn, captured } = fetchMock({
      id: "weird/name",
      command: "c",
      port: 1,
      status: "running",
      pid: 0,
      uptime_ms: 0,
      restart_count: 0,
      health_failures: 0,
    });
    globalThis.fetch = fn as unknown as typeof fetch;

    const client = new CreekdClient(BASE);
    await client.deployApp("weird/name", { port: 1 });

    expect(captured.url).toBe(`${BASE}/v1/apps/weird%2Fname/deploy`);
  });
});

describe("CreekdClient.rollbackApp wire shape", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns the parsed Release", async () => {
    const wire: Release = {
      uid: "018f-...",
      phase: "Active",
      creationTimestamp: "2026-05-24T00:00:00Z",
      spec: {
        appUid: "018f-app-uid",
        releaseSeq: 7,
        rolledBackFrom: 5,
        originalArtifactRelease: 3,
      },
    };
    const { fn } = fetchMock(wire);
    globalThis.fetch = fn as unknown as typeof fetch;

    const client = new CreekdClient(BASE);
    const got = await client.rollbackApp("x", 5);
    expect(got.spec.releaseSeq).toBe(7);
    expect(got.spec.rolledBackFrom).toBe(5);
    expect(got.spec.originalArtifactRelease).toBe(3);
  });
});
