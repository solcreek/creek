import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createFixture, type Fixture } from "../tenant/scoped-key-fixture.js";

/**
 * POST /api-keys when Better Auth stores a key without its scopes (as a
 * plugin regression would): the route answers 500 with no secret, and no
 * key is left behind. createAuth is wrapped so its createApiKey drops
 * `permissions` while `dropPermissions` is set.
 */

const state = vi.hoisted(() => ({ dropPermissions: false }));

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
          createApiKey: (args: { body: Record<string, unknown> }) => {
            if (!state.dropPermissions) return auth.api.createApiKey(args);
            const { permissions: _p, ...body } = args.body;
            return auth.api.createApiKey({ ...args, body });
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
