import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createFixture, type Fixture } from "../tenant/scoped-key-fixture.js";
import { MAX_ACTIVE_KEYS } from "./cap.js";

/**
 * POST /api-keys when Better Auth stores a key without its scopes (as a
 * plugin regression would): the route answers 500 with no secret, and no
 * key is left behind. createAuth is wrapped so its createApiKey drops
 * `permissions` while `dropPermissions` is set.
 *
 * After the key has been created and verified: a failing database read
 * must not leave it live without returning its secret, and a failing
 * creation audit must delete it (no key exists without its audit).
 * `afterCreate` runs right after Better Auth creates the key.
 *
 * Revocation is the other way round: it stays done even when its audit
 * cannot be written.
 */

const state = vi.hoisted(() => ({
  dropPermissions: false,
  afterCreate: null as null | (() => Promise<void>),
}));

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

  it("deletes the key and answers 500 without the secret when the creation audit fails", async () => {
    const owner = await f.signUp("owner@example.com");
    state.afterCreate = async () => {
      await f.sql("ALTER TABLE audit_log RENAME TO audit_log_gone");
    };
    const res = await create(owner.cookie, owner.orgSlug);
    state.afterCreate = null;
    await f.sql("ALTER TABLE audit_log_gone RENAME TO audit_log");

    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text).error).toBe("key_create_failed");
    expect(text).not.toContain("crk_sk_live_");
    expect(await f.sql("SELECT id FROM apikey")).toEqual([]);
  });

  it("deletes its own key, and only that, when a concurrent mint took the last slot under the cap", async () => {
    const owner = await f.signUp("owner@example.com");
    for (let i = 0; i < MAX_ACTIVE_KEYS - 1; i++) {
      await f.scopedKey(owner.userId, owner.orgId, ["project:read"]);
    }
    // Another mint lands between this one's first cap check and its insert.
    let racer: string | undefined;
    state.afterCreate = async () => {
      state.afterCreate = null;
      racer = await f.scopedKey(owner.userId, owner.orgId, ["env:read"]);
    };
    const res = await create(owner.cookie, owner.orgSlug);

    expect(res.status).toBe(409);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({
      error: "key_limit_reached",
      limit: MAX_ACTIVE_KEYS,
      active: MAX_ACTIVE_KEYS,
    });
    expect(text).not.toContain("crk_sk_live_");
    const rows = await f.sql<{ permissions: string }>("SELECT permissions FROM apikey");
    expect(rows).toHaveLength(MAX_ACTIVE_KEYS);
    // The racer's key survives; the refused mint's key (project:read) is gone.
    expect(rows.filter((r) => r.permissions.includes("env:read"))).toHaveLength(1);
    expect((await f.call("GET", "/api-keys/self", { "x-api-key": racer! })).status).toBe(200);
    expect(await f.sql("SELECT id FROM audit_log WHERE action = 'api_key.create'")).toEqual([]);
  });
});

describe("revoking a key when its audit cannot be written", () => {
  let f: Fixture;
  beforeEach(() => {
    f = createFixture();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    f.cleanup();
  });

  const mint = async (cookie: string, team: string) =>
    (await (
      await f.call("POST", "/api-keys", { cookie }, { name: "k", team, scopes: ["project:read"] })
    ).json()) as { id: string; key: string };

  it("still revokes by session when the audit table is gone", async () => {
    const owner = await f.signUp("owner@example.com");
    const created = await mint(owner.cookie, owner.orgSlug);
    await f.sql("ALTER TABLE audit_log RENAME TO audit_log_gone");
    const res = await f.call("DELETE", `/api-keys/${created.id}`, { cookie: owner.cookie });
    await f.sql("ALTER TABLE audit_log_gone RENAME TO audit_log");
    expect(res.status).toBe(200);
    expect(await f.sql("SELECT id FROM apikey")).toEqual([]);
    expect((await f.call("GET", "/projects", { "x-api-key": created.key })).status).toBe(401);
  });

  it("still revokes a key itself when the audit table is gone", async () => {
    const owner = await f.signUp("owner@example.com");
    const created = await mint(owner.cookie, owner.orgSlug);
    await f.sql("ALTER TABLE audit_log RENAME TO audit_log_gone");
    const res = await f.call("DELETE", "/api-keys/self", { "x-api-key": created.key });
    await f.sql("ALTER TABLE audit_log_gone RENAME TO audit_log");
    expect(res.status).toBe(200);
    expect(await f.sql("SELECT id FROM apikey")).toEqual([]);
  });

  it("answers 200 for a legacy key's self-revoke when the audit team lookup fails", async () => {
    const owner = await f.signUp("owner@example.com");
    const key = await f.legacyKey(owner.cookie);
    // A legacy key's audit goes under the owner's first team, looked up
    // through member: break that lookup after the key is authenticated.
    await f.sql("ALTER TABLE member RENAME TO member_gone");
    const res = await f.call("DELETE", "/api-keys/self", { "x-api-key": key });
    await f.sql("ALTER TABLE member_gone RENAME TO member");
    expect(res.status).toBe(200);
    expect(await f.sql("SELECT id FROM apikey")).toEqual([]);
  });
});

describe("revoking a scoped key when its team cannot be read", () => {
  let f: Fixture;
  beforeEach(() => {
    f = createFixture();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    f.cleanup();
  });

  // Either the revoke happened (200, key gone) or it did not (500, key
  // live). Never an error for a key that is already deleted.
  for (const via of ["session", "self"] as const) {
    it(`via ${via}: never answers an error after deleting the key`, async () => {
      const owner = await f.signUp("owner@example.com");
      const created = (await (
        await f.call(
          "POST",
          "/api-keys",
          { cookie: owner.cookie },
          { name: "k", team: owner.orgSlug, scopes: ["project:read"] },
        )
      ).json()) as { id: string; key: string };

      await f.sql("ALTER TABLE organization RENAME TO organization_gone");
      const res =
        via === "session"
          ? await f.call("DELETE", `/api-keys/${created.id}`, { cookie: owner.cookie })
          : await f.call("DELETE", "/api-keys/self", { "x-api-key": created.key });
      await f.sql("ALTER TABLE organization_gone RENAME TO organization");

      const left = await f.sql<{ id: string }>("SELECT id FROM apikey");
      const outcome = [res.status, left.length];
      expect([
        [200, 0],
        [500, 1],
      ]).toContainEqual(outcome);
      // With the slug lookup best-effort, the revoke goes through.
      expect(outcome).toEqual([200, 0]);
    });
  }
});
