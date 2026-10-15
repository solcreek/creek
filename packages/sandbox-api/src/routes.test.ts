import { describe, expect, it } from "vitest";
import { routes } from "./routes";

// The declared main module is checked right after the body parses, before
// rate limiting or any binding is touched — so these requests need no env.
async function post(body: unknown) {
  const res = await routes.request(
    "/deploy",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    {},
  );
  return { status: res.status, json: (await res.json()) as { error: string; message: string } };
}

const workerBundle = (mainModule: unknown) => ({
  manifest: {
    assets: [],
    hasWorker: true,
    entrypoint: null,
    renderMode: "worker",
    mainModule,
  },
  assets: {},
  serverFiles: { "worker.js": btoa("export default {}") },
  source: "cli",
});

describe("POST /deploy — manifest.mainModule", () => {
  it("rejects a declared main module that is not among the server files", async () => {
    const res = await post(workerBundle("index.js"));
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("validation");
    expect(res.json.message).toContain('"index.js" is not one of the uploaded server files');
  });

  it("rejects an empty or non-string declaration", async () => {
    expect((await post(workerBundle(""))).status).toBe(400);
    expect((await post(workerBundle(7))).json.message).toContain("non-empty string");
  });
});

// --- DELETE /:id — only the creator may delete ---

async function ipHashOf(ip: string, salt = "test-salt"): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip + salt));
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

/** Just enough D1 / R2 for the delete route: one sandbox row. */
function deleteEnv(row: { id: string; ipHash: string; status: string }) {
  const updates: unknown[][] = [];
  return {
    updates,
    env: {
      INTERNAL_SECRET: "internal",
      IP_HASH_SALT: "test-salt",
      DB: {
        prepare: (sql: string) => ({
          bind: (...args: unknown[]) => ({
            first: async () => (args[0] === row.id ? row : null),
            run: async () => {
              if (sql.startsWith("UPDATE")) updates.push(args);
              return { meta: { changes: 1 } };
            },
          }),
        }),
      },
      ASSETS: { delete: async () => undefined },
    },
  };
}

describe("DELETE /:id — creator check", () => {
  it("accepts the creator's IP forwarded by a trusted internal service (the MCP server)", async () => {
    // POST /deploy through the MCP server hashed the forwarded client IP;
    // the MCP worker itself connects from a Cloudflare address.
    const { env, updates } = deleteEnv({
      id: "sb1",
      ipHash: await ipHashOf("203.0.113.7"),
      status: "active",
    });
    const res = await routes.request(
      "/sb1",
      {
        method: "DELETE",
        headers: {
          "cf-connecting-ip": "2a06:98c0:3600::103",
          "x-forwarded-for": "203.0.113.7",
          "x-internal-secret": "internal",
        },
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(updates).toHaveLength(1);
  });

  it("ignores X-Forwarded-For without the internal secret", async () => {
    const { env, updates } = deleteEnv({
      id: "sb1",
      ipHash: await ipHashOf("203.0.113.7"),
      status: "active",
    });
    const res = await routes.request(
      "/sb1",
      {
        method: "DELETE",
        headers: { "cf-connecting-ip": "198.51.100.1", "x-forwarded-for": "203.0.113.7" },
      },
      env,
    );
    expect(res.status).toBe(403);
    expect(updates).toHaveLength(0);
  });

  it("still accepts a direct caller by its connecting IP", async () => {
    const { env } = deleteEnv({
      id: "sb1",
      ipHash: await ipHashOf("198.51.100.1"),
      status: "active",
    });
    const res = await routes.request(
      "/sb1",
      { method: "DELETE", headers: { "cf-connecting-ip": "198.51.100.1" } },
      env,
    );
    expect(res.status).toBe(200);
  });
});

// --- POST /deploy — per-IP rate limit for the MCP server's clients ---

/**
 * A DB whose rate-limit count says the window is full. Any other query
 * throws, so a request that is not limited stops right after the check
 * (as a 500), which is all these tests need.
 */
function fullWindowEnv() {
  const counted: unknown[][] = [];
  return {
    counted,
    env: {
      INTERNAL_SECRET: "internal",
      IP_HASH_SALT: "test-salt",
      DB: {
        prepare: (sql: string) => ({
          bind: (...args: unknown[]) => ({
            first: async () => {
              if (!sql.includes("COUNT(*)")) throw new Error("past the rate limit");
              counted.push(args);
              return { count: 100, oldest: Date.now() };
            },
            run: async () => {
              throw new Error("past the rate limit");
            },
          }),
        }),
      },
    },
  };
}

async function deployAs(headers: Record<string, string>, source = "mcp") {
  const { env, counted } = fullWindowEnv();
  const res = await routes.request(
    "/deploy",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ assets: { "index.html": btoa("<h1>hi</h1>") }, source }),
    },
    env,
  );
  return { status: res.status, counted };
}

const MCP_HEADERS = {
  "cf-connecting-ip": "2a06:98c0:3600::103",
  "x-forwarded-for": "203.0.113.7",
  "x-internal-secret": "internal",
  "x-creek-rate-limit": "client-ip",
};

describe("POST /deploy — rate limit for forwarded clients", () => {
  it("limits the MCP server's deploys per forwarded client IP", async () => {
    const { status, counted } = await deployAs(MCP_HEADERS);
    expect(status).toBe(429);
    expect(counted[0][0]).toBe(await ipHashOf("203.0.113.7"));
  });

  it("keeps other trusted internal callers (remote-builder) exempt", async () => {
    const { status, counted } = await deployAs({
      "x-internal-secret": "internal",
      "x-forwarded-for": "198.51.100.9",
    });
    expect(status).not.toBe(429);
    expect(counted).toHaveLength(0);
  });

  it("keeps the MCP demo deploy (X-Creek-Demo from a trusted caller) exempt", async () => {
    const { status, counted } = await deployAs({ ...MCP_HEADERS, "x-creek-demo": "1" });
    expect(status).not.toBe(429);
    expect(counted).toHaveLength(0);
  });

  it("ignores the opt-in without the internal secret: the connecting IP is limited", async () => {
    const { status, counted } = await deployAs({
      "cf-connecting-ip": "198.51.100.1",
      "x-forwarded-for": "203.0.113.7",
      "x-creek-rate-limit": "client-ip",
    });
    expect(status).toBe(429);
    expect(counted[0][0]).toBe(await ipHashOf("198.51.100.1"));
  });

  it("ignores X-Creek-Demo from a direct caller", async () => {
    const { status } = await deployAs({ "cf-connecting-ip": "198.51.100.1", "x-creek-demo": "1" });
    expect(status).toBe(429);
  });
});

// --- Demo status is the server's decision, never the body's ---

/**
 * A deployments table in memory. The rate-limit count is evaluated from its
 * SQL: rows of this ipHash in the window, minus the `source != ...` exclusion
 * (a literal or a bound value). INSERTs are recorded; anything else throws,
 * so a request ends right after its insert.
 */
function tableEnv(rows: Array<{ ipHash: string; source: string; createdAt: number }>) {
  const inserted: unknown[][] = [];
  return {
    inserted,
    env: {
      INTERNAL_SECRET: "internal",
      IP_HASH_SALT: "test-salt",
      SANDBOX_DOMAIN: "creeksandbox.test",
      DB: {
        prepare: (sql: string) => ({
          bind: (...args: unknown[]) => ({
            first: async () => {
              if (!sql.includes("COUNT(*)")) throw new Error("unexpected query");
              const literal = /source != '([^']+)'/.exec(sql)?.[1];
              const excluded = literal ?? (sql.includes("source != ?") ? args[1] : undefined);
              const since = args[args.length - 1] as number;
              const matching = rows.filter(
                (r) => r.ipHash === args[0] && r.source !== excluded && r.createdAt > since,
              );
              return {
                count: matching.length,
                oldest: matching.length ? Math.min(...matching.map((r) => r.createdAt)) : null,
              };
            },
            run: async () => {
              if (sql.startsWith("INSERT INTO deployments")) {
                inserted.push(args);
                throw new Error("stop after the insert");
              }
              throw new Error("unexpected query");
            },
          }),
        }),
      },
    },
  };
}

async function deployWith(
  env: unknown,
  headers: Record<string, string>,
  body: Record<string, unknown> = {},
) {
  const res = await routes.request(
    "/deploy",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ assets: { "index.html": btoa("<h1>hi</h1>") }, ...body }),
    },
    env as never,
  );
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}

describe("POST /deploy — demo status comes from the server, not the body", () => {
  it("refuses the reserved source mcp-demo in a body, even from a trusted caller", async () => {
    for (const headers of [{ "cf-connecting-ip": "198.51.100.1" }, MCP_HEADERS]) {
      const { env, inserted } = tableEnv([]);
      const res = await deployWith(env, headers, { source: "mcp-demo" });
      expect(res.status).toBe(400);
      expect(res.json.message).toContain("reserved");
      expect(inserted).toHaveLength(0);
    }
  });

  it("counts a direct caller that labels its deploy cli-demo", async () => {
    const ip = "198.51.100.1";
    const now = Date.now();
    const full = Array.from({ length: 15 }, (_, i) => ({
      ipHash: "",
      source: "cli",
      createdAt: now - 1000 - i,
    }));
    for (const r of full) r.ipHash = await ipHashOf(ip);
    const { env } = tableEnv(full);
    const res = await deployWith(env, { "cf-connecting-ip": ip }, { source: "cli-demo" });
    expect(res.status).toBe(429);
  });

  it("stores a cli-demo label as a plain cli deploy, so it counts later", async () => {
    const { env, inserted } = tableEnv([]);
    await deployWith(env, { "cf-connecting-ip": "198.51.100.1" }, { source: "cli-demo" });
    expect(inserted[0]).toContain("cli");
    expect(inserted[0]).not.toContain("cli-demo");
  });

  it("deploy_demo rows do not consume the client's quota", async () => {
    const hash = await ipHashOf("203.0.113.7");
    const now = Date.now();
    // The trusted demo deploy is stored under the server-set demo source…
    const first = tableEnv([]);
    await deployWith(first.env, { ...MCP_HEADERS, "x-creek-demo": "1" }, { source: "mcp" });
    const stored = first.inserted[0];
    expect(stored).toContain(hash);
    const demoSource = stored[4] as string;
    expect(demoSource).not.toBe("mcp");

    // …so a full hour of demos leaves an ordinary deploy under the limit.
    const demos = Array.from({ length: 20 }, (_, i) => ({
      ipHash: hash,
      source: demoSource,
      createdAt: now - 1000 - i,
    }));
    const second = tableEnv(demos);
    const res = await deployWith(second.env, MCP_HEADERS, { source: "mcp" });
    expect(res.status).not.toBe(429);
    expect(second.inserted).toHaveLength(1);
  });
});
