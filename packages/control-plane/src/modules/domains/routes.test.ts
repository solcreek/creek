import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createMockD1,
  createTestEnv,
  createTestApp,
  seedMemberRole,
  TEST_USER,
  TEST_TEAM,
  type MockD1,
} from "../../test-helpers.js";

let db: MockD1;
let env: ReturnType<typeof createTestEnv>;
let app: ReturnType<typeof createTestApp>;
let teamId: string;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  db = createMockD1();
  env = createTestEnv(db);
  app = createTestApp(TEST_USER, TEST_TEAM.id, TEST_TEAM.slug);
  teamId = TEST_TEAM.id;
  seedMemberRole(db);

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
  globalThis.fetch = originalFetch;
});

function req(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return app.request(path, init, env);
}

const PROJECT_ID = "proj-1";

function seedProject() {
  db.seedFirst("SELECT id FROM project WHERE", [PROJECT_ID, PROJECT_ID, teamId], {
    id: PROJECT_ID,
  });
  db.seedFirst("SELECT id, slug FROM project WHERE", [PROJECT_ID, PROJECT_ID, teamId], {
    id: PROJECT_ID,
    slug: "my-app",
  });
}

// --- GET /projects/:id/domains ---

describe("GET /projects/:id/domains", () => {
  test("lists domains for project", async () => {
    seedProject();
    db.seedAll("SELECT * FROM custom_domain WHERE projectId", [PROJECT_ID], {
      results: [
        { id: "d1", hostname: "app.example.com", status: "active" },
      ],
    });

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
    seedProject();
    db.seedFirst("SELECT * FROM custom_domain WHERE id", ["d1", PROJECT_ID], {
      id: "d1",
      hostname: "app.example.com",
      status: "pending",
    });

    const res = await req("GET", `/projects/${PROJECT_ID}/domains/d1`);
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.hostname).toBe("app.example.com");
  });

  test("returns 404 for non-existent domain", async () => {
    seedProject();
    const res = await req("GET", `/projects/${PROJECT_ID}/domains/nonexistent`);
    expect(res.status).toBe(404);
  });
});

// --- POST /projects/:id/domains ---

describe("POST /projects/:id/domains", () => {
  test("adds custom domain and calls CF API", async () => {
    seedProject();

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
    seedProject();
    const res = await req("POST", `/projects/${PROJECT_ID}/domains`, {});
    expect(res.status).toBe(400);
  });

  test("rejects duplicate hostname", async () => {
    seedProject();
    db.seedFirst("SELECT id FROM custom_domain WHERE hostname", ["app.example.com"], {
      id: "existing",
    });

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
    seedProject();
    const res = await req("POST", `/projects/${PROJECT_ID}/domains`, {
      hostname: "localhost",
    });
    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.error).toBe("validation");
  });

  test("rejects IP address", async () => {
    seedProject();
    const res = await req("POST", `/projects/${PROJECT_ID}/domains`, {
      hostname: "192.168.1.1",
    });
    expect(res.status).toBe(400);
  });

  test("rejects reserved domain *.bycreek.com for non-owner", async () => {
    // Re-seed as admin (not owner) — admin can't bypass reserved check
    db = createMockD1();
    env = createTestEnv(db);
    app = createTestApp(TEST_USER, TEST_TEAM.id, TEST_TEAM.slug);
    seedMemberRole(db, "admin");
    seedProject();

    const res = await req("POST", `/projects/${PROJECT_ID}/domains`, {
      hostname: "evil.bycreek.com",
    });
    expect(res.status).toBe(400);
    const json = await res.json() as any;
    expect(json.message).toContain("reserved");
  });

  test("rejects reserved domain *.creek.dev for non-owner", async () => {
    db = createMockD1();
    env = createTestEnv(db);
    app = createTestApp(TEST_USER, TEST_TEAM.id, TEST_TEAM.slug);
    seedMemberRole(db, "admin");
    seedProject();

    const res = await req("POST", `/projects/${PROJECT_ID}/domains`, {
      hostname: "steal.creek.dev",
    });
    expect(res.status).toBe(400);
  });

  test("rejects single-label hostname", async () => {
    seedProject();
    const res = await req("POST", `/projects/${PROJECT_ID}/domains`, {
      hostname: "example",
    });
    expect(res.status).toBe(400);
  });

  test("accepts valid hostname", async () => {
    seedProject();
    const res = await req("POST", `/projects/${PROJECT_ID}/domains`, {
      hostname: "api.mycompany.com",
    });
    expect(res.status).toBe(201);
  });
});

// --- POST /projects/:id/domains/:domainId/activate ---

describe("POST /projects/:id/domains/:domainId/activate", () => {
  test("activates a pending domain", async () => {
    seedProject();

    const res = await req("POST", `/projects/${PROJECT_ID}/domains/d1/activate`);
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
  });

  test("returns 404 for non-existent domain", async () => {
    seedProject();
    // Seed the UPDATE to return 0 changes (domain doesn't exist)
    db.seedRun("UPDATE custom_domain SET status", ["nonexistent", PROJECT_ID], {
      meta: { changes: 0 },
    });

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
    seedProject();
    db.seedFirst("SELECT id, cfCustomHostnameId FROM custom_domain WHERE id", ["dom-1", PROJECT_ID], {
      id: "dom-1",
      cfCustomHostnameId: "cf-id-123",
    });

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
    seedProject();
    db.seedAll("SELECT * FROM custom_domain WHERE projectId", [PROJECT_ID], {
      results: [],
    });

    await req("GET", `/projects/${PROJECT_ID}/domains`);

    const queries = db.getExecuted();
    const projectQuery = queries.find((q) => q.sql.includes("SELECT id FROM project"));
    expect(projectQuery).toBeDefined();
    expect(projectQuery!.sql).toContain("organizationId");
    expect(projectQuery!.args[2]).toBe(teamId);
  });
});
