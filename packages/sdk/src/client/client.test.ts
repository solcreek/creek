import { describe, test, expect, vi, beforeEach } from "vitest";
import { CreekClient, CreekApiError, CreekAuthError, toDeploymentView } from "./index.js";

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

describe("CreekClient errors", () => {
  const client = new CreekClient("http://localhost:8787", "test-token");

  test("keeps an error response's code, message and other fields", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(403, {
        error: "insufficient_scope",
        message: "This API key lacks the scope: env:write",
        required: ["env:write"],
        granted: ["project:read"],
      }),
    );
    const err = await client.listEnvVars("site").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CreekApiError);
    expect(err).toMatchObject({
      status: 403,
      code: "insufficient_scope",
      message: "This API key lacks the scope: env:write",
      details: { required: ["env:write"], granted: ["project:read"] },
    });
  });

  test("an error body that is not JSON gives code unknown and the status text", async () => {
    mockFetch.mockResolvedValue(
      new Response("<html>bad gateway</html>", { status: 502, statusText: "Bad Gateway" }),
    );
    const err = await client.listProjects().catch((e: unknown) => e);
    expect(err).toMatchObject({
      status: 502,
      code: "unknown",
      message: "Bad Gateway",
      details: {},
    });
  });

  test("a refused build log upload keeps the API's code and fields too", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(403, {
        error: "insufficient_scope",
        message: "This API key lacks the scope: deploy:preview",
        required: ["deploy:preview"],
      }),
    );
    const err = await client
      .uploadBuildLog("dep-1", "{}\n", { status: "running", startedAt: 1 })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      status: 403,
      code: "insufficient_scope",
      details: { required: ["deploy:preview"] },
    });
    // A body without an error code keeps the upload's own code.
    mockFetch.mockResolvedValue(new Response("", { status: 500, statusText: "Server Error" }));
    const plain = await client
      .uploadBuildLog("dep-1", "{}\n", { status: "running", startedAt: 1 })
      .catch((e: unknown) => e);
    expect(plain).toMatchObject({ status: 500, code: "build_log_upload_failed" });
  });

  test("a 401 is a CreekAuthError", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(401, { error: "unauthorized", message: "Invalid key" }),
    );
    const err = await client.listProjects().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CreekAuthError);
    expect((err as Error).message).toBe("Invalid key");
  });
});

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

  test("listResources asks for deleted resources only when told to", async () => {
    mockFetch.mockImplementation(async () => jsonResponse(200, { resources: [] }));

    await client.listResources();
    await client.listResources({ includeDeleted: true });

    expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([
      "http://localhost:8787/resources",
      "http://localhost:8787/resources?include=deleted",
    ]);
  });

  test("getSession returns null on failure", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(401, { error: "unauthorized", message: "No session" }),
    );

    const result = await client.getSession();
    expect(result).toBeNull();
  });

  test("getSession returns null for a key the API will not use (403)", async () => {
    mockFetch.mockResolvedValue(jsonResponse(403, { error: "team_mismatch", message: "x" }));
    expect(await client.getSession()).toBeNull();
  });

  test("getSession throws, not null, when the failure says nothing about the key", async () => {
    // A null would read as "log in again"; a 5xx or a network error should be retried.
    mockFetch.mockResolvedValue(jsonResponse(503, { error: "unavailable", message: "Down" }));
    await expect(client.getSession()).rejects.toMatchObject({ status: 503 });
    mockFetch.mockRejectedValue(new TypeError("fetch failed"));
    await expect(client.getSession()).rejects.toThrow("fetch failed");
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

  test("planRollback GETs /rollback and encodes deploymentId", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(200, {
        currentDeploymentId: "cur",
        targetDeploymentId: "tgt",
        targetStatus: "active",
      }),
    );

    const implicit = await client.planRollback("blog");
    expect(implicit.targetDeploymentId).toBe("tgt");
    expect(String(mockFetch.mock.calls[0][0])).toBe("http://localhost:8787/projects/blog/rollback");
    expect(mockFetch.mock.calls[0][1].method).toBe("GET");

    mockFetch.mockClear();
    mockFetch.mockResolvedValue(
      jsonResponse(200, {
        currentDeploymentId: "cur",
        targetDeploymentId: "id with space",
        targetStatus: "active",
      }),
    );
    await client.planRollback("blog", { deploymentId: "id with space" });
    expect(String(mockFetch.mock.calls[0][0])).toBe(
      "http://localhost:8787/projects/blog/rollback?deploymentId=id+with+space",
    );
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

describe("following a deployment", () => {
  const client = new CreekClient("http://localhost:8787", "test-token");
  const FULL = "0123abcd-0000-4000-8000-000000000001";
  const row = (over: Record<string, unknown> = {}) => ({
    id: FULL,
    projectId: "p1",
    version: 3,
    status: "deploying",
    branch: "main",
    commitSha: "abc1234",
    commitMessage: null,
    triggerType: "cli",
    failedStep: null,
    errorMessage: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...over,
  });
  const statusBody = (over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
    deployment: row(over),
    url: null,
    previewUrl: "https://site-0123abcd-team.bycreek.com",
    ...extra,
  });
  const paths = () => mockFetch.mock.calls.map((c) => new URL(c[0] as string).pathname);

  test("resolveDeploymentId takes a full id as is, without a request", async () => {
    expect(await client.resolveDeploymentId("site", FULL)).toBe(FULL);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("resolveDeploymentId matches a short id against the list", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, [row(), row({ id: "ffff0000-x" })]));
    expect(await client.resolveDeploymentId("site", "0123abcd")).toBe(FULL);
    expect(paths()).toEqual(["/projects/site/deployments"]);
  });

  test("resolveDeploymentId: no match is a 404 not_found, two matches a 409 ambiguous_id", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, [row()]));
    await expect(client.resolveDeploymentId("site", "ffff")).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
    mockFetch.mockResolvedValue(jsonResponse(200, [row(), row({ id: "0123abcd-other" })]));
    await expect(client.resolveDeploymentId("site", "0123")).rejects.toMatchObject({
      status: 409,
      code: "ambiguous_id",
      details: { matches: [FULL, "0123abcd-other"] },
    });
  });

  test("getDeployment returns the MCP get_deployment fields", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(
        200,
        statusBody(
          { status: "failed", failedStep: "activate", errorMessage: "boom" },
          { errorCode: "CK-ACTIVATE", errorHint: "Retry" },
        ),
      ),
    );
    const view = await client.getDeployment("site", FULL);
    expect(view).toEqual({
      project: "site",
      deploymentId: FULL,
      version: 3,
      status: "failed",
      terminal: true,
      final: true,
      branch: "main",
      commitSha: "abc1234",
      triggerType: "cli",
      failedStep: "activate",
      errorMessage: "boom",
      errorCode: "CK-ACTIVATE",
      errorHint: "Retry",
      url: null,
      previewUrl: "https://site-0123abcd-team.bycreek.com",
      isProduction: false,
      createdAt: 1000,
    });
    expect(paths()).toEqual([`/projects/site/deployments/${FULL}`]);
  });

  test("toDeploymentView: the url is production's, else the preview once active", () => {
    const prod = toDeploymentView(
      "site",
      FULL,
      statusBody({ status: "active" }, { url: "https://site-team.bycreek.com" }) as never,
    );
    expect(prod).toMatchObject({ url: "https://site-team.bycreek.com", isProduction: true });
    const preview = toDeploymentView("site", FULL, statusBody({ status: "active" }) as never);
    expect(preview.url).toBe("https://site-0123abcd-team.bycreek.com");
    const building = toDeploymentView("site", FULL, statusBody() as never);
    expect(building).toMatchObject({ url: null, terminal: false, final: false });
  });

  test("waitForDeployment polls until a final status", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(200, statusBody()))
      .mockResolvedValueOnce(jsonResponse(200, statusBody({ status: "active" })));
    const seen: Array<string | null> = [];
    const result = await client.waitForDeployment("site", FULL, {
      intervalMs: 1,
      timeoutMs: 5000,
      onPoll: (v) => seen.push(v.status),
    });
    expect(result.timedOut).toBe(false);
    expect(result.view?.status).toBe("active");
    expect(seen).toEqual(["deploying", "active"]);
  });

  test("waitForDeployment stops at the budget with the last status, without throwing", async () => {
    mockFetch.mockImplementation(async () => jsonResponse(200, statusBody()));
    const result = await client.waitForDeployment("site", FULL, {
      intervalMs: 20,
      timeoutMs: 50,
    });
    expect(result.timedOut).toBe(true);
    expect(result.view).toMatchObject({ status: "deploying", terminal: false });
  });

  test("waitForDeployment uses the whole budget when it is shorter than the interval", async () => {
    mockFetch.mockImplementation(async () => jsonResponse(200, statusBody()));
    const result = await client.waitForDeployment("site", FULL, {
      intervalMs: 2000,
      timeoutMs: 150,
    });
    expect(result.timedOut).toBe(true);
    expect(result.waitedMs).toBeGreaterThanOrEqual(150);
    // A first read, then one more at the deadline.
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test("waitForDeployment: a read that hangs past the budget is a timeout, not an error", async () => {
    mockFetch.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        }),
    );
    const result = await client.waitForDeployment("site", FULL, { timeoutMs: 30 });
    expect(result).toMatchObject({ timedOut: true, view: null });
  });

  test("waitForDeployment surfaces an API error", async () => {
    mockFetch.mockResolvedValue(jsonResponse(404, { error: "not_found", message: "gone" }));
    await expect(client.waitForDeployment("site", FULL, { timeoutMs: 1000 })).rejects.toMatchObject(
      { status: 404, code: "not_found" },
    );
  });
});
