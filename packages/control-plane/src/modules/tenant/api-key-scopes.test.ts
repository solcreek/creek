import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { app } from "../../index.js";
import { guardInfo } from "./scope-guard.js";
import { ALL_SCOPES, SCOPES, type Scope } from "./scopes.js";
import { roleGrants } from "./permissions.js";
import { createFixture, type Fixture } from "./scoped-key-fixture.js";

/**
 * Scoped API keys end to end: the deployed Worker app, real Better Auth key
 * verification, real SQLite. The per-endpoint cases are generated from the
 * app's own routes and guards, so a new endpoint is covered without editing
 * this file (scope-coverage.test.ts makes sure it has a guard at all).
 */

/** Errors that mean "the key was refused". Anything else means it got past authorization. */
const REFUSALS = new Set([
  "insufficient_scope",
  "insufficient_role",
  "scope_unresolved",
  "invalid_key_scopes",
  "team_mismatch",
  "route_not_scoped",
  "api_key_not_allowed",
  "unauthorized",
]);

interface Endpoint {
  method: string;
  path: string;
  mode: "all" | "any";
  scopes: readonly Scope[];
}

/** Every endpoint guarded by scopes, from the live route table. */
const ENDPOINTS: Endpoint[] = (() => {
  const seen = new Map<string, Endpoint>();
  for (const r of app.routes) {
    const info = guardInfo(r.handler);
    if (r.method === "ALL" || info?.kind !== "scopes") continue;
    seen.set(`${r.method} ${r.path}`, {
      method: r.method,
      path: r.path,
      mode: info.mode,
      scopes: info.scopes,
    });
  }
  return [...seen.values()];
})();

/** A concrete URL for a route pattern, aimed at the seeded project. */
function concrete(path: string): string {
  return path.replace(/:(projectId|idOrSlug|slug)\b/g, "site").replace(/:[A-Za-z]+/g, "x");
}

const name = (e: Endpoint) => `${e.method} ${e.path}`;

async function errorOf(res: Response): Promise<string | undefined> {
  const text = await res.text();
  try {
    return (JSON.parse(text) as { error?: string }).error;
  } catch {
    return undefined;
  }
}

/** Count rows in every table a guarded endpoint could write. */
async function snapshot(f: Fixture) {
  const tables = [
    "project",
    "deployment",
    "environment_variable",
    "custom_domain",
    "resource",
    "project_resource_binding",
    "github_connection",
    "audit_log",
    "apikey",
    "organization",
    "member",
  ];
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const [row] = await f.sql<{ n: number }>(`SELECT count(*) AS n FROM ${table}`);
    counts[table] = row.n;
  }
  const [state] = await f.sql<{ s: string }>(
    "SELECT group_concat(id || ':' || status || ':' || ifnull(branch, ''), ',') AS s FROM deployment",
  );
  return { counts, deployments: state.s };
}

async function seedProject(f: Fixture, orgId: string) {
  const now = Date.now();
  await f.sql(
    "INSERT INTO project (id, slug, organizationId, createdAt, updatedAt) VALUES ('proj-site', 'site', ?, ?, ?)",
    orgId,
    now,
    now,
  );
  for (const [id, branch] of [
    ["dep-prod", "main"],
    ["dep-prev", "feature"],
  ]) {
    await f.sql(
      `INSERT INTO deployment (id, projectId, version, status, branch, triggerType, createdAt, updatedAt)
       VALUES (?, 'proj-site', 1, 'queued', ?, 'cli', ?, ?)`,
      id,
      branch,
      now,
      now,
    );
  }
}

// No handler that gets past authorization may reach the network.
beforeAll(() => {
  vi.stubGlobal("fetch", async () => new Response("network disabled in tests", { status: 599 }));
});
afterAll(() => {
  vi.unstubAllGlobals();
});

it("finds the scoped endpoints to test", () => {
  // Every manifest entry except public / internal-only / auth / platform-admin routes.
  expect(ENDPOINTS.length).toBeGreaterThanOrEqual(50);
});

describe("a key missing a required scope is refused before the endpoint runs", () => {
  let f: Fixture;
  let owner: Awaited<ReturnType<Fixture["signUp"]>>;
  beforeAll(async () => {
    f = createFixture();
    owner = await f.signUp("owner@example.com");
    await seedProject(f, owner.orgId);
  });
  afterAll(() => f.cleanup());

  for (const e of ENDPOINTS) {
    // "all": dropping any single required scope must refuse. "any": the key
    // must hold none of them.
    const cases = e.mode === "all" ? e.scopes.map((s) => [s]) : [e.scopes];
    for (const missing of cases) {
      it(`${name(e)} without ${missing.join(", ")}`, async () => {
        const key = await f.scopedKey(
          owner.userId,
          owner.orgId,
          ALL_SCOPES.filter((s) => !missing.includes(s)),
        );
        const before = await snapshot(f);
        const res = await f.call(e.method, concrete(e.path), { "x-api-key": key }, {});
        expect(res.status).toBe(403);
        const body = (await res.json()) as { error: string; required: string[] };
        expect(body.error).toBe("insufficient_scope");
        for (const s of missing) expect(body.required).toContain(s);
        // Nothing was written — except the key we just minted.
        const after = await snapshot(f);
        expect(after).toEqual(before);
      });
    }
  }
});

describe("a key holding the required scopes gets past authorization", () => {
  let f: Fixture;
  let owner: Awaited<ReturnType<Fixture["signUp"]>>;
  beforeEach(async () => {
    f = createFixture();
    owner = await f.signUp("owner@example.com");
    await seedProject(f, owner.orgId);
  });
  afterEach(() => f.cleanup());

  for (const e of ENDPOINTS) {
    it(name(e), async () => {
      const key = await f.scopedKey(owner.userId, owner.orgId, e.scopes);
      const res = await f.call(e.method, concrete(e.path), { "x-api-key": key }, {});
      const error = await errorOf(res);
      expect(REFUSALS.has(error ?? ""), `${res.status} ${error}`).toBe(false);
    });
  }
});

describe("legacy keys (no scopes stored) behave as before", () => {
  let f: Fixture;
  let key: string;
  beforeAll(async () => {
    f = createFixture();
    const owner = await f.signUp("owner@example.com");
    await seedProject(f, owner.orgId);
    key = await f.legacyKey(owner.cookie);
  });
  afterAll(() => f.cleanup());

  for (const e of ENDPOINTS) {
    it(name(e), async () => {
      const res = await f.call(e.method, concrete(e.path), { "x-api-key": key }, {});
      const error = await errorOf(res);
      expect(REFUSALS.has(error ?? ""), `${res.status} ${error}`).toBe(false);
    });
  }
});

describe("the key owner's current team role bounds the key", () => {
  let f: Fixture;
  let key: string;
  beforeAll(async () => {
    f = createFixture();
    const owner = await f.signUp("owner@example.com");
    await seedProject(f, owner.orgId);
    key = await f.scopedKey(owner.userId, owner.orgId, ALL_SCOPES);
    // Demote after the key exists: the key must shrink with the role.
    await f.sql("UPDATE member SET role = 'member'");
  });
  afterAll(() => f.cleanup());

  for (const e of ENDPOINTS) {
    const memberCan = (s: Scope) => roleGrants("member", SCOPES[s].rolePermission);
    const allowed = e.mode === "all" ? e.scopes.every(memberCan) : e.scopes.some(memberCan);
    it(`${name(e)} → ${allowed ? "allowed" : "insufficient_role"}`, async () => {
      const res = await f.call(e.method, concrete(e.path), { "x-api-key": key }, {});
      const error = await errorOf(res);
      if (allowed) expect(REFUSALS.has(error ?? ""), `${res.status} ${error}`).toBe(false);
      else expect([res.status, error]).toEqual([403, "insufficient_role"]);
    });
  }
});

describe("deploy scope follows the branch", () => {
  let f: Fixture;
  let owner: Awaited<ReturnType<Fixture["signUp"]>>;
  let preview: string;
  let production: string;
  beforeEach(async () => {
    f = createFixture();
    owner = await f.signUp("owner@example.com");
    await seedProject(f, owner.orgId);
    preview = await f.scopedKey(owner.userId, owner.orgId, ["deploy:preview"]);
    production = await f.scopedKey(owner.userId, owner.orgId, ["deploy:production"]);
  });
  afterEach(() => f.cleanup());

  const create = (key: string, body: unknown) =>
    f.call("POST", "/projects/site/deployments", { "x-api-key": key }, body);

  it("creates a preview deployment with deploy:preview", async () => {
    const res = await create(preview, { branch: "feature" });
    expect(res.status).toBe(201);
  });

  it("refuses a production deployment (no branch or the production branch) to deploy:preview, writing nothing", async () => {
    const before = await snapshot(f);
    for (const body of [{}, { branch: "main" }, { branch: "" }]) {
      const res = await create(preview, body);
      expect(res.status, JSON.stringify(body)).toBe(403);
      expect(await errorOf(res)).toBe("insufficient_scope");
    }
    expect(await snapshot(f)).toEqual(before);
  });

  it("creates a production deployment with deploy:production, and not a preview one", async () => {
    expect((await create(production, {})).status).toBe(201);
    expect((await create(production, { branch: "feature" })).status).toBe(403);
  });

  it("uses the project's production branch, not a hard-coded main", async () => {
    await f.sql("UPDATE project SET productionBranch = 'release' WHERE id = 'proj-site'");
    expect((await create(preview, { branch: "main" })).status).toBe(201);
    expect((await create(preview, { branch: "release" })).status).toBe(403);
  });

  it("refuses deploy:preview a production deployment's build log, and allows a preview one", async () => {
    const prod = await f.call(
      "POST",
      "/builds/dep-prod/logs?status=success",
      { "x-api-key": preview },
      {},
    );
    expect([prod.status, await errorOf(prod)]).toEqual([403, "insufficient_scope"]);
    const prev = await f.call(
      "POST",
      "/builds/dep-prev/logs?status=success",
      { "x-api-key": preview },
      {},
    );
    expect(REFUSALS.has((await errorOf(prev)) ?? "")).toBe(false);
    expect(
      (
        await f.call(
          "POST",
          "/builds/dep-prod/logs?status=success",
          { "x-api-key": production },
          {},
        )
      ).status,
    ).not.toBe(403);
  });

  for (const [what, path] of [
    ["bundle", "bundle"],
    ["server file", "serverfile?name=worker.js"],
  ]) {
    it(`refuses a ${what} upload into a production deployment to deploy:preview`, async () => {
      const before = await snapshot(f);
      const res = await f.call(
        "PUT",
        `/projects/site/deployments/dep-prod/${path}`,
        { "x-api-key": preview },
        {},
      );
      expect([res.status, await errorOf(res)]).toEqual([403, "insufficient_scope"]);
      expect(await snapshot(f)).toEqual(before);
    });

    it(`lets deploy:preview upload a ${what} into a preview deployment`, async () => {
      const res = await f.call(
        "PUT",
        `/projects/site/deployments/dep-prev/${path}`,
        { "x-api-key": preview },
        {},
      );
      expect(REFUSALS.has((await errorOf(res)) ?? "")).toBe(false);
    });
  }
});

describe("a scoped key is pinned to its team", () => {
  let f: Fixture;
  let owner: Awaited<ReturnType<Fixture["signUp"]>>;
  beforeEach(async () => {
    f = createFixture();
    owner = await f.signUp("owner@example.com");
    // The owner also belongs to a second team.
    await f.sql(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES ('org-b', 'B', 'team-b', ?)",
      Date.now(),
    );
    await f.sql(
      "INSERT INTO member (id, userId, organizationId, role, createdAt) VALUES ('m-b', ?, 'org-b', 'owner', ?)",
      owner.userId,
      Date.now(),
    );
  });
  afterEach(() => f.cleanup());

  it("works on its own team, with or without naming it", async () => {
    const key = await f.scopedKey(owner.userId, owner.orgId, ["project:read"]);
    expect((await f.call("GET", "/projects", { "x-api-key": key })).status).toBe(200);
    expect(
      (await f.call("GET", "/projects", { "x-api-key": key, "x-creek-team": owner.orgSlug }))
        .status,
    ).toBe(200);
  });

  it("resolves its pinned team even when that is not the owner's first team", async () => {
    const key = await f.scopedKey(owner.userId, "org-b", ["project:read"]);
    const now = Date.now();
    await f.sql(
      "INSERT INTO project (id, slug, organizationId, createdAt, updatedAt) VALUES ('proj-b', 'site-b', 'org-b', ?, ?)",
      now,
      now,
    );
    const res = await f.call("GET", "/projects", { "x-api-key": key });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { projects?: { slug: string }[] } | { slug: string }[];
    expect(JSON.stringify(body)).toContain("site-b");
    // And it refuses the owner's first team.
    const first = await f.call("GET", "/projects", {
      "x-api-key": key,
      "x-creek-team": owner.orgSlug,
    });
    expect([first.status, await errorOf(first)]).toEqual([403, "team_mismatch"]);
  });

  it("refuses another team the owner belongs to", async () => {
    const key = await f.scopedKey(owner.userId, owner.orgId, ["project:read"]);
    const res = await f.call("GET", "/projects", { "x-api-key": key, "x-creek-team": "team-b" });
    expect([res.status, await errorOf(res)]).toEqual([403, "team_mismatch"]);
  });

  it("stops working when its owner leaves the team, instead of falling back to another", async () => {
    const key = await f.scopedKey(owner.userId, owner.orgId, ["project:read"]);
    await f.sql("DELETE FROM member WHERE organizationId = ?", owner.orgId);
    const res = await f.call("GET", "/projects", { "x-api-key": key });
    expect([res.status, await errorOf(res)]).toEqual([403, "team_mismatch"]);
  });

  it("does not see another team's project by id", async () => {
    const now = Date.now();
    await f.sql(
      "INSERT INTO project (id, slug, organizationId, createdAt, updatedAt) VALUES ('proj-b', 'site-b', 'org-b', ?, ?)",
      now,
      now,
    );
    const key = await f.scopedKey(owner.userId, owner.orgId, ["project:read"]);
    expect((await f.call("GET", "/projects/proj-b", { "x-api-key": key })).status).toBe(404);
  });

  it("leaves legacy keys free to pick the team, as before", async () => {
    const key = await f.legacyKey(owner.cookie);
    expect(
      (await f.call("GET", "/projects", { "x-api-key": key, "x-creek-team": "team-b" })).status,
    ).toBe(200);
  });
});

describe("Better Auth endpoints with an API key", () => {
  let f: Fixture;
  let owner: Awaited<ReturnType<Fixture["signUp"]>>;
  beforeEach(async () => {
    f = createFixture();
    owner = await f.signUp("owner@example.com");
  });
  afterEach(() => f.cleanup());

  it("reads the session (CLI login and whoami) with a scoped or legacy key", async () => {
    for (const key of [
      await f.scopedKey(owner.userId, owner.orgId, []),
      await f.legacyKey(owner.cookie),
    ]) {
      const res = await f.call("GET", "/api/auth/get-session", { "x-api-key": key });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { user: { email: string } }).user.email).toBe(
        "owner@example.com",
      );
    }
  });

  it("cannot mint, list or change keys, or touch organizations — scoped or legacy", async () => {
    for (const key of [
      await f.scopedKey(owner.userId, owner.orgId, ALL_SCOPES),
      await f.legacyKey(owner.cookie),
    ]) {
      const keysBefore = (await f.sql("SELECT id FROM apikey")).length;
      for (const [method, path, body] of [
        ["POST", "/api/auth/api-key/create", { name: "escalate" }],
        ["GET", "/api/auth/api-key/list", undefined],
        ["POST", "/api/auth/api-key/update", { keyId: "x", name: "y" }],
        ["POST", "/api/auth/organization/create", { name: "x", slug: "x" }],
        ["POST", "/api/auth/admin/set-role", { userId: owner.userId, role: "admin" }],
      ] as const) {
        const res = await f.call(method, path, { "x-api-key": key }, body);
        expect([res.status, await errorOf(res)], `${method} ${path}`).toEqual([
          403,
          "api_key_not_allowed",
        ]);
      }
      expect((await f.sql("SELECT id FROM apikey")).length).toBe(keysBefore);
    }
    const [user] = await f.sql<{ role: string | null }>("SELECT role FROM user");
    expect(user.role).not.toBe("admin");
  });

  it("refuses the key even when a session cookie is sent alongside it", async () => {
    const key = await f.scopedKey(owner.userId, owner.orgId, ["project:read"]);
    const res = await f.call(
      "POST",
      "/api/auth/api-key/create",
      { "x-api-key": key, cookie: owner.cookie },
      { name: "escalate" },
    );
    expect(res.status).toBe(403);
    // And on app routes the key's scopes apply, not the cookie's full access.
    const env = await f.call(
      "POST",
      "/projects/x/env",
      { "x-api-key": key, cookie: owner.cookie },
      { key: "A", value: "b" },
    );
    expect([env.status, await errorOf(env)]).toEqual([403, "insufficient_scope"]);
  });

  it("still lets the dashboard (cookie only) create keys", async () => {
    expect((await f.legacyKey(owner.cookie)).startsWith("crk_sk_live_")).toBe(true);
  });
});

describe("key lifecycle", () => {
  let f: Fixture;
  let owner: Awaited<ReturnType<Fixture["signUp"]>>;
  beforeEach(async () => {
    f = createFixture();
    owner = await f.signUp("owner@example.com");
  });
  afterEach(() => f.cleanup());

  const projects = (key: string) => f.call("GET", "/projects", { "x-api-key": key });

  it("refuses a revoked, disabled or expired key with 401", async () => {
    const revoked = await f.scopedKey(owner.userId, owner.orgId, ["project:read"]);
    expect((await projects(revoked)).status).toBe(200);
    await f.sql("DELETE FROM apikey");
    expect((await projects(revoked)).status).toBe(401);

    const disabled = await f.scopedKey(owner.userId, owner.orgId, ["project:read"]);
    await f.sql("UPDATE apikey SET enabled = 0");
    expect((await projects(disabled)).status).toBe(401);

    const expired = await f.scopedKey(owner.userId, owner.orgId, ["project:read"]);
    // Better Auth stores expiresAt in seconds.
    await f.sql(
      "UPDATE apikey SET expiresAt = ? WHERE enabled = 1",
      Math.floor(Date.now() / 1000) - 10,
    );
    expect((await projects(expired)).status).toBe(401);
  });

  it("refuses a made-up key with 401", async () => {
    for (const key of ["crk_sk_live_" + "a".repeat(64), "x", "crk_sk_live_"]) {
      expect((await projects(key)).status, key).toBe(401);
    }
  });

  it("takes a change to a key's scopes on the next request", async () => {
    const key = await f.scopedKey(owner.userId, owner.orgId, ["project:read"]);
    expect((await projects(key)).status).toBe(200);
    await f.sql(
      "UPDATE apikey SET permissions = ?",
      JSON.stringify({ creek: [], creekTeam: [owner.orgId] }),
    );
    expect((await projects(key)).status).toBe(403);
  });

  it("refuses everything for a key whose stored scopes are unreadable", async () => {
    const key = await f.scopedKey(owner.userId, owner.orgId, ALL_SCOPES);
    await f.sql('UPDATE apikey SET permissions = \'{"creek":"*"}\'');
    const res = await projects(key);
    expect([res.status, await errorOf(res)]).toEqual([403, "invalid_key_scopes"]);
    // Refused before team resolution, whatever team the request names.
    const named = await f.call("GET", "/projects", { "x-api-key": key, "x-creek-team": "nope" });
    expect([named.status, await errorOf(named)]).toEqual([403, "invalid_key_scopes"]);
  });

  it("does not accept the key as a Bearer token", async () => {
    const key = await f.scopedKey(owner.userId, owner.orgId, ["project:read"]);
    expect((await f.call("GET", "/projects", { authorization: `Bearer ${key}` })).status).toBe(401);
  });
});

describe("platform admin endpoints", () => {
  let f: Fixture;
  let owner: Awaited<ReturnType<Fixture["signUp"]>>;
  beforeEach(async () => {
    f = createFixture();
    owner = await f.signUp("operator@example.com");
    await f.sql("UPDATE user SET role = 'admin'");
  });
  afterEach(() => f.cleanup());

  it("refuse a platform admin's scoped key, whatever its scopes", async () => {
    const key = await f.scopedKey(owner.userId, owner.orgId, ALL_SCOPES);
    const res = await f.call("GET", "/web-deploy/list", { "x-api-key": key });
    expect([res.status, await errorOf(res)]).toEqual([403, "forbidden"]);
  });

  it("still accept a platform admin's legacy key", async () => {
    const key = await f.legacyKey(owner.cookie);
    expect((await f.call("GET", "/web-deploy/list", { "x-api-key": key })).status).toBe(200);
  });
});
