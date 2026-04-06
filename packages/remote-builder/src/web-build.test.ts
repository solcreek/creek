import { handleWebBuild } from "./web-build.js";

// --- Test Helpers ---

function createMockKV() {
  const store = new Map<string, { value: string; ttl?: number }>();
  return {
    get: vi.fn(async (key: string) => store.get(key)?.value ?? null),
    put: vi.fn(async (key: string, value: string, opts?: { expirationTtl?: number }) => {
      store.set(key, { value, ttl: opts?.expirationTtl });
    }),
    _store: store,
  } as unknown as KVNamespace & { _store: Map<string, { value: string; ttl?: number }> };
}

function createEnv(overrides?: Partial<{ BUILD_STATUS: KVNamespace; SANDBOX_API_URL: string; INTERNAL_SECRET: string }>) {
  return {
    BUILD_STATUS: createMockKV(),
    SANDBOX_API_URL: "https://sandbox-api.creek.dev",
    INTERNAL_SECRET: "test-secret",
    ...overrides,
  };
}

function getStatus(env: any, buildId: string) {
  const entry = env.BUILD_STATUS._store.get(`build:${buildId}`);
  return entry ? JSON.parse(entry.value) : null;
}

function successBuild(assets: Record<string, string> = { "index.html": "PCFET0N..." }) {
  return async () => ({
    success: true,
    config: { framework: "vite", renderMode: "spa" },
    bundle: {
      manifest: { assets: Object.keys(assets), hasWorker: false, entrypoint: null, renderMode: "spa" },
      assets,
      serverFiles: undefined,
    },
  });
}

function workerBuild() {
  return async () => ({
    success: true,
    config: { framework: null, renderMode: "worker" },
    bundle: {
      manifest: { assets: [], hasWorker: true, entrypoint: "worker.js", renderMode: "worker" },
      assets: {},
      serverFiles: { "worker.js": "ZXhwb3J0IGRlZmF1bHQ=" },
    },
  });
}

function emptyBuild() {
  return async () => ({
    success: true,
    config: { framework: null, renderMode: "spa" },
    bundle: { manifest: { assets: [] }, assets: {}, serverFiles: undefined },
  });
}

function failedBuild(error: string) {
  return async () => ({ success: false, error, message: error });
}

function throwingBuild(error: string) {
  return async () => { throw new Error(error); };
}

// ============================================================================
// Happy path
// ============================================================================

describe("handleWebBuild — happy path", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("build + sandbox active → KV status active with previewUrl", async () => {
    const env = createEnv();
    globalThis.fetch = vi.fn(async () =>
      Response.json({ sandboxId: "sb-1", status: "active", previewUrl: "https://sb-1.creeksandbox.com", statusUrl: "https://sandbox-api.creek.dev/api/sandbox/sb-1/status", expiresAt: "2026-04-06T23:00:00Z" })
    ) as any;

    await handleWebBuild({ buildId: "b-1", repoUrl: "https://github.com/solcreek/templates", path: "landing" }, env, successBuild());

    const s = getStatus(env, "b-1");
    expect(s.status).toBe("active");
    expect(s.previewUrl).toBe("https://sb-1.creeksandbox.com");
    expect(s.sandboxId).toBe("sb-1");
  });

  test("build + sandbox queued → polls until active → KV status active", async () => {
    const env = createEnv();
    const origSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation((fn: any) => origSetTimeout(fn, 0));

    let callCount = 0;
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes("/api/sandbox/deploy")) {
        return Response.json({ sandboxId: "sb-2", status: "queued", previewUrl: "https://sb-2.creeksandbox.com", statusUrl: "https://sandbox-api.creek.dev/api/sandbox/sb-2/status", expiresAt: "2026-04-06T23:00:00Z" });
      }
      if (urlStr.includes("/status")) {
        callCount++;
        return Response.json({ status: callCount >= 3 ? "active" : "queued" });
      }
      return new Response("", { status: 404 });
    }) as any;

    await handleWebBuild({ buildId: "b-2", repoUrl: "https://github.com/solcreek/templates", path: "landing" }, env, successBuild());

    vi.restoreAllMocks();

    const s = getStatus(env, "b-2");
    expect(s.status).toBe("active");
    expect(callCount).toBeGreaterThanOrEqual(3);
  });
});

// ============================================================================
// Build failures
// ============================================================================

describe("handleWebBuild — build failures", () => {
  test("build returns success: false → KV failed", async () => {
    const env = createEnv();
    await handleWebBuild({ buildId: "b-fail", repoUrl: "..." }, env, failedBuild("npm install failed"));

    const s = getStatus(env, "b-fail");
    expect(s.status).toBe("failed");
    expect(s.error).toContain("npm install failed");
    expect(s.failedStep).toBe("build");
  });

  test("build throws → KV failed", async () => {
    const env = createEnv();
    await handleWebBuild({ buildId: "b-throw", repoUrl: "..." }, env, throwingBuild("Container crashed"));

    const s = getStatus(env, "b-throw");
    expect(s.status).toBe("failed");
    expect(s.error).toContain("Container crashed");
  });
});

// ============================================================================
// Bundle validation
// ============================================================================

describe("handleWebBuild — bundle validation", () => {
  test("Worker project (empty assets + serverFiles) → clear error", async () => {
    const env = createEnv();
    await handleWebBuild({ buildId: "b-worker", repoUrl: "..." }, env, workerBuild());

    const s = getStatus(env, "b-worker");
    expect(s.status).toBe("failed");
    expect(s.error).toContain("authenticated deployment");
    expect(s.error).toContain("creek deploy");
  });

  test("empty build (no assets, no serverFiles) → clear error", async () => {
    const env = createEnv();
    await handleWebBuild({ buildId: "b-empty", repoUrl: "..." }, env, emptyBuild());

    const s = getStatus(env, "b-empty");
    expect(s.status).toBe("failed");
    expect(s.error).toContain("no output files");
  });
});

// ============================================================================
// Sandbox deploy failures
// ============================================================================

describe("handleWebBuild — sandbox failures", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("sandbox returns 400 → KV failed with error message", async () => {
    const env = createEnv();
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "validation", message: "Bundle too large" }), { status: 400 })
    ) as any;

    await handleWebBuild({ buildId: "b-400", repoUrl: "..." }, env, successBuild());

    const s = getStatus(env, "b-400");
    expect(s.status).toBe("failed");
    expect(s.error).toContain("Deploy failed");
    expect(s.failedStep).toBe("deploy");
  });

  test("sandbox returns 429 (rate limited) → KV failed", async () => {
    const env = createEnv();
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "rate_limited", message: "3/hr limit" }), { status: 429 })
    ) as any;

    await handleWebBuild({ buildId: "b-429", repoUrl: "..." }, env, successBuild());

    const s = getStatus(env, "b-429");
    expect(s.status).toBe("failed");
    expect(s.error).toContain("rate_limited");
  });

  test("sandbox fetch throws (network error) → KV failed", async () => {
    const env = createEnv();
    globalThis.fetch = vi.fn(async () => { throw new Error("DNS resolution failed"); }) as any;

    await handleWebBuild({ buildId: "b-net", repoUrl: "..." }, env, successBuild());

    const s = getStatus(env, "b-net");
    expect(s.status).toBe("failed");
    expect(s.error).toContain("unreachable");
    expect(s.failedStep).toBe("deploy");
  });
});

// ============================================================================
// KV state progression
// ============================================================================

describe("handleWebBuild — state progression", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("writes deploying before sandbox call, then active after", async () => {
    const env = createEnv();
    const statusHistory: string[] = [];
    const origPut = (env.BUILD_STATUS as any).put;
    (env.BUILD_STATUS as any).put = vi.fn(async (key: string, value: string, opts?: any) => {
      if (key.startsWith("build:")) statusHistory.push(JSON.parse(value).status);
      return origPut(key, value, opts);
    });

    globalThis.fetch = vi.fn(async () =>
      Response.json({ sandboxId: "sb-prog", status: "active", previewUrl: "https://sb-prog.creeksandbox.com", statusUrl: "...", expiresAt: "..." })
    ) as any;

    await handleWebBuild({ buildId: "b-prog", repoUrl: "..." }, env, successBuild());

    expect(statusHistory).toEqual(["deploying", "active"]);
  });

  test("all KV writes have TTL 3600", async () => {
    const env = createEnv();
    globalThis.fetch = vi.fn(async () =>
      Response.json({ sandboxId: "sb-ttl", status: "active", previewUrl: "...", statusUrl: "...", expiresAt: "..." })
    ) as any;

    await handleWebBuild({ buildId: "b-ttl", repoUrl: "..." }, env, successBuild());

    const putCalls = (env.BUILD_STATUS.put as any).mock.calls;
    for (const call of putCalls) {
      expect(call[2]).toEqual({ expirationTtl: 3600 });
    }
  });

  test("all KV writes include buildId and updatedAt", async () => {
    const env = createEnv();
    await handleWebBuild({ buildId: "b-meta", repoUrl: "..." }, env, failedBuild("test"));

    const s = getStatus(env, "b-meta");
    expect(s.buildId).toBe("b-meta");
    expect(s.updatedAt).toBeTruthy();
  });
});
