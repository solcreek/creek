import { describe, it, expect, vi, afterEach } from "vitest";
import { CreekdClient, CreekdApiError } from "../utils/creekd-client.js";

const BASE = "http://127.0.0.1:9080";

function mockFetchOk(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status,
    statusText: "OK",
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  });
}

function mockFetchError(status: number, code: string, message: string) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    statusText: "Error",
    json: () => Promise.resolve({ code, error: message }),
  });
}

describe("CreekdClient.restartApp", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends POST and returns updated app", async () => {
    globalThis.fetch = mockFetchOk({
      id: "my-app",
      command: "node",
      port: 3000,
      status: "running",
      pid: 9999,
      uptime_ms: 0,
      restart_count: 3,
      health_failures: 0,
    });

    const client = new CreekdClient(BASE, "tok");
    const app = await client.restartApp("my-app");
    expect(app.pid).toBe(9999);
    expect(app.restart_count).toBe(3);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      `${BASE}/v1/apps/my-app/restart`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("throws CreekdApiError on 404", async () => {
    globalThis.fetch = mockFetchError(404, "not_found", "app not found");

    const client = new CreekdClient(BASE, "");
    await expect(client.restartApp("ghost")).rejects.toThrow(CreekdApiError);
  });
});

describe("CreekdClient.stopApp", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends DELETE", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      json: () => Promise.resolve(null),
    });
    globalThis.fetch = fetchMock;

    const client = new CreekdClient(BASE, "tok");
    await client.stopApp("my-app");

    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE}/v1/apps/my-app`,
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("throws CreekdApiError on 404", async () => {
    globalThis.fetch = mockFetchError(404, "not_found", "app not found");

    const client = new CreekdClient(BASE, "");
    await expect(client.stopApp("ghost")).rejects.toThrow(CreekdApiError);
  });
});

describe("CreekdClient.getAppLogs", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns plain text log lines", async () => {
    globalThis.fetch = mockFetchOk("line 1\nline 2\nline 3");

    const client = new CreekdClient(BASE, "tok");
    const text = await client.getAppLogs("my-app", 50);
    expect(text).toBe("line 1\nline 2\nline 3");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      `${BASE}/v1/apps/my-app/logs?tail=50`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("uses default tail of 100", async () => {
    globalThis.fetch = mockFetchOk("");

    const client = new CreekdClient(BASE, "");
    await client.getAppLogs("my-app");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      `${BASE}/v1/apps/my-app/logs?tail=100`,
      expect.anything(),
    );
  });

  it("throws CreekdApiError on 404", async () => {
    globalThis.fetch = mockFetchError(404, "not_found", "app not found");

    const client = new CreekdClient(BASE, "");
    await expect(client.getAppLogs("ghost")).rejects.toThrow(CreekdApiError);
  });
});
