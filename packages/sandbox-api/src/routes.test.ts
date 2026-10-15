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
