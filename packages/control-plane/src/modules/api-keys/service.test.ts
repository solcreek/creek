import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { createFixture, type Fixture } from "../tenant/scoped-key-fixture.js";
import { createAuth } from "../tenant/auth.js";
import { DEFAULT_EXPIRES_IN, KeyMintError, mintScopedKey, type KeyAuthApi } from "./service.js";

/**
 * The one property key creation must keep: no apikey row is ever left
 * without its scopes, because such a row is a legacy key with its owner's
 * full access. These tests break the creation on purpose, against the real
 * Better Auth plugin and SQLite, and check what is left in the table.
 */

type User = Awaited<ReturnType<Fixture["signUp"]>>;

describe("mintScopedKey", () => {
  let f: Fixture;
  let owner: User;
  let auth: KeyAuthApi;
  beforeEach(async () => {
    f = createFixture();
    owner = await f.signUp("owner@example.com");
    auth = createAuth(f.env) as KeyAuthApi;
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    f.cleanup();
  });

  const input = () => ({
    userId: owner.userId,
    teamId: owner.orgId,
    name: "agent",
    scopes: ["project:read" as const],
    expiresIn: DEFAULT_EXPIRES_IN,
  });
  const rows = () =>
    f.sql<{ id: string; permissions: string | null }>("SELECT id, permissions FROM apikey");

  /** Better Auth's API, with createApiKey's body rewritten before it runs. */
  function rewriting(
    rewrite: (body: Record<string, unknown>) => Record<string, unknown>,
  ): KeyAuthApi {
    return {
      api: {
        createApiKey: (args) => auth.api.createApiKey({ body: rewrite(args.body) as never }),
      },
    };
  }

  it("stores the scopes in the same row Better Auth creates", async () => {
    const minted = await mintScopedKey(auth, f.env.DB, input());
    const [row] = await rows();
    expect(row.id).toBe(minted.id);
    expect(JSON.parse(row.permissions!)).toEqual({
      creek: ["project:read"],
      creekTeam: [owner.orgId],
    });
  });

  it("deletes the key when it was stored without its scopes (a legacy key)", async () => {
    const dropPermissions = rewriting(({ permissions: _p, ...rest }) => rest);
    await expect(mintScopedKey(dropPermissions, f.env.DB, input())).rejects.toThrow(KeyMintError);
    expect(await rows()).toEqual([]);
  });

  it("deletes the key when it was stored with other scopes or another team", async () => {
    const widen = rewriting((b) => ({
      ...b,
      permissions: { creek: ["project:read", "env:write"], creekTeam: [owner.orgId] },
    }));
    await expect(mintScopedKey(widen, f.env.DB, input())).rejects.toThrow(/scopes differ/);
    const moveTeam = rewriting((b) => ({
      ...b,
      permissions: { creek: ["project:read"], creekTeam: ["another-team"] },
    }));
    await expect(mintScopedKey(moveTeam, f.env.DB, input())).rejects.toThrow(/another team/);
    const garble = rewriting((b) => ({ ...b, permissions: { creek: ["project:read"] } }));
    await expect(mintScopedKey(garble, f.env.DB, input())).rejects.toThrow(/unreadable/);
    expect(await rows()).toEqual([]);
  });

  it("deletes the key when it was stored without an expiry", async () => {
    const noExpiry = rewriting(({ expiresIn: _e, ...rest }) => rest);
    await expect(mintScopedKey(noExpiry, f.env.DB, input())).rejects.toThrow(/expiry/);
    expect(await rows()).toEqual([]);
  });

  it("deletes the key when its scopes cannot be read back", async () => {
    // The permissions write happened (in the INSERT), but the check fails:
    // the key is deleted rather than returned unverified.
    const db = failing(f.env.DB, /^SELECT id, name, start, .* FROM apikey WHERE id = /);
    await expect(mintScopedKey(auth, db, input())).rejects.toThrow(/could not be verified/);
    expect(await rows()).toEqual([]);
  });

  it("deletes the key when Better Auth wrote the row and the scopes failed to land", async () => {
    // Simulate a separate permissions write failing after the key exists:
    // the row is created without permissions, then the "update" throws.
    const failedUpdate: KeyAuthApi = {
      api: {
        createApiKey: async (args) => {
          const { permissions: _p, ...rest } = args.body;
          await auth.api.createApiKey({ body: rest as never });
          throw new Error("permissions write failed");
        },
      },
    };
    await expect(mintScopedKey(failedUpdate, f.env.DB, input())).rejects.toThrow(
      "permissions write failed",
    );
    // The row Better Auth wrote is unscoped — the dangerous case. It must not survive.
    expect(await rows()).toEqual([]);
  });

  /** A works on /api-keys/self, against the real app. */
  const works = async (key: string) =>
    (await f.call("GET", "/api-keys/self", { "x-api-key": key })).status;

  it("deletes only its own row when it throws: a concurrent mint of the same grant survives", async () => {
    // Request B mints the same grant while A is in flight; then A throws
    // without having written anything.
    let b: { id: string; key: string } | undefined;
    const aThrows: KeyAuthApi = {
      api: {
        createApiKey: async () => {
          b = await mintScopedKey(auth, f.env.DB, input());
          throw new Error("A failed before writing");
        },
      },
    };
    await expect(mintScopedKey(aThrows, f.env.DB, input())).rejects.toThrow("A failed");
    expect((await rows()).map((r) => r.id)).toEqual([b!.id]);
    expect(await works(b!.key)).toBe(200);
  });

  it("deletes its own row and nothing else when it throws after writing", async () => {
    // A writes its row; B then mints the same grant and a legacy key appears
    // too; A throws. Only A's row goes.
    let b: { id: string; key: string } | undefined;
    let legacy: string | undefined;
    const aWritesThenThrows: KeyAuthApi = {
      api: {
        createApiKey: async (args) => {
          await auth.api.createApiKey(args);
          b = await mintScopedKey(auth, f.env.DB, input());
          legacy = await f.legacyKey(owner.cookie);
          throw new Error("A failed after writing");
        },
      },
    };
    await expect(mintScopedKey(aWritesThenThrows, f.env.DB, input())).rejects.toThrow("A failed");
    const left = await rows();
    expect(left).toHaveLength(2);
    expect(left.map((r) => r.id)).toContain(b!.id);
    expect(left.filter((r) => r.permissions === null)).toHaveLength(1);
    expect(await works(b!.key)).toBe(200);
    expect(await works(legacy!)).toBe(200);
  });

  it("deletes the key when it was stored without this attempt's tag", async () => {
    const dropTag = rewriting(({ metadata: _m, ...rest }) => rest);
    await expect(mintScopedKey(dropTag, f.env.DB, input())).rejects.toThrow(/tag/);
    expect(await rows()).toEqual([]);
  });
});

/** A D1 whose statements matching `pattern` throw. */
function failing(db: D1Database, pattern: RegExp): D1Database {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== "prepare") return Reflect.get(target, prop, receiver);
      return (query: string) => {
        if (pattern.test(query.trim())) throw new Error(`simulated failure: ${query}`);
        return target.prepare(query);
      };
    },
  }) as D1Database;
}
