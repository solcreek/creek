import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { createFixture, type Fixture } from "../tenant/scoped-key-fixture.js";
import { scopedKeyPermissions } from "../tenant/api-key-grant.js";
import { MAX_ACTIVE_KEYS, isAuthKeyCreatePath } from "./cap.js";

/**
 * The per-user cap on active API keys, on both ways of minting one:
 * POST /api-keys and Better Auth's POST /api/auth/api-key/create.
 */

type Json = Record<string, any>;
const ORIGIN = "http://localhost:5173";

beforeAll(() => {
  vi.stubGlobal("fetch", async () => new Response("network disabled in tests", { status: 599 }));
});
afterAll(() => {
  vi.unstubAllGlobals();
});

let seq = 0;

/** Insert key rows directly: faster than minting, and any shape a real row can have. */
async function seedKeys(
  f: Fixture,
  userId: string,
  n: number,
  opts: { expiresAt?: number | null; permissions?: string | null; enabled?: boolean } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = opts.expiresAt === undefined ? now + 86_400 : opts.expiresAt;
  for (let i = 0; i < n; i++) {
    const id = `seed-${++seq}`;
    await f.sql(
      `INSERT INTO apikey (id, name, key, referenceId, enabled, expiresAt, permissions, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      "seed",
      `hash-${id}`,
      userId,
      opts.enabled === false ? 0 : 1,
      expiresAt,
      opts.permissions ?? null,
      now,
      now,
    );
  }
}

const count = async (f: Fixture, userId: string) =>
  (await f.sql<{ n: number }>("SELECT COUNT(*) AS n FROM apikey WHERE referenceId = ?", userId))[0]
    .n;

describe("POST /api-keys: the per-user key cap", () => {
  let f: Fixture;
  let owner: Awaited<ReturnType<Fixture["signUp"]>>;
  const create = () =>
    f.call(
      "POST",
      "/api-keys",
      { cookie: owner.cookie, origin: ORIGIN },
      { name: "agent", team: owner.orgSlug, scopes: ["project:read"] },
    );
  beforeEach(async () => {
    f = createFixture();
    owner = await f.signUp("owner@example.com");
  });
  afterEach(() => f.cleanup());

  it("is 50", () => {
    expect(MAX_ACTIVE_KEYS).toBe(50);
  });

  it("refuses a mint at the cap with 409, the limit and the count, counting legacy and scoped keys", async () => {
    await seedKeys(f, owner.userId, 20); // legacy (no permissions)
    await seedKeys(f, owner.userId, MAX_ACTIVE_KEYS - 20, {
      permissions: JSON.stringify(scopedKeyPermissions(["project:read"], owner.orgId)),
    });
    const res = await create();
    expect(res.status).toBe(409);
    const body = (await res.json()) as Json;
    expect(body).toMatchObject({
      error: "key_limit_reached",
      limit: MAX_ACTIVE_KEYS,
      active: MAX_ACTIVE_KEYS,
    });
    expect(body.message).toMatch(/revoke/i);
    expect(body.key).toBeUndefined();
    expect(await count(f, owner.userId)).toBe(MAX_ACTIVE_KEYS);
    // Nothing was minted, so nothing was audited.
    expect(await f.sql("SELECT id FROM audit_log WHERE action = 'api_key.create'")).toEqual([]);
  });

  it("mints the 50th key, then refuses the 51st", async () => {
    await seedKeys(f, owner.userId, MAX_ACTIVE_KEYS - 1);
    expect((await create()).status).toBe(201);
    const res = await create();
    expect(res.status).toBe(409);
    expect(((await res.json()) as Json).active).toBe(MAX_ACTIVE_KEYS);
  });

  it("does not count expired keys", async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    await seedKeys(f, owner.userId, MAX_ACTIVE_KEYS - 1);
    await seedKeys(f, owner.userId, 10, { expiresAt: past });
    expect((await create()).status).toBe(201);
  });

  it("counts keys that never expire and disabled keys (they can be re-enabled)", async () => {
    await seedKeys(f, owner.userId, 25, { expiresAt: null });
    await seedKeys(f, owner.userId, 25, { enabled: false });
    expect((await create()).status).toBe(409);
  });

  it("counts only the user's own keys", async () => {
    const other = await f.signUp("other@example.com");
    await seedKeys(f, other.userId, MAX_ACTIVE_KEYS);
    expect((await create()).status).toBe(201);
  });

  it("works again after revoking a key", async () => {
    await seedKeys(f, owner.userId, MAX_ACTIVE_KEYS);
    expect((await create()).status).toBe(409);
    await f.call("DELETE", "/api-keys/seed-" + seq, { cookie: owner.cookie, origin: ORIGIN });
    expect((await create()).status).toBe(201);
  });

  it("never exceeds the cap under concurrent mints", async () => {
    await seedKeys(f, owner.userId, MAX_ACTIVE_KEYS - 3);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const results = await Promise.all(Array.from({ length: 10 }, () => create()));
    vi.restoreAllMocks();
    const created = results.filter((r) => r.status === 201).length;
    for (const r of results) expect([201, 409]).toContain(r.status);
    expect(await count(f, owner.userId)).toBe(MAX_ACTIVE_KEYS - 3 + created);
    expect(await count(f, owner.userId)).toBeLessThanOrEqual(MAX_ACTIVE_KEYS);
  });
});

describe("POST /api/auth/api-key/create: the same cap", () => {
  let f: Fixture;
  let owner: Awaited<ReturnType<Fixture["signUp"]>>;
  const create = (path = "/api/auth/api-key/create") =>
    f.callRaw(
      "POST",
      path,
      { cookie: owner.cookie, origin: ORIGIN, "content-type": "application/json" },
      JSON.stringify({ name: "dash" }),
    );
  beforeEach(async () => {
    f = createFixture();
    owner = await f.signUp("owner@example.com");
  });
  afterEach(() => f.cleanup());

  it("mints below the cap and refuses at it", async () => {
    await seedKeys(f, owner.userId, MAX_ACTIVE_KEYS - 1);
    expect((await create()).status).toBe(200);
    const res = await create();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: "key_limit_reached",
      limit: MAX_ACTIVE_KEYS,
      active: MAX_ACTIVE_KEYS,
    });
    expect(await count(f, owner.userId)).toBe(MAX_ACTIVE_KEYS);
  });

  it("never exceeds the cap under concurrent creates", async () => {
    await seedKeys(f, owner.userId, MAX_ACTIVE_KEYS - 2);
    const results = await Promise.all(Array.from({ length: 8 }, () => create()));
    const created = results.filter((r) => r.status === 200).length;
    for (const r of results) expect([200, 409]).toContain(r.status);
    expect(await count(f, owner.userId)).toBe(MAX_ACTIVE_KEYS - 2 + created);
    expect(await count(f, owner.userId)).toBeLessThanOrEqual(MAX_ACTIVE_KEYS);
  });

  it("leaves other auth endpoints alone at the cap", async () => {
    await seedKeys(f, owner.userId, MAX_ACTIVE_KEYS);
    const res = await f.call("GET", "/api/auth/get-session", { cookie: owner.cookie });
    expect(res.status).toBe(200);
  });

  it("recognizes the create endpoint however it is spelled", () => {
    for (const p of [
      "/api/auth/api-key/create",
      "/api/auth/API-KEY/create",
      "/api/auth/api%2Dkey/create",
      "/api/auth/api%252Dkey/create",
      "/api/auth//api-key//create/",
    ]) {
      expect(isAuthKeyCreatePath(p), p).toBe(true);
    }
    for (const p of ["/api/auth/api-key/list", "/api/auth/api-key/delete", "/api/auth/sign-in"]) {
      expect(isAuthKeyCreatePath(p), p).toBe(false);
    }
  });
});
