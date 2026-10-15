import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createFixture, type Fixture } from "../tenant/scoped-key-fixture.js";

/**
 * The key cap on Better Auth's POST /api/auth/api-key/create fails closed:
 * when the session lookup that finds whose keys to count throws (as on a
 * transient database error), Better Auth's create never runs and no key is
 * minted. createAuth is wrapped so getSession rejects while
 * `failGetSession` is set, and handler calls on the create path are counted.
 */

const state = vi.hoisted(() => ({
  failGetSession: false,
  createCalls: 0,
}));

vi.mock("../tenant/auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tenant/auth.js")>();
  return {
    ...actual,
    createAuth: (env: unknown) => {
      const auth = actual.createAuth(env as never);
      return {
        ...auth,
        handler: async (req: Request) => {
          if (new URL(req.url).pathname.includes("api-key/create")) state.createCalls++;
          return auth.handler(req);
        },
        api: {
          ...auth.api,
          getSession: async (args: unknown) => {
            if (state.failGetSession) throw new Error("D1_ERROR: database is locked");
            return auth.api.getSession(args);
          },
        },
      };
    },
  };
});

const ORIGIN = "http://localhost:5173";

describe("POST /api/auth/api-key/create when the cap's session lookup fails", () => {
  let f: Fixture;
  beforeEach(() => {
    f = createFixture();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    state.failGetSession = false;
    state.createCalls = 0;
    vi.restoreAllMocks();
    f.cleanup();
  });

  const create = (cookie: string) =>
    f.callRaw(
      "POST",
      "/api/auth/api-key/create",
      { cookie, origin: ORIGIN, "content-type": "application/json" },
      JSON.stringify({ name: "dash" }),
    );

  it("refuses with 500 and never runs Better Auth's create", async () => {
    const owner = await f.signUp("owner@example.com");
    state.failGetSession = true;
    const res = await create(owner.cookie);
    state.failGetSession = false;

    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text).error).toBe("key_create_failed");
    expect(text).not.toContain("crk_sk_live_");
    expect(text).not.toContain("database is locked");
    expect(state.createCalls).toBe(0);
    expect(await f.sql("SELECT id FROM apikey")).toEqual([]);
  });

  it("still lets a request with no session through to Better Auth, which refuses it", async () => {
    const res = await create("");
    expect(res.status).toBe(401);
    expect(state.createCalls).toBe(1);
    expect(await f.sql("SELECT id FROM apikey")).toEqual([]);
  });

  it("mints normally once the lookup works", async () => {
    const owner = await f.signUp("owner@example.com");
    expect((await create(owner.cookie)).status).toBe(200);
    expect(state.createCalls).toBe(1);
  });
});
