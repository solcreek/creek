import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createFixture, type Fixture } from "../tenant/scoped-key-fixture.js";

/**
 * POST /api-keys when Better Auth stores a key without its scopes (as a
 * plugin regression would): the route answers 500 with no secret, and no
 * key is left behind. createAuth is wrapped so its createApiKey drops
 * `permissions` while `dropPermissions` is set.
 *
 * And the opposite: once a key has been created and verified, nothing
 * after it (a failing database read, a failing audit write) may leave the
 * key live without returning its secret. `afterCreate` runs right after
 * Better Auth creates the key; `auditThrows` makes recordAudit throw.
 */

const state = vi.hoisted(() => ({
  dropPermissions: false,
  afterCreate: null as null | (() => Promise<void>),
  auditThrows: false,
}));

vi.mock("../audit/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../audit/service.js")>();
  return {
    ...actual,
    recordAudit: (...args: Parameters<typeof actual.recordAudit>) => {
      if (state.auditThrows) throw new Error("audit unavailable");
      return actual.recordAudit(...args);
    },
  };
});

vi.mock("../tenant/auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tenant/auth.js")>();
  return {
    ...actual,
    createAuth: (env: unknown) => {
      const auth = actual.createAuth(env as never);
      return {
        ...auth,
        api: {
          ...auth.api,
          createApiKey: async (args: { body: Record<string, unknown> }) => {
            let created;
            if (!state.dropPermissions) created = await auth.api.createApiKey(args);
            else {
              const { permissions: _p, ...body } = args.body;
              created = await auth.api.createApiKey({ ...args, body });
            }
            await state.afterCreate?.();
            return created;
          },
        },
      };
    },
  };
});

describe("POST /api-keys when the scopes do not land", () => {
  let f: Fixture;
  beforeEach(() => {
    f = createFixture();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    state.dropPermissions = false;
    state.afterCreate = null;
    state.auditThrows = false;
    vi.restoreAllMocks();
    f.cleanup();
  });

  it("answers 500 without a key and leaves no key behind", async () => {
    const owner = await f.signUp("owner@example.com");
    state.dropPermissions = true;
    const res = await f.call(
      "POST",
      "/api-keys",
      { cookie: owner.cookie },
      { name: "agent", team: owner.orgSlug, scopes: ["project:read"] },
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("key_create_failed");
    expect(body.key).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("crk_sk_live_");
    expect(await f.sql("SELECT id FROM apikey")).toEqual([]);
    expect(await f.sql("SELECT id FROM audit_log")).toEqual([]);
  });

  it("works again once the scopes land", async () => {
    const owner = await f.signUp("owner@example.com");
    const res = await f.call(
      "POST",
      "/api-keys",
      { cookie: owner.cookie },
      { name: "agent", team: owner.orgSlug, scopes: ["project:read"] },
    );
    expect(res.status).toBe(201);
  });
});

describe("POST /api-keys after the key exists", () => {
  let f: Fixture;
  beforeEach(() => {
    f = createFixture();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    state.afterCreate = null;
    state.auditThrows = false;
    vi.restoreAllMocks();
    f.cleanup();
  });

  const create = (cookie: string, team: string) =>
    f.call("POST", "/api-keys", { cookie }, { name: "agent", team, scopes: ["project:read"] });

  it("returns the secret even when team and membership reads fail after the mint", async () => {
    const owner = await f.signUp("owner@example.com");
    // The key row is verified; then every team and membership read breaks.
    state.afterCreate = async () => {
      await f.sql("ALTER TABLE organization RENAME TO organization_gone");
      await f.sql("ALTER TABLE member RENAME TO member_gone");
    };
    const res = await create(owner.cookie, owner.orgSlug);
    state.afterCreate = null;
    await f.sql("ALTER TABLE organization_gone RENAME TO organization");
    await f.sql("ALTER TABLE member_gone RENAME TO member");

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, any>;
    expect(body.key).toMatch(/^crk_sk_live_/);
    expect(body.team).toEqual({ id: owner.orgId, slug: owner.orgSlug });
    expect(body.effectiveScopes).toEqual(["project:read"]);
    // The one live key is the one whose secret was returned.
    const rows = await f.sql<{ id: string }>("SELECT id FROM apikey");
    expect(rows.map((r) => r.id)).toEqual([body.id]);
    expect((await f.call("GET", "/api-keys/self", { "x-api-key": body.key })).status).toBe(200);
  });

  it("returns the secret when the audit write throws, and the key works", async () => {
    const owner = await f.signUp("owner@example.com");
    state.auditThrows = true;
    const res = await create(owner.cookie, owner.orgSlug);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, any>;
    expect(body.key).toMatch(/^crk_sk_live_/);
    expect((await f.sql<{ id: string }>("SELECT id FROM apikey")).map((r) => r.id)).toEqual([
      body.id,
    ]);
    state.auditThrows = false;
    expect((await f.call("GET", "/projects", { "x-api-key": body.key })).status).toBe(200);
  });
});
