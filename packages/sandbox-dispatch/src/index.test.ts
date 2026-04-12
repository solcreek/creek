import { describe, test, expect, beforeEach, vi } from "vitest";
import worker, { deriveCacheControl, extractPreloadLinks } from "./index.js";

interface MockSandboxRow {
  id: string;
  status: string;
  expiresAt: number;
  previewHost: string;
  deployDurationMs: number | null;
}

interface ExecutedQuery {
  sql: string;
  args: unknown[];
}

function createMockD1(rows: Record<string, MockSandboxRow | null> = {}) {
  const executed: ExecutedQuery[] = [];

  return {
    executed,
    db: {
      prepare(sql: string) {
        let boundArgs: unknown[] = [];
        return {
          bind(...args: unknown[]) {
            boundArgs = args;
            return this;
          },
          async first<T>(): Promise<T | null> {
            executed.push({ sql, args: boundArgs });
            const id = boundArgs[0] as string;
            return (rows[id] ?? null) as T | null;
          },
        };
      },
    },
  };
}

function createMockKV() {
  const store = new Map<string, string>();
  return {
    store,
    kv: {
      async get(key: string) {
        return store.get(key) ?? null;
      },
      async put(key: string, value: string) {
        store.set(key, value);
      },
    },
  };
}

function createMockDispatcher(scriptHandlers: Record<string, (req: Request) => Promise<Response>>) {
  return {
    get(name: string) {
      return {
        async fetch(req: Request): Promise<Response> {
          const handler = scriptHandlers[name];
          if (!handler) throw new Error(`Worker not found: ${name}`);
          return handler(req);
        },
      };
    },
  };
}

function createEnv(opts: {
  d1Rows?: Record<string, MockSandboxRow | null>;
  scriptHandlers?: Record<string, (req: Request) => Promise<Response>>;
}) {
  const d1 = createMockD1(opts.d1Rows ?? {});
  const kv = createMockKV();
  const dispatcher = createMockDispatcher(opts.scriptHandlers ?? {});
  return {
    env: {
      DISPATCHER: dispatcher,
      DB: d1.db as any,
      KV: kv.kv as any,
      SANDBOX_DOMAIN: "creeksandbox.com",
    },
    d1,
    kv,
  };
}

describe("sandbox-dispatch worker", () => {
  test("returns 404 for unknown hostname", async () => {
    const { env } = createEnv({});
    const res = await worker.fetch(new Request("https://example.com/"), env);
    expect(res.status).toBe(404);
  });

  test("returns 404 for invalid sandbox id (contains dot)", async () => {
    const { env } = createEnv({});
    const res = await worker.fetch(new Request("https://foo.bar.creeksandbox.com/"), env);
    expect(res.status).toBe(404);
  });

  test("returns 404 when sandbox not in DB", async () => {
    const { env, d1 } = createEnv({});
    const res = await worker.fetch(new Request("https://abc12345.creeksandbox.com/"), env);
    expect(res.status).toBe(404);
    // Verify we queried the deployments table (not the old "sandbox" name)
    expect(d1.executed[0].sql).toContain("FROM deployments");
    expect(d1.executed[0].sql).not.toContain("FROM sandbox");
  });

  test("dispatches to user worker when sandbox is active", async () => {
    const sandboxId = "abc12345";
    const { env } = createEnv({
      d1Rows: {
        [sandboxId]: {
          id: sandboxId,
          status: "active",
          expiresAt: Date.now() + 60_000,
          previewHost: `${sandboxId}.creeksandbox.com`,
          deployDurationMs: 9000,
        },
      },
      scriptHandlers: {
        [`${sandboxId}-sandbox`]: async () =>
          new Response("<html><body>hi</body></html>", {
            headers: { "Content-Type": "text/html" },
          }),
      },
    });

    const res = await worker.fetch(new Request(`https://${sandboxId}.creeksandbox.com/`), env);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<body>hi");
    // Banner should be injected
    expect(body).toContain("creek-sb-");
  });

  test("returns 410 when sandbox is expired", async () => {
    const sandboxId = "expired1";
    const { env } = createEnv({
      d1Rows: {
        [sandboxId]: {
          id: sandboxId,
          status: "active",
          expiresAt: Date.now() - 60_000, // expired
          previewHost: `${sandboxId}.creeksandbox.com`,
          deployDurationMs: 9000,
        },
      },
    });

    const res = await worker.fetch(new Request(`https://${sandboxId}.creeksandbox.com/`), env);
    expect(res.status).toBe(410);
  });

  test("returns 451 when sandbox is blocked", async () => {
    const sandboxId = "blocked1";
    const { env } = createEnv({
      d1Rows: {
        [sandboxId]: {
          id: sandboxId,
          status: "blocked",
          expiresAt: Date.now() + 60_000,
          previewHost: `${sandboxId}.creeksandbox.com`,
          deployDurationMs: 9000,
        },
      },
    });

    const res = await worker.fetch(new Request(`https://${sandboxId}.creeksandbox.com/`), env);
    expect(res.status).toBe(451);
  });

  test("returns 503 when sandbox is still building", async () => {
    const sandboxId = "build123";
    const { env } = createEnv({
      d1Rows: {
        [sandboxId]: {
          id: sandboxId,
          status: "building",
          expiresAt: Date.now() + 60_000,
          previewHost: `${sandboxId}.creeksandbox.com`,
          deployDurationMs: null,
        },
      },
    });

    const res = await worker.fetch(new Request(`https://${sandboxId}.creeksandbox.com/`), env);
    expect(res.status).toBe(503);
  });
});

describe("deriveCacheControl", () => {
  test("fingerprinted Astro build path → 1 year immutable", () => {
    expect(
      deriveCacheControl("/_astro/about.x6foEjjJ.css", "text/css; charset=utf-8"),
    ).toBe("public, max-age=31536000, immutable");
  });

  test("fingerprinted Next.js static path → 1 year immutable", () => {
    expect(
      deriveCacheControl("/_next/static/chunks/abc123.js", "text/javascript"),
    ).toBe("public, max-age=31536000, immutable");
  });

  test("fingerprinted SvelteKit immutable path → 1 year immutable", () => {
    expect(
      deriveCacheControl("/_app/immutable/chunks/entry.XYZ.js", "text/javascript"),
    ).toBe("public, max-age=31536000, immutable");
  });

  test("fingerprinted Nuxt path → 1 year immutable", () => {
    expect(
      deriveCacheControl("/_nuxt/entry.abc.js", "text/javascript"),
    ).toBe("public, max-age=31536000, immutable");
  });

  test("HTML response → 60 second cache", () => {
    expect(
      deriveCacheControl("/", "text/html; charset=utf-8"),
    ).toBe("public, max-age=60, s-maxage=60");
    expect(
      deriveCacheControl("/about", "text/html"),
    ).toBe("public, max-age=60, s-maxage=60");
  });

  test("non-fingerprinted static asset → 1 hour cache", () => {
    expect(
      deriveCacheControl("/favicon.svg", "image/svg+xml"),
    ).toBe("public, max-age=3600, s-maxage=3600");
    expect(
      deriveCacheControl("/robots.txt", "text/plain"),
    ).toBe("public, max-age=3600, s-maxage=3600");
    expect(
      deriveCacheControl("/images/hero.png", "image/png"),
    ).toBe("public, max-age=3600, s-maxage=3600");
  });

  test("fingerprinted path classification beats content-type HTML fallback", () => {
    // If a hashed HTML fragment ever lived under /_astro/, still treat
    // it as immutable — the content hash guarantees freshness.
    expect(
      deriveCacheControl("/_astro/page.abc.html", "text/html"),
    ).toBe("public, max-age=31536000, immutable");
  });

  test("path prefix matching is anchored — /fake/_astro/ does NOT match", () => {
    expect(
      deriveCacheControl("/fake/_astro/abc.css", "text/css"),
    ).toBe("public, max-age=3600, s-maxage=3600");
  });
});

describe("Cache-Control on dispatched responses", () => {
  async function dispatch(opts: {
    sandboxId: string;
    pathname: string;
    contentType: string;
    body: string;
  }) {
    const { env } = createEnv({
      d1Rows: {
        [opts.sandboxId]: {
          id: opts.sandboxId,
          status: "active",
          expiresAt: Date.now() + 60_000,
          previewHost: `${opts.sandboxId}.creeksandbox.com`,
          deployDurationMs: 9000,
        },
      },
      scriptHandlers: {
        [`${opts.sandboxId}-sandbox`]: async () =>
          new Response(opts.body, {
            headers: { "Content-Type": opts.contentType },
          }),
      },
    });
    return worker.fetch(
      new Request(`https://${opts.sandboxId}.creeksandbox.com${opts.pathname}`),
      env,
    );
  }

  test("HTML response gets short TTL and sandbox scope headers", async () => {
    const res = await dispatch({
      sandboxId: "abc12345",
      pathname: "/",
      contentType: "text/html",
      body: "<html><body>hi</body></html>",
    });
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60, s-maxage=60");
    expect(res.headers.get("Vary")).toBe("Host");
    expect(res.headers.get("X-Sandbox-Id")).toBe("abc12345");
  });

  test("fingerprinted CSS asset gets 1-year immutable", async () => {
    const res = await dispatch({
      sandboxId: "abc12345",
      pathname: "/_astro/about.x6foEjjJ.css",
      contentType: "text/css",
      body: "body{color:red}",
    });
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(res.headers.get("Vary")).toBe("Host");
    expect(res.headers.get("X-Sandbox-Id")).toBe("abc12345");
  });

  test("non-fingerprinted favicon gets 1 hour cache", async () => {
    const res = await dispatch({
      sandboxId: "abc12345",
      pathname: "/favicon.svg",
      contentType: "image/svg+xml",
      body: "<svg/>",
    });
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=3600, s-maxage=3600",
    );
  });
});

describe("extractPreloadLinks", () => {
  test("extracts a single stylesheet link", () => {
    const html = `<html><head><link rel="stylesheet" href="/_astro/a.css"></head></html>`;
    expect(extractPreloadLinks(html)).toEqual([
      "</_astro/a.css>; rel=preload; as=style",
    ]);
  });

  test("extracts a single module script", () => {
    const html = `<html><head><script type="module" src="/_astro/client.js"></script></head></html>`;
    expect(extractPreloadLinks(html)).toEqual([
      "</_astro/client.js>; rel=preload; as=script",
    ]);
  });

  test("extracts multiple stylesheets and scripts together", () => {
    const html = `
      <link rel="stylesheet" href="/_astro/a.css" data-precedence="next"/>
      <link rel="stylesheet" href="/_astro/b.css"/>
      <script type="module" src="/_astro/router.js"></script>
    `;
    const hints = extractPreloadLinks(html);
    expect(hints).toContain("</_astro/a.css>; rel=preload; as=style");
    expect(hints).toContain("</_astro/b.css>; rel=preload; as=style");
    expect(hints).toContain("</_astro/router.js>; rel=preload; as=script");
    expect(hints).toHaveLength(3);
  });

  test("accepts single-quoted attribute values", () => {
    const html = `<link rel='stylesheet' href='/a.css'>`;
    expect(extractPreloadLinks(html)).toEqual([
      "</a.css>; rel=preload; as=style",
    ]);
  });

  test("skips cross-origin URLs", () => {
    const html = `
      <link rel="stylesheet" href="https://cdn.example.com/a.css">
      <link rel="stylesheet" href="//cdn.example.com/b.css">
      <link rel="stylesheet" href="/local.css">
    `;
    expect(extractPreloadLinks(html)).toEqual([
      "</local.css>; rel=preload; as=style",
    ]);
  });

  test("skips relative paths without leading slash", () => {
    const html = `
      <link rel="stylesheet" href="./a.css">
      <link rel="stylesheet" href="b.css">
      <link rel="stylesheet" href="/c.css">
    `;
    expect(extractPreloadLinks(html)).toEqual([
      "</c.css>; rel=preload; as=style",
    ]);
  });

  test("skips non-module classic scripts", () => {
    const html = `
      <script src="/classic.js"></script>
      <script type="module" src="/mod.js"></script>
    `;
    expect(extractPreloadLinks(html)).toEqual([
      "</mod.js>; rel=preload; as=script",
    ]);
  });

  test("skips <link rel='preload'> and other rel values", () => {
    const html = `
      <link rel="preload" href="/font.woff2" as="font">
      <link rel="icon" href="/favicon.svg">
      <link rel="stylesheet" href="/style.css">
    `;
    expect(extractPreloadLinks(html)).toEqual([
      "</style.css>; rel=preload; as=style",
    ]);
  });

  test("caps the number of hints at 20", () => {
    // Build HTML with 25 stylesheet links
    const links = Array.from(
      { length: 25 },
      (_, i) => `<link rel="stylesheet" href="/a${i}.css">`,
    ).join("\n");
    const hints = extractPreloadLinks(links);
    expect(hints).toHaveLength(20);
  });

  test("returns empty array when HTML has no preloadable assets", () => {
    expect(extractPreloadLinks("<html><body>hi</body></html>")).toEqual([]);
    expect(extractPreloadLinks("")).toEqual([]);
  });

  test("idempotent — multiple calls return identical results", () => {
    const html = `<link rel="stylesheet" href="/a.css">`;
    const first = extractPreloadLinks(html);
    const second = extractPreloadLinks(html);
    expect(first).toEqual(second);
  });
});

describe("Link header on dispatched HTML responses", () => {
  async function dispatchHtml(html: string, sandboxId = "abc12345") {
    const { env } = createEnv({
      d1Rows: {
        [sandboxId]: {
          id: sandboxId,
          status: "active",
          expiresAt: Date.now() + 60_000,
          previewHost: `${sandboxId}.creeksandbox.com`,
          deployDurationMs: 9000,
        },
      },
      scriptHandlers: {
        [`${sandboxId}-sandbox`]: async () =>
          new Response(html, { headers: { "Content-Type": "text/html" } }),
      },
    });
    return worker.fetch(
      new Request(`https://${sandboxId}.creeksandbox.com/`),
      env,
    );
  }

  test("Link header is set with preload hints for Astro-style HTML", async () => {
    const html = `
      <!DOCTYPE html>
      <html><head>
        <link rel="stylesheet" href="/_astro/about.x6foEjjJ.css">
        <script type="module" src="/_astro/ClientRouter.QW52Ox2j.js"></script>
      </head><body>hi</body></html>
    `;
    const res = await dispatchHtml(html);
    const link = res.headers.get("Link");
    expect(link).not.toBeNull();
    expect(link).toContain("</_astro/about.x6foEjjJ.css>; rel=preload; as=style");
    expect(link).toContain(
      "</_astro/ClientRouter.QW52Ox2j.js>; rel=preload; as=script",
    );
  });

  test("Link header is absent when HTML has no preloadable assets", async () => {
    const res = await dispatchHtml("<html><body>plain</body></html>");
    expect(res.headers.get("Link")).toBeNull();
  });
});
