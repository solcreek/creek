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
});
