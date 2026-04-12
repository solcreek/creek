import { describe, test, expect, vi } from "vitest";
import { Hono } from "hono";
import { webDeploy } from "./routes.js";
import { buildAndDeploy, buildCacheKey, updateStatus, hashIp, type WebDeployEnv } from "./build-and-deploy.js";

// --- Test Helpers ---

function createMockKV() {
  const store = new Map<string, { value: string; ttl?: number }>();
  return {
    get: vi.fn(async (key: string) => store.get(key)?.value ?? null),
    put: vi.fn(async (key: string, value: string, opts?: { expirationTtl?: number }) => {
      store.set(key, { value, ttl: opts?.expirationTtl });
    }),
    delete: vi.fn(async (key: string) => { store.delete(key); }),
    _store: store,
  } as unknown as KVNamespace & { _store: Map<string, { value: string; ttl?: number }> };
}

function createMockQueue() {
  const messages: any[] = [];
  return {
    send: vi.fn(async (message: any) => { messages.push(message); }),
    _messages: messages,
  } as unknown as Queue & { _messages: any[] };
}

function createEnv(overrides?: Partial<WebDeployEnv>): WebDeployEnv {
  return {
    BUILD_STATUS: createMockKV(),
    WEB_BUILDS: createMockQueue(),
    ...overrides,
  };
}

function getKVStatus(env: WebDeployEnv, buildId: string) {
  const kv = env.BUILD_STATUS as any;
  const entry = kv._store.get(`build:${buildId}`);
  return entry ? JSON.parse(entry.value) : null;
}

// --- Route-level test app ---

function createApp(envOverrides?: Partial<WebDeployEnv>) {
  const env = createEnv(envOverrides);
  const app = new Hono<{ Bindings: WebDeployEnv }>();

  app.route("/web-deploy", webDeploy as any);

  async function req(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
    const init: RequestInit = {
      method,
      headers: { "Content-Type": "application/json", ...headers },
    };
    if (body) init.body = JSON.stringify(body);
    return app.request(path, init, env as any);
  }

  return { app, env, req };
}

// ============================================================================
// A. POST /web-deploy — Input validation
// ============================================================================

describe("POST /web-deploy — input validation", () => {
  test("invalid type → 400", async () => {
    const { req } = createApp();
    const res = await req("POST", "/web-deploy", { type: "invalid" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "type must be 'template' or 'repo'" });
  });

  test("template with special chars → 400", async () => {
    const { req } = createApp();
    const res = await req("POST", "/web-deploy", { type: "template", template: "../evil" });
    expect(res.status).toBe(400);
  });

  test("template without name → 400", async () => {
    const { req } = createApp();
    const res = await req("POST", "/web-deploy", { type: "template" });
    expect(res.status).toBe(400);
  });

  test("valid template → 202 with buildId + statusUrl", async () => {
    const { req } = createApp();
    const res = await req("POST", "/web-deploy", { type: "template", template: "landing" });
    expect(res.status).toBe(202);
    const json = await res.json() as { buildId: string; statusUrl: string };
    expect(json.buildId).toBeTruthy();
    expect(json.statusUrl).toMatch(/^\/web-deploy\/.+/);
  });

  test("valid repo → 202", async () => {
    const { req } = createApp();
    const res = await req("POST", "/web-deploy", { type: "repo", repo: "https://github.com/user/repo" });
    expect(res.status).toBe(202);
  });

  test("repo from unsupported host → 400", async () => {
    const { req } = createApp();
    const res = await req("POST", "/web-deploy", { type: "repo", repo: "https://evil.com/repo" });
    expect(res.status).toBe(400);
  });

  test("missing repo URL → 400", async () => {
    const { req } = createApp();
    const res = await req("POST", "/web-deploy", { type: "repo" });
    expect(res.status).toBe(400);
  });
});

// ============================================================================
// B. POST /web-deploy — CSRF
// ============================================================================

describe("POST /web-deploy — CSRF", () => {
  test("no origin → allowed", async () => {
    const { req } = createApp();
    const res = await req("POST", "/web-deploy", { type: "template", template: "landing" });
    expect(res.status).toBe(202);
  });

  test("origin: creek.dev → allowed", async () => {
    const { req } = createApp();
    const res = await req("POST", "/web-deploy", { type: "template", template: "landing" }, { Origin: "https://creek.dev" });
    expect(res.status).toBe(202);
  });

  test("origin: templates.creek.dev → allowed", async () => {
    const { req } = createApp();
    const res = await req("POST", "/web-deploy", { type: "template", template: "landing" }, { Origin: "https://templates.creek.dev" });
    expect(res.status).toBe(202);
  });

  test("origin: localhost → allowed", async () => {
    const { req } = createApp();
    const res = await req("POST", "/web-deploy", { type: "template", template: "landing" }, { Origin: "http://localhost:3000" });
    expect(res.status).toBe(202);
  });

  test("origin: evil.com → 403", async () => {
    const { req } = createApp();
    const res = await req("POST", "/web-deploy", { type: "template", template: "landing" }, { Origin: "https://evil.com" });
    expect(res.status).toBe(403);
  });

  test("origin: notcreek.dev → 403", async () => {
    const { req } = createApp();
    const res = await req("POST", "/web-deploy", { type: "template", template: "landing" }, { Origin: "https://notcreek.dev" });
    expect(res.status).toBe(403);
  });
});

// ============================================================================
// C. POST /web-deploy — Rate limiting
// ============================================================================

describe("POST /web-deploy — rate limiting", () => {
  test("first 5 requests → 202", async () => {
    const { req } = createApp();
    for (let i = 0; i < 5; i++) {
      const res = await req("POST", "/web-deploy", { type: "template", template: "landing" }, { "cf-connecting-ip": "1.2.3.4" });
      expect(res.status).toBe(202);
    }
  });

  test("6th request same IP → 429", async () => {
    const { req } = createApp();
    for (let i = 0; i < 5; i++) {
      await req("POST", "/web-deploy", { type: "template", template: "landing" }, { "cf-connecting-ip": "1.2.3.4" });
    }
    const res = await req("POST", "/web-deploy", { type: "template", template: "landing" }, { "cf-connecting-ip": "1.2.3.4" });
    expect(res.status).toBe(429);
    const json = await res.json() as { retryAfter: number };
    expect(json.retryAfter).toBe(3600);
  });

  test("different IP → independent counter", async () => {
    const { req } = createApp();
    for (let i = 0; i < 5; i++) {
      await req("POST", "/web-deploy", { type: "template", template: "landing" }, { "cf-connecting-ip": "1.2.3.4" });
    }
    const res = await req("POST", "/web-deploy", { type: "template", template: "landing" }, { "cf-connecting-ip": "5.6.7.8" });
    expect(res.status).toBe(202);
  });
});

// ============================================================================
// D. GET /web-deploy/:buildId — Status polling
// ============================================================================

describe("GET /web-deploy/:buildId — polling", () => {
  test("unknown buildId → 404", async () => {
    const { req } = createApp();
    const res = await req("GET", "/web-deploy/nonexistent");
    expect(res.status).toBe(404);
  });

  test("known buildId → returns stored status", async () => {
    const { req, env } = createApp();
    await env.BUILD_STATUS.put("build:test-123", JSON.stringify({ buildId: "test-123", status: "building" }));
    const res = await req("GET", "/web-deploy/test-123");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ buildId: "test-123", status: "building" });
  });

  test("active status includes previewUrl", async () => {
    const { req, env } = createApp();
    await env.BUILD_STATUS.put("build:test-456", JSON.stringify({
      buildId: "test-456", status: "active",
      previewUrl: "https://abc.creeksandbox.com", expiresAt: "2026-04-06T22:00:00Z",
    }));
    const res = await req("GET", "/web-deploy/test-456");
    const json = await res.json() as { status: string; previewUrl: string };
    expect(json.status).toBe("active");
    expect(json.previewUrl).toBe("https://abc.creeksandbox.com");
  });
});

// ============================================================================
// E. buildAndDeploy — Enqueues to Queue
// ============================================================================

describe("buildAndDeploy — queue dispatch", () => {
  test("template → enqueues with buildId, repoUrl, path", async () => {
    const queue = createMockQueue();
    const env = createEnv({ WEB_BUILDS: queue });

    await buildAndDeploy("b-1", { type: "template", template: "landing" }, env);

    expect(queue.send).toHaveBeenCalledOnce();
    const msg = queue._messages[0];
    expect(msg.buildId).toBe("b-1");
    expect(msg.repoUrl).toBe("https://github.com/solcreek/templates");
    expect(msg.path).toBe("landing");
  });

  test("template with data → includes templateData", async () => {
    const queue = createMockQueue();
    const env = createEnv({ WEB_BUILDS: queue });

    await buildAndDeploy("b-2", { type: "template", template: "landing", data: { title: "Hello" } }, env);

    expect(queue._messages[0].templateData).toEqual({ title: "Hello" });
  });

  test("repo → normalizes short-form to full URL", async () => {
    const queue = createMockQueue();
    const env = createEnv({ WEB_BUILDS: queue });

    await buildAndDeploy("b-3", { type: "repo", repo: "user/repo" }, env);

    expect(queue._messages[0].repoUrl).toBe("https://github.com/user/repo");
  });

  test("repo with full URL → keeps as-is", async () => {
    const queue = createMockQueue();
    const env = createEnv({ WEB_BUILDS: queue });

    await buildAndDeploy("b-4", { type: "repo", repo: "https://gitlab.com/user/repo" }, env);

    expect(queue._messages[0].repoUrl).toBe("https://gitlab.com/user/repo");
  });

  test("repo with branch → includes branch", async () => {
    const queue = createMockQueue();
    const env = createEnv({ WEB_BUILDS: queue });

    await buildAndDeploy("b-5", { type: "repo", repo: "user/repo", branch: "develop" }, env);

    expect(queue._messages[0].branch).toBe("develop");
  });
});

// ============================================================================
// F. Integration: POST → Queue → KV
// ============================================================================

describe("POST /web-deploy → queue integration", () => {
  test("successful POST writes building to KV and enqueues message", async () => {
    const { req, env } = createApp();
    const res = await req("POST", "/web-deploy", { type: "template", template: "landing" });
    expect(res.status).toBe(202);

    const { buildId } = await res.json() as { buildId: string };

    // KV has "building" status
    const status = getKVStatus(env, buildId);
    expect(status.status).toBe("building");
    expect(status.type).toBe("template");

    // Queue has the message
    const queue = env.WEB_BUILDS as any;
    expect(queue._messages).toHaveLength(1);
    expect(queue._messages[0].buildId).toBe(buildId);
    expect(queue._messages[0].path).toBe("landing");
  });
});

// ============================================================================
// G. hashIp
// ============================================================================

describe("hashIp", () => {
  test("deterministic", () => {
    expect(hashIp("1.2.3.4")).toBe(hashIp("1.2.3.4"));
  });

  test("different IPs → different hashes", () => {
    expect(hashIp("1.2.3.4")).not.toBe(hashIp("5.6.7.8"));
  });

  test("returns alphanumeric", () => {
    expect(hashIp("192.168.1.1")).toMatch(/^[a-z0-9]+$/);
  });
});

// ============================================================================
// H. updateStatus
// ============================================================================

describe("updateStatus", () => {
  test("stores JSON with buildId and updatedAt", async () => {
    const kv = createMockKV();
    await updateStatus({ BUILD_STATUS: kv }, "test-1", { status: "building" });

    const stored = JSON.parse(kv._store.get("build:test-1")!.value);
    expect(stored.buildId).toBe("test-1");
    expect(stored.status).toBe("building");
    expect(stored.updatedAt).toBeTruthy();
  });

  test("sets expirationTtl to 3600", async () => {
    const kv = createMockKV();
    await updateStatus({ BUILD_STATUS: kv }, "test-2", { status: "active" });
    expect(kv._store.get("build:test-2")!.ttl).toBe(3600);
  });
});

// ============================================================================
// I. Build cache (Phase 0)
// ============================================================================

describe("buildCacheKey", () => {
  test("builds key from repo + default branch", () => {
    expect(buildCacheKey("https://github.com/satnaing/astro-paper")).toBe(
      "webcache:repo:https://github.com/satnaing/astro-paper:main",
    );
  });

  test("includes explicit branch", () => {
    expect(buildCacheKey("https://github.com/user/repo", "develop")).toBe(
      "webcache:repo:https://github.com/user/repo:develop",
    );
  });

  test("includes path when provided", () => {
    expect(
      buildCacheKey("https://github.com/vitejs/vite", "main", "docs"),
    ).toBe("webcache:repo:https://github.com/vitejs/vite:main:docs");
  });

  test("null branch defaults to main", () => {
    expect(buildCacheKey("https://github.com/o/r", null)).toBe(
      "webcache:repo:https://github.com/o/r:main",
    );
  });
});

describe("POST /web-deploy build cache", () => {
  test("returns instantly when cache hit with sufficient remaining TTL", async () => {
    const kv = createMockKV();

    // Pre-populate cache with an active sandbox expiring in 40 min
    const cacheKey = buildCacheKey("https://github.com/satnaing/astro-paper");
    const expiresAt = new Date(Date.now() + 40 * 60 * 1000).toISOString();
    kv._store.set(cacheKey, {
      value: JSON.stringify({
        sandboxId: "cached01",
        previewUrl: "https://cached01.creeksandbox.com",
        expiresAt,
      }),
    });

    const { req, env } = createApp({ BUILD_STATUS: kv as any });
    const res = await req("POST", "/web-deploy", {
      type: "repo",
      repo: "https://github.com/satnaing/astro-paper",
    });

    expect(res.status).toBe(202);
    const body = await res.json() as any;

    // KV should have status "active" with cacheHit=true
    const status = JSON.parse(kv._store.get(`build:${body.buildId}`)!.value);
    expect(status.status).toBe("active");
    expect(status.cacheHit).toBe(true);
    expect(status.sandboxId).toBe("cached01");
    expect(status.previewUrl).toBe("https://cached01.creeksandbox.com");

    // Queue should NOT have any messages — build was skipped
    const queue = env.WEB_BUILDS as any;
    expect(queue._messages).toHaveLength(0);
  });

  test("falls through to normal build when cache is expired", async () => {
    const kv = createMockKV();

    // Cache entry with sandbox expiring in 3 min (< 5 min threshold)
    const cacheKey = buildCacheKey("https://github.com/satnaing/astro-paper");
    const expiresAt = new Date(Date.now() + 3 * 60 * 1000).toISOString();
    kv._store.set(cacheKey, {
      value: JSON.stringify({
        sandboxId: "expiring",
        previewUrl: "https://expiring.creeksandbox.com",
        expiresAt,
      }),
    });

    const { req, env } = createApp({ BUILD_STATUS: kv as any });
    const res = await req("POST", "/web-deploy", {
      type: "repo",
      repo: "https://github.com/satnaing/astro-paper",
    });

    expect(res.status).toBe(202);
    const body = await res.json() as any;

    // Should have enqueued a build (not cache hit)
    const status = JSON.parse(kv._store.get(`build:${body.buildId}`)!.value);
    expect(status.status).toBe("building");
    expect(status.cacheHit).toBeUndefined();

    // Queue should have the build message
    const queue = env.WEB_BUILDS as any;
    expect(queue._messages).toHaveLength(1);
  });

  test("falls through when no cache entry exists", async () => {
    const { req, env } = createApp();
    const res = await req("POST", "/web-deploy", {
      type: "repo",
      repo: "https://github.com/satnaing/astro-paper",
    });

    expect(res.status).toBe(202);
    const queue = env.WEB_BUILDS as any;
    expect(queue._messages).toHaveLength(1);
  });

  test("does not cache template deploys", async () => {
    const kv = createMockKV();
    // Even if someone put a "webcache:..." entry for a template, the
    // cache check only runs for type=repo
    const { req, env } = createApp({ BUILD_STATUS: kv as any });
    const res = await req("POST", "/web-deploy", {
      type: "template",
      template: "landing",
    });
    expect(res.status).toBe(202);
    const queue = env.WEB_BUILDS as any;
    expect(queue._messages).toHaveLength(1);
  });

  test("cache hit does NOT consume rate limit", async () => {
    const kv = createMockKV();

    const cacheKey = buildCacheKey("https://github.com/o/r");
    const expiresAt = new Date(Date.now() + 40 * 60 * 1000).toISOString();
    kv._store.set(cacheKey, {
      value: JSON.stringify({
        sandboxId: "c1",
        previewUrl: "https://c1.creeksandbox.com",
        expiresAt,
      }),
    });

    const { req } = createApp({ BUILD_STATUS: kv as any });

    // Make 10 cache-hit requests — should NOT trigger rate limit
    for (let i = 0; i < 10; i++) {
      const res = await req("POST", "/web-deploy", {
        type: "repo",
        repo: "https://github.com/o/r",
      });
      expect(res.status).toBe(202);
    }
  });
});
