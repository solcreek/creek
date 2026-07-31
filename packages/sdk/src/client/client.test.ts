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
    // The view is passed through as the body; fetch honours byteOffset/byteLength,
    // so only bytes [10,14) go out even though the backing buffer is 32 bytes.
    expect(init.body).toBe(view);
    const b = init.body as Uint8Array;
    expect([b.byteOffset, b.byteLength]).toEqual([10, 4]);
    expect(new Uint8Array(b.buffer, b.byteOffset, b.byteLength)).toEqual(
      new Uint8Array([10, 11, 12, 13]),
    );
  });

  test("uploadServerFile passes the view through without copying", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { ok: true }));
    const bytes = new Uint8Array([1, 2, 3, 4]);

    await client.uploadServerFile("proj", "dep", "worker.js", bytes);

    // No copy: the exact view is handed to fetch.
    const [, init] = mockFetch.mock.calls[0];
    expect(init.body).toBe(bytes);
  });

  test("uploadServerFile URL-encodes the file name", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { ok: true }));
    await client.uploadServerFile("proj", "dep", "chunks/ssr a.js", new Uint8Array([1]));
    const [url] = mockFetch.mock.calls[0];
    expect(String(url)).toContain("name=chunks%2Fssr%20a.js");
  });
});

/**
 * getLogs query-string serialization.
 *
 * Raised in Copilot review of the `--errors` PR, and a genuine hole: the
 * predicate, the server-side filter and the `--follow` client filter were
 * all covered, but nothing asserted that the client actually PUTS the
 * filter on the wire. If it silently dropped `errors`, `--errors --since`
 * would return unfiltered results while `--errors --follow` filtered
 * correctly — exactly the metrics-vs-logs inconsistency that PR exists to
 * remove, reintroduced one layer down.
 */
describe("CreekClient.getLogs — filter serialization", () => {
  const client = new CreekClient("http://localhost:8787", "test-token");

  function urlOf(): URL {
    return new URL(mockFetch.mock.calls[0][0] as string, "http://localhost:8787");
  }

  test("errors: true is sent as errors=1", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { entries: [], truncated: false }));

    await client.getLogs("blog", { errors: true });

    expect(urlOf().searchParams.get("errors")).toBe("1");
  });

  test("the param is absent when errors is unset or false", async () => {
    // Sending errors=0 would be worse than sending nothing — the server
    // reads `=== "1"`, so a stray value would be silently ignored rather
    // than rejected, and the difference would never surface.
    mockFetch.mockResolvedValue(jsonResponse(200, { entries: [], truncated: false }));
    await client.getLogs("blog", { since: "1h" });
    expect(urlOf().searchParams.has("errors")).toBe(false);

    mockFetch.mockReset();
    mockFetch.mockResolvedValue(jsonResponse(200, { entries: [], truncated: false }));
    await client.getLogs("blog", { errors: false });
    expect(urlOf().searchParams.has("errors")).toBe(false);
  });

  test("errors rides alongside outcome rather than replacing it", async () => {
    // The server ANDs the two; both must reach it for that to hold.
    mockFetch.mockResolvedValue(jsonResponse(200, { entries: [], truncated: false }));

    await client.getLogs("blog", { errors: true, outcomes: ["canceled"], since: "6h" });

    const p = urlOf().searchParams;
    expect(p.get("errors")).toBe("1");
    expect(p.getAll("outcome")).toEqual(["canceled"]);
    expect(p.get("since")).toBe("6h");
  });
});
