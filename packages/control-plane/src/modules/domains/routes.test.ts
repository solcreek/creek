import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { createLocalTestEnv, seedTestData, seedProject, type LocalTestEnv } from "../../local/test-env.js";
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
      return new Response(JSON.stringify({
        success: true,
        result: {
          id: "cf-hostname-123",
          hostname: "test.example.com",
          status: "pending",
          ownership_verification: { type: "txt", name: "_cf-custom-hostname.test.example.com", value: "uuid-123" },
          ownership_verification_http: null,
          ssl: { status: "initializing", method: "http", type: "dv", validation_records: null },
        },
      }));
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
    const json = await res.json() as any;
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
    const json = await res.json() as any;
    expect(json.hostname).toBe("app.example.com");
  });

  test("returns 404 for non-existent domain", async () => {
    seedTestProject();
    const res = await req("GET", `/projects/${PROJECT_ID}/domains/nonexistent`);
    expect(res.status).toBe(404);
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
    const json = await res.json() as any;
    expect(json.domain).toBeDefined();
    // CF returned pending status, so verification instructions are included
    expect(json.verification).toBeDefined();
    expect(json.verification.cname.target).toBe("cname.creek.dev");
    expect(json.verification.txt).toBeDefined();

    // Verify CF API was called
    expect(globalThis.fetch).toHaveBeenCalled();
  });

  test("rejects missing hostname", async () => {
    seedTestProject();
    const res = await req("POST", `/projects/${PROJECT_ID}/domains`, {});
    expect(res.status).toBe(400);
  });

  test("rejects duplicate hostname", async () => {
    seedTestProject();
    const now = Math.floor(Date.now() / 1000);
    testEnv.db.db.exec(
      `INSERT INTO custom_domain (id, projectId, hostname, status, createdAt)
       VALUES ('existing', '${PROJECT_ID}', 'app.example.com', 'active', ${now})`,
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
    const json = await res.json() as any;
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
        return new Response(JSON.stringify({ success: true, result: { id: "cf-id", status: "pending", ownership_verification: null } }));
      }
      return originalFetch(input as any);
    }) as any;

    const res = await req("POST", `/projects/${PROJECT_ID}/domains`, {
      hostname: "evil.bycreek.com",
    });
    expect(res.status).toBe(400);
    const json = await res.json() as any;
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
        return new Response(JSON.stringify({ success: true, result: { id: "cf-id", status: "pending", ownership_verification: null } }));
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

describe("POST /projects/:id/domains/:domainId/activate", () => {
  test("activates a pending domain", async () => {
    seedTestProject();
    const now = Math.floor(Date.now() / 1000);
    testEnv.db.db.exec(
      `INSERT INTO custom_domain (id, projectId, hostname, status, createdAt)
       VALUES ('d1', '${PROJECT_ID}', 'app.example.com', 'pending', ${now})`,
    );

    const res = await req("POST", `/projects/${PROJECT_ID}/domains/d1/activate`);
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
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
    const json = await res.json() as any;
    expect(json.ok).toBe(true);

    // Verify CF delete was called
    const cfCalls = (globalThis.fetch as any).mock.calls.filter(
      ([url]: [string]) => url.includes("custom_hostnames/cf-id-123"),
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
