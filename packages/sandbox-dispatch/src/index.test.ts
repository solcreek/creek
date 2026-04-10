import { describe, test, expect, beforeEach, vi } from "vitest";
import worker from "./index.js";

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
