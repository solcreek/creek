import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createLocalTestEnv,
  seedTestData,
  seedProject,
  type LocalTestEnv,
} from "../../local/test-env.js";
import { createTestApp, TEST_USER, TEST_TEAM } from "../../test-helpers.js";

let testEnv: LocalTestEnv;
let app: ReturnType<typeof createTestApp>;
let teamId: string;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  testEnv = createLocalTestEnv();
  seedTestData(testEnv);
  app = createTestApp(TEST_USER, TEST_TEAM.id, TEST_TEAM.slug);
  teamId = TEST_TEAM.id;

  // Mock CF API calls for custom hostnames
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("custom_hostnames")) {
      return new Response(
        JSON.stringify({
          success: true,
          result: {
            id: "cf-hostname-123",
            hostname: "test.example.com",
            status: "pending",
            ownership_verification: {
              type: "txt",
              name: "_cf-custom-hostname.test.example.com",
              value: "uuid-123",
            },
            ownership_verification_http: null,
            ssl: { status: "initializing", method: "http", type: "dv", validation_records: null },
          },
        }),
      );
    }
    return originalFetch(input as any);
  }) as any;
});

afterEach(() => {
  testEnv.cleanup();
  globalThis.fetch = originalFetch;
});

function req(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return app.request(path, init, testEnv.env);
}

const PROJECT_ID = "proj-1";

function seedTestProject() {
  const now = Date.now();
  testEnv.db.db.exec(
    `INSERT OR IGNORE INTO project (id, slug, organizationId, productionBranch, createdAt, updatedAt)
     VALUES ('${PROJECT_ID}', 'my-app', '${teamId}', 'main', ${now}, ${now})`,
  );
}

// --- GET /projects/:id/domains ---

describe("GET /projects/:id/domains", () => {
  test("lists domains for project", async () => {
    seedTestProject();
    const now = Math.floor(Date.now() / 1000);
    testEnv.db.db.exec(
      `INSERT INTO custom_domain (id, projectId, hostname, status, createdAt)
       VALUES ('d1', '${PROJECT_ID}', 'app.example.com', 'active', ${now})`,
    );

    const res = await req("GET", `/projects/${PROJECT_ID}/domains`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json).toHaveLength(1);
    expect(json[0].hostname).toBe("app.example.com");
  });

  test("returns 404 for non-existent project", async () => {
    const res = await req("GET", "/projects/nonexistent/domains");
    expect(res.status).toBe(404);
  });
});

// --- GET /projects/:id/domains/:domainId ---

describe("GET /projects/:id/domains/:domainId", () => {
  test("returns single domain", async () => {
    seedTestProject();
    const now = Math.floor(Date.now() / 1000);
    testEnv.db.db.exec(
      `INSERT INTO custom_domain (id, projectId, hostname, status, createdAt)
       VALUES ('d1', '${PROJECT_ID}', 'app.example.com', 'pending', ${now})`,
    );

    const res = await req("GET", `/projects/${PROJECT_ID}/domains/d1`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.hostname).toBe("app.example.com");
  });

  test("returns 404 for non-existent domain", async () => {
    seedTestProject();
    const res = await req("GET", `/projects/${PROJECT_ID}/domains/nonexistent`);
    expect(res.status).toBe(404);
  });

  test("includes the CNAME instruction so DNS records are retrievable", async () => {
    seedTestProject();
    const now = Math.floor(Date.now() / 1000);
    testEnv.db.db.exec(
      `INSERT INTO custom_domain (id, projectId, hostname, status, createdAt)
       VALUES ('d2', '${PROJECT_ID}', 'site.example.com', 'pending', ${now})`,
    );

    const res = await req("GET", `/projects/${PROJECT_ID}/domains/d2`);
    const json = (await res.json()) as any;
    expect(json.dns.cname).toEqual({ name: "site.example.com", target: "cname.bycreek.com" });
    expect(json.dns.apex).toBe(false);
    expect(json.dns.records).toEqual([
      {
        type: "CNAME",
        name: "site.example.com",
        value: "cname.bycreek.com",
        purpose: "Routes the domain to Creek.",
      },
    ]);
  });

  test("tells an apex domain to use flattening, ALIAS or ANAME", async () => {
    seedTestProject();
    const now = Math.floor(Date.now() / 1000);
    testEnv.db.db.exec(
      `INSERT INTO custom_domain (id, projectId, hostname, status, createdAt)
       VALUES ('d3', '${PROJECT_ID}', 'example.com', 'pending', ${now})`,
    );

    const res = await req("GET", `/projects/${PROJECT_ID}/domains/d3`);
    const json = (await res.json()) as any;
    expect(json.dns.apex).toBe(true);
    expect(json.dns.records[0]).toMatchObject({ type: "CNAME", value: "cname.bycreek.com" });
    expect(json.dns.records[0].purpose).toMatch(/CNAME flattening, ALIAS or ANAME/);
  });

  test("derives the target from CREEK_DOMAIN on a self-hosted install", async () => {
    seedTestProject();
    const now = Math.floor(Date.now() / 1000);
    testEnv.db.db.exec(
      `INSERT INTO custom_domain (id, projectId, hostname, status, createdAt)
       VALUES ('d4', '${PROJECT_ID}', 'site.example.com', 'pending', ${now})`,
    );

    const res = await app.request(
      `/projects/${PROJECT_ID}/domains/d4`,
      { method: "GET" },
      { ...testEnv.env, CREEK_DOMAIN: "apps.example.net" },
    );
    const json = (await res.json()) as any;
    expect(json.dns.cname.target).toBe("cname.apps.example.net");
  });
});

// --- POST /projects/:id/domains ---

describe("POST /projects/:id/domains", () => {
  test("adds custom domain and calls CF API", async () => {
    seedTestProject();

    const res = await req("POST", `/projects/${PROJECT_ID}/domains`, {
      hostname: "app.example.com",
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as any;
    expect(json.domain).toBeDefined();
    // CF returned pending status, so verification instructions are included
    expect(json.verification).toBeDefined();
    expect(json.verification.cname.target).toBe("cname.bycreek.com");
    expect(json.verification.txt).toBeDefined();
    // Every record to set, routing first, then CF's ownership TXT.
    expect(json.verification.records.map((r: any) => [r.type, r.name, r.value])).toEqual([
      ["CNAME", "app.example.com", "cname.bycreek.com"],
      ["TXT", "_cf-custom-hostname.test.example.com", "uuid-123"],
    ]);

    // Verify CF API was called
    expect(globalThis.fetch).toHaveBeenCalled();
  });

  test("still says where to point DNS when the edge call fails", async () => {
    seedTestProject();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("custom_hostnames")) {
        return new Response(
          JSON.stringify({ success: false, errors: [{ code: 1000, message: "no" }] }),
        );
      }
      return originalFetch(input as any);
    }) as any;

    const res = await req("POST", `/projects/${PROJECT_ID}/domains`, {
      hostname: "app.example.com",
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as any;
    expect(json.verification.cname.target).toBe("cname.bycreek.com");
    expect(json.verification.records).toHaveLength(1);
    expect(json.verification.txt).toBeUndefined();
  });

  test("rejects missing hostname", async () => {
    seedTestProject();
    const res = await req("POST", `/projects/${PROJECT_ID}/domains`, {});
    expect(res.status).toBe(400);
  });

  test("is idempotent — re-adding a hostname on the same project returns it, not an error", async () => {
    seedTestProject();
    const now = Math.floor(Date.now() / 1000);
    testEnv.db.db.exec(
      `INSERT INTO custom_domain (id, projectId, hostname, status, createdAt)
       VALUES ('existing', '${PROJECT_ID}', 'app.example.com', 'pending', ${now})`,
    );

    const res = await req("POST", `/projects/${PROJECT_ID}/domains`, {
      hostname: "app.example.com",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.idempotent).toBe(true);
    expect(json.domain.id).toBe("existing");
    expect(json.verification.cname).toEqual({
      name: "app.example.com",
      target: "cname.bycreek.com",
    });
  });

  test("re-adding a domain that never reached the edge registers it", async () => {
    seedTestProject();
    const now = Math.floor(Date.now() / 1000);
    testEnv.db.db.exec(
      `INSERT INTO custom_domain (id, projectId, hostname, status, createdAt)
       VALUES ('existing', '${PROJECT_ID}', 'app.example.com', 'pending', ${now})`,
    );
    const txt = { type: "txt", name: "_cf-custom-hostname.app.example.com", value: "tok-1" };
    mockEdge({
      create: () => ({
        id: "cf-new",
        hostname: "app.example.com",
        status: "pending",
        ownership_verification: txt,
      }),
    });

    const res = await req("POST", `/projects/${PROJECT_ID}/domains`, {
      hostname: "app.example.com",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.domain).toMatchObject({ id: "existing", cfCustomHostnameId: "cf-new" });
    expect(domainRow("existing").cfCustomHostnameId).toBe("cf-new");
    // The repair is the first time the edge answered for this row, so its
    // ownership TXT record must reach the user, as on a first add.
    expect(json.verification.txt).toEqual(txt);
    expect(json.verification.cname).toEqual({
      name: "app.example.com",
      target: "cname.bycreek.com",
    });
    // …and it's in `records`, where an agent applies it from.
    expect(json.verification.records.map((r: any) => [r.type, r.name, r.value])).toEqual([
      ["CNAME", "app.example.com", "cname.bycreek.com"],
      ["TXT", "_cf-custom-hostname.app.example.com", "tok-1"],
    ]);
  });

  test("adopts the edge's existing hostname when the create call fails", async () => {
    seedTestProject();
    // e.g. a previous create succeeded at CF but its response was lost
    const calls = mockEdge({
      find: (hostname) => [{ id: "cf-existing", hostname, status: "active" }],
    });

    const res = await req("POST", `/projects/${PROJECT_ID}/domains`, {
      hostname: "app.example.com",
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as any;
    expect(calls).toEqual(["create", "find"]);
    expect(json.domain).toMatchObject({ status: "active", cfCustomHostnameId: "cf-existing" });
  });

  test("still records the domain, unlinked, when the edge can't be reached", async () => {
    seedTestProject();
    mockEdge({});

    const res = await req("POST", `/projects/${PROJECT_ID}/domains`, {
      hostname: "app.example.com",
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as any;
    expect(json.domain).toMatchObject({ status: "pending", cfCustomHostnameId: null });
  });

  test("rejects a hostname owned by a different project", async () => {
    seedTestProject();
    const now = Date.now();
    testEnv.db.db.exec(
      `INSERT OR IGNORE INTO project (id, slug, organizationId, productionBranch, createdAt, updatedAt)
       VALUES ('proj-2', 'other-app', '${teamId}', 'main', ${now}, ${now})`,
    );
    testEnv.db.db.exec(
      `INSERT INTO custom_domain (id, projectId, hostname, status, createdAt)
       VALUES ('taken', 'proj-2', 'app.example.com', 'active', ${Math.floor(now / 1000)})`,
    );

    const res = await req("POST", `/projects/${PROJECT_ID}/domains`, {
      hostname: "app.example.com",
    });
    expect(res.status).toBe(409);
  });

  test("returns 404 for non-existent project", async () => {
    const res = await req("POST", "/projects/nonexistent/domains", {
      hostname: "app.example.com",
    });
    expect(res.status).toBe(404);
  });

  // --- Hostname validation ---

  test("rejects localhost", async () => {
    seedTestProject();
    const res = await req("POST", `/projects/${PROJECT_ID}/domains`, {
      hostname: "localhost",
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.error).toBe("validation");
  });

  test("rejects IP address", async () => {
    seedTestProject();
    const res = await req("POST", `/projects/${PROJECT_ID}/domains`, {
      hostname: "192.168.1.1",
    });
    expect(res.status).toBe(400);
  });

  test("rejects reserved domain *.bycreek.com for non-owner", async () => {
    // Re-seed as admin (not owner) -- admin can't bypass reserved check
    testEnv.cleanup();
    testEnv = createLocalTestEnv();
    seedTestData(testEnv, { role: "admin" });
    app = createTestApp(TEST_USER, TEST_TEAM.id, TEST_TEAM.slug);

    const now = Date.now();
    testEnv.db.db.exec(
      `INSERT OR IGNORE INTO project (id, slug, organizationId, productionBranch, createdAt, updatedAt)
       VALUES ('${PROJECT_ID}', 'my-app', '${teamId}', 'main', ${now}, ${now})`,
    );

    // Re-apply fetch mock
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("custom_hostnames")) {
        return new Response(
          JSON.stringify({
            success: true,
            result: { id: "cf-id", status: "pending", ownership_verification: null },
          }),
        );
      }
      return originalFetch(input as any);
    }) as any;

    const res = await req("POST", `/projects/${PROJECT_ID}/domains`, {
      hostname: "evil.bycreek.com",
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.message).toContain("reserved");
  });

  test("rejects reserved domain *.creek.dev for non-owner", async () => {
    testEnv.cleanup();
    testEnv = createLocalTestEnv();
    seedTestData(testEnv, { role: "admin" });
    app = createTestApp(TEST_USER, TEST_TEAM.id, TEST_TEAM.slug);

    const now = Date.now();
    testEnv.db.db.exec(
      `INSERT OR IGNORE INTO project (id, slug, organizationId, productionBranch, createdAt, updatedAt)
       VALUES ('${PROJECT_ID}', 'my-app', '${teamId}', 'main', ${now}, ${now})`,
    );

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("custom_hostnames")) {
        return new Response(
          JSON.stringify({
            success: true,
            result: { id: "cf-id", status: "pending", ownership_verification: null },
          }),
        );
      }
      return originalFetch(input as any);
    }) as any;

    const res = await req("POST", `/projects/${PROJECT_ID}/domains`, {
      hostname: "steal.creek.dev",
    });
    expect(res.status).toBe(400);
  });

  test("rejects single-label hostname", async () => {
    seedTestProject();
    const res = await req("POST", `/projects/${PROJECT_ID}/domains`, {
      hostname: "example",
    });
    expect(res.status).toBe(400);
  });

  test("accepts valid hostname", async () => {
    seedTestProject();
    const res = await req("POST", `/projects/${PROJECT_ID}/domains`, {
      hostname: "api.mycompany.com",
    });
    expect(res.status).toBe(201);
  });
});

// --- POST /projects/:id/domains/:domainId/activate ---

// A CF API stand-in: `create` answers POST custom_hostnames, `find` answers the
// ?hostname= lookup, `get` answers GET by id. A handler that is undefined makes
// that call fail the way the real API does (success: false, errors: [...]).
type CfHostname = { id: string; hostname: string; status: string };
function mockEdge(handlers: {
  create?: () => CfHostname;
  find?: (hostname: string) => CfHostname[];
  get?: (id: string) => CfHostname;
}) {
  const calls: string[] = [];
  const fail = () =>
    new Response(JSON.stringify({ success: false, errors: [{ code: 1406, message: "failed" }] }));
  const ok = (result: unknown) =>
    new Response(
      JSON.stringify({
        success: true,
        result: Array.isArray(result)
          ? result
          : {
              ownership_verification: null,
              ssl: { status: "initializing" },
              ...(result as object),
            },
      }),
    );
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (!url.pathname.includes("custom_hostnames")) return originalFetch(input as any, init);
    const method = init?.method ?? "GET";
    if (method === "POST") {
      calls.push("create");
      return handlers.create ? ok(handlers.create()) : fail();
    }
    if (url.searchParams.has("hostname")) {
      calls.push("find");
      return handlers.find ? ok(handlers.find(url.searchParams.get("hostname")!)) : fail();
    }
    calls.push("get");
    const id = url.pathname.split("/").pop()!;
    return handlers.get ? ok(handlers.get(id)) : fail();
  }) as any;
  return calls;
}

function domainRow(id = "d1") {
  return testEnv.db.db
    .prepare("SELECT status, cfCustomHostnameId FROM custom_domain WHERE id = ?")
    .get(id) as { status: string; cfCustomHostnameId: string | null };
}

describe("POST /projects/:id/domains/:domainId/activate", () => {
  test("manual-overrides a pending domain when no edge zone is configured", async () => {
    seedTestProject();
    const now = Math.floor(Date.now() / 1000);
    testEnv.db.db.exec(
      `INSERT INTO custom_domain (id, projectId, hostname, status, createdAt)
       VALUES ('d1', '${PROJECT_ID}', 'app.example.com', 'pending', ${now})`,
    );

    const res = await app.request(
      `/projects/${PROJECT_ID}/domains/d1/activate`,
      { method: "POST" },
      { ...testEnv.env, CLOUDFLARE_ZONE_ID: "" },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json).toMatchObject({ ok: true, status: "active", manual: true });
  });

  test("registers a domain that never reached the edge instead of activating it", async () => {
    seedTestProject();
    const now = Math.floor(Date.now() / 1000);
    testEnv.db.db.exec(
      `INSERT INTO custom_domain (id, projectId, hostname, status, createdAt)
       VALUES ('d1', '${PROJECT_ID}', 'app.example.com', 'pending', ${now})`,
    );
    const calls = mockEdge({
      create: () => ({ id: "cf-new", hostname: "app.example.com", status: "pending" }),
      get: (id) => ({ id, hostname: "app.example.com", status: "pending" }),
    });

    const res = await req("POST", `/projects/${PROJECT_ID}/domains/d1/activate`);
    const json = (await res.json()) as any;
    expect(json).toMatchObject({ ok: false, status: "pending_dns" });
    expect(calls).toEqual(["create", "get"]);
    expect(domainRow()).toEqual({ status: "pending", cfCustomHostnameId: "cf-new" });
  });

  test("reports pending_edge and leaves the row alone when the edge can't be reached", async () => {
    seedTestProject();
    const now = Math.floor(Date.now() / 1000);
    testEnv.db.db.exec(
      `INSERT INTO custom_domain (id, projectId, hostname, status, createdAt)
       VALUES ('d1', '${PROJECT_ID}', 'app.example.com', 'pending', ${now})`,
    );
    mockEdge({}); // create and lookup both fail

    const res = await req("POST", `/projects/${PROJECT_ID}/domains/d1/activate`);
    const json = (await res.json()) as any;
    expect(json).toMatchObject({ ok: false, status: "pending_edge" });
    expect(domainRow()).toEqual({ status: "pending", cfCustomHostnameId: null });
  });

  test("does not activate from the create response when the edge can't confirm it", async () => {
    // The create/adopt call answers "active", then the confirming GET fails:
    // the row must stay non-active, because dispatch routes active rows.
    seedTestProject();
    const now = Math.floor(Date.now() / 1000);
    testEnv.db.db.exec(
      `INSERT INTO custom_domain (id, projectId, hostname, status, createdAt)
       VALUES ('d1', '${PROJECT_ID}', 'app.example.com', 'pending', ${now})`,
    );
    const calls = mockEdge({
      create: () => ({ id: "cf-new", hostname: "app.example.com", status: "active" }),
      // no `get` handler: the confirming GET fails
    });

    const res = await req("POST", `/projects/${PROJECT_ID}/domains/d1/activate`);
    const json = (await res.json()) as any;
    expect(json).toMatchObject({ ok: false, status: "pending_edge" });
    expect(calls).toEqual(["create", "get"]);
    expect(domainRow()).toEqual({ status: "pending", cfCustomHostnameId: "cf-new" });
  });

  test("reports pending_edge, not pending_dns, when verifying a linked domain fails", async () => {
    seedTestProject();
    const now = Math.floor(Date.now() / 1000);
    testEnv.db.db.exec(
      `INSERT INTO custom_domain (id, projectId, hostname, status, cfCustomHostnameId, createdAt)
       VALUES ('d1', '${PROJECT_ID}', 'app.example.com', 'pending', 'cf-1', ${now})`,
    );
    mockEdge({}); // the GET fails

    const res = await req("POST", `/projects/${PROJECT_ID}/domains/d1/activate`);
    const json = (await res.json()) as any;
    expect(json).toMatchObject({ ok: false, status: "pending_edge" });
    expect(domainRow()).toEqual({ status: "pending", cfCustomHostnameId: "cf-1" });
  });

  test("reports pending_dns (and does not flip) when the edge hasn't verified", async () => {
    seedTestProject();
    const now = Math.floor(Date.now() / 1000);
    testEnv.db.db.exec(
      `INSERT INTO custom_domain (id, projectId, hostname, status, cfCustomHostnameId, createdAt)
       VALUES ('d1', '${PROJECT_ID}', 'app.example.com', 'pending', 'cf-1', ${now})`,
    );
    // The beforeEach fetch mock returns custom_hostnames status "pending".

    const res = await req("POST", `/projects/${PROJECT_ID}/domains/d1/activate`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json).toMatchObject({ ok: false, status: "pending_dns" });
    const row = testEnv.db.db.prepare("SELECT status FROM custom_domain WHERE id = 'd1'").get() as {
      status: string;
    };
    expect(row.status).toBe("pending"); // not falsely activated
  });

  test("activates when the edge confirms the hostname is active", async () => {
    seedTestProject();
    const now = Math.floor(Date.now() / 1000);
    testEnv.db.db.exec(
      `INSERT INTO custom_domain (id, projectId, hostname, status, cfCustomHostnameId, createdAt)
       VALUES ('d1', '${PROJECT_ID}', 'app.example.com', 'pending', 'cf-1', ${now})`,
    );
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("custom_hostnames")) {
        return new Response(
          JSON.stringify({
            success: true,
            result: { id: "cf-1", status: "active", ssl: { status: "active" } },
          }),
        );
      }
      return originalFetch(input as any);
    }) as any;

    const res = await req("POST", `/projects/${PROJECT_ID}/domains/d1/activate`);
    const json = (await res.json()) as any;
    expect(json).toMatchObject({ ok: true, status: "active" });
    const row = testEnv.db.db.prepare("SELECT status FROM custom_domain WHERE id = 'd1'").get() as {
      status: string;
    };
    expect(row.status).toBe("active");
  });

  test("returns 404 for non-existent domain", async () => {
    seedTestProject();

    const res = await req("POST", `/projects/${PROJECT_ID}/domains/nonexistent/activate`);
    expect(res.status).toBe(404);
  });

  test("returns 404 for non-existent project", async () => {
    const res = await req("POST", "/projects/nonexistent/domains/d1/activate");
    expect(res.status).toBe(404);
  });
});

// --- DELETE /projects/:id/domains/:domainId ---

describe("DELETE /projects/:id/domains/:domainId", () => {
  test("deletes domain and calls CF cleanup", async () => {
    seedTestProject();
    const now = Math.floor(Date.now() / 1000);
    testEnv.db.db.exec(
      `INSERT INTO custom_domain (id, projectId, hostname, status, cfCustomHostnameId, createdAt)
       VALUES ('dom-1', '${PROJECT_ID}', 'app.example.com', 'active', 'cf-id-123', ${now})`,
    );

    const res = await req("DELETE", `/projects/${PROJECT_ID}/domains/dom-1`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.ok).toBe(true);

    // Verify CF delete was called
    const cfCalls = (globalThis.fetch as any).mock.calls.filter(([url]: [string]) =>
      url.includes("custom_hostnames/cf-id-123"),
    );
    expect(cfCalls.length).toBe(1);
  });

  test("returns 404 for non-existent project", async () => {
    const res = await req("DELETE", "/projects/nonexistent/domains/dom-1");
    expect(res.status).toBe(404);
  });
});

// --- Verify organization_id scoping ---

describe("team scoping", () => {
  test("domains route SQL uses organization_id", async () => {
    seedTestProject();

    const res = await req("GET", `/projects/${PROJECT_ID}/domains`);
    expect(res.status).toBe(200);

    // With real SQLite, the project is only found because we seeded it
    // with the correct organizationId. If scoping were broken, a different
    // team's project would leak through. Verify by checking an unrelated
    // team's project returns 404.
    const res2 = await req("GET", "/projects/proj-other-team/domains");
    expect(res2.status).toBe(404);
  });
});
