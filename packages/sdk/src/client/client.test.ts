import { describe, test, expect, vi, beforeEach } from "vitest";
import { CreekClient, CreekApiError, CreekAuthError } from "./index.js";

// Mock fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
});

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("CreekClient", () => {
  const client = new CreekClient("http://localhost:8787", "test-token");

  test("sends x-api-key header", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, []));

    await client.listProjects();

    expect(mockFetch).toHaveBeenCalledOnce();
    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers["x-api-key"]).toBe("test-token");
  });

  test("throws CreekAuthError on 401", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(401, { error: "unauthorized", message: "Invalid token" }),
    );

    await expect(client.listProjects()).rejects.toThrow(CreekAuthError);
    await expect(
      client.listProjects().catch((e) => {
        expect(e.message).toBe("Invalid token");
        throw e;
      }),
    ).rejects.toThrow();
  });

  test("throws CreekApiError on other errors", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(500, { error: "server_error", message: "Internal error" }),
    );

    await expect(client.listProjects()).rejects.toThrow(CreekApiError);
  });

  test("getSession returns null on failure", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(401, { error: "unauthorized", message: "No session" }),
    );

    const result = await client.getSession();
    expect(result).toBeNull();
  });

  test("getSession returns user on success", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(200, { user: { id: "1", name: "Test", email: "test@example.com" } }),
    );

    const result = await client.getSession();
    expect(result?.user.name).toBe("Test");
  });

  test("uploadServerFile sends exactly the view's bytes (not the whole backing buffer)", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { ok: true }));

    // A Uint8Array view into the middle of a larger buffer — like a pooled Node
    // Buffer. The upload must carry only bytes [10,14), not the whole 32 bytes.
    const backing = new Uint8Array(32);
    for (let i = 0; i < 32; i++) backing[i] = i;
    const view = backing.subarray(10, 14); // bytes 10,11,12,13

    await client.uploadServerFile("proj", "dep", "worker.js", view);

    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toContain("/serverfile?name=worker.js");
    expect(init.headers["Content-Type"]).toBe("application/octet-stream");
    expect(new Uint8Array(init.body as ArrayBuffer)).toEqual(new Uint8Array([10, 11, 12, 13]));
  });

  test("uploadServerFile URL-encodes the file name", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { ok: true }));
    await client.uploadServerFile("proj", "dep", "chunks/ssr a.js", new Uint8Array([1]));
    const [url] = mockFetch.mock.calls[0];
    expect(String(url)).toContain("name=chunks%2Fssr%20a.js");
  });
});
