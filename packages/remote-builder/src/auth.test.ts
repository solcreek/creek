import { describe, test, expect, vi, afterEach } from "vitest";

/**
 * Tests for the remote builder's authentication and templateData forwarding.
 */

// Mock the Container DO
const mockContainerFetch = vi.fn();

vi.mock("@cloudflare/containers", () => ({
  Container: class {
    defaultPort = 8080;
    sleepAfter = "5m";
  },
}));

// Import the worker after mocking
const worker = (await import("./index.js")).default;

function createEnv(secret?: string) {
  return {
    BUILD_CONTAINER: {
      idFromName: () => "test-id",
      get: () => ({
        fetch: mockContainerFetch,
      }),
    },
    INTERNAL_SECRET: secret,
  } as any;
}

afterEach(() => {
  vi.restoreAllMocks();
  mockContainerFetch.mockReset();
});

describe("internal auth", () => {
  test("rejects request without secret when INTERNAL_SECRET is set", async () => {
    const req = new Request("http://localhost/build", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/test/repo" }),
    });

    const res = await worker.fetch(req, createEnv("my-secret"));
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error).toBe("unauthorized");
  });

  test("rejects request with wrong secret", async () => {
    const req = new Request("http://localhost/build", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": "wrong-secret",
      },
      body: JSON.stringify({ repoUrl: "https://github.com/test/repo" }),
    });

    const res = await worker.fetch(req, createEnv("my-secret"));
    expect(res.status).toBe(401);
  });

  test("accepts request with correct secret", async () => {
    mockContainerFetch.mockResolvedValue(
      Response.json({ success: true, bundle: { assets: {} } }),
    );

    const req = new Request("http://localhost/build", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": "my-secret",
      },
      body: JSON.stringify({ repoUrl: "https://github.com/test/repo" }),
    });

    const res = await worker.fetch(req, createEnv("my-secret"));
    expect(res.status).toBe(200);
  });

  test("allows request when no INTERNAL_SECRET configured", async () => {
    mockContainerFetch.mockResolvedValue(
      Response.json({ success: true, bundle: { assets: {} } }),
    );

    const req = new Request("http://localhost/build", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/test/repo" }),
    });

    const res = await worker.fetch(req, createEnv(undefined));
    expect(res.status).toBe(200);
  });
});

describe("templateData forwarding", () => {
  test("forwards templateData to container", async () => {
    mockContainerFetch.mockResolvedValue(
      Response.json({ success: true, bundle: { assets: {} } }),
    );

    const templateData = { title: "Acme", theme: "light" };
    const req = new Request("http://localhost/build", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoUrl: "https://github.com/solcreek/templates",
        path: "landing",
        templateData,
      }),
    });

    await worker.fetch(req, createEnv(undefined));

    expect(mockContainerFetch).toHaveBeenCalledTimes(1);
    const callBody = JSON.parse(mockContainerFetch.mock.calls[0][1].body);
    expect(callBody.templateData).toEqual(templateData);
    expect(callBody.repoUrl).toBe("https://github.com/solcreek/templates");
    expect(callBody.path).toBe("landing");
  });

  test("omits templateData when not provided", async () => {
    mockContainerFetch.mockResolvedValue(
      Response.json({ success: true, bundle: { assets: {} } }),
    );

    const req = new Request("http://localhost/build", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/test/repo" }),
    });

    await worker.fetch(req, createEnv(undefined));

    const callBody = JSON.parse(mockContainerFetch.mock.calls[0][1].body);
    expect(callBody.templateData).toBeUndefined();
  });
});

describe("health check", () => {
  test("GET returns worker status", async () => {
    mockContainerFetch.mockResolvedValue(
      Response.json({ status: "ready" }),
    );

    const req = new Request("http://localhost/", { method: "GET" });
    const res = await worker.fetch(req, createEnv(undefined));
    const body = await res.json() as any;

    expect(body.worker).toBe("ok");
    expect(body.container).toEqual({ status: "ready" });
  });

  test("GET handles container cold start", async () => {
    mockContainerFetch.mockRejectedValue(new Error("connection refused"));

    const req = new Request("http://localhost/", { method: "GET" });
    const res = await worker.fetch(req, createEnv(undefined));
    const body = await res.json() as any;

    expect(body.worker).toBe("ok");
    expect(body.container).toBe("starting");
  });
});

describe("input validation", () => {
  test("rejects missing repoUrl", async () => {
    const req = new Request("http://localhost/build", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    const res = await worker.fetch(req, createEnv(undefined));
    expect(res.status).toBe(400);

    const body = await res.json() as any;
    expect(body.error).toContain("repoUrl");
  });

  test("rejects non-POST methods", async () => {
    const req = new Request("http://localhost/build", { method: "PUT" });
    const res = await worker.fetch(req, createEnv(undefined));
    expect(res.status).toBe(405);
  });
});
