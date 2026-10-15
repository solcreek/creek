import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { createFixture, type Fixture } from "../tenant/scoped-key-fixture.js";
import { TEAM_ROLES } from "../tenant/permissions.js";
import {
  ALL_SCOPES,
  SCOPES,
  SCOPE_IMPACTS,
  SCOPE_PRESETS,
  SCOPE_RISKS,
  type ScopePreset,
} from "../tenant/scopes.js";
import { buildScopeCatalog } from "./catalog.js";
import { scopesBeyondRole } from "./service.js";

type Json = Record<string, any>;

describe("buildScopeCatalog", () => {
  const catalog = buildScopeCatalog();

  it("lists every registered scope once, in registry order", () => {
    expect(catalog.scopes.map((s) => s.name)).toEqual(ALL_SCOPES);
  });

  it("gives every scope a description, a risk, an impact and a minimum role", () => {
    for (const s of catalog.scopes) {
      expect(s.description.trim().length, s.name).toBeGreaterThan(0);
      expect(s.description, s.name).toBe(SCOPES[s.name].description);
      expect(SCOPE_RISKS, s.name).toContain(s.risk);
      expect(s.risk, s.name).toBe(SCOPES[s.name].risk);
      expect(SCOPE_IMPACTS, s.name).toContain(s.impact);
      expect(TEAM_ROLES, s.name).toContain(s.minRole);
    }
  });

  // The catalog's minimum roles are what POST /api-keys enforces.
  it("names, for each scope, exactly the roles that may grant it", () => {
    for (const s of catalog.scopes) {
      for (const role of TEAM_ROLES) {
        const allowed = TEAM_ROLES.indexOf(role) >= TEAM_ROLES.indexOf(s.minRole);
        expect(scopesBeyondRole(role, [s.name]), `${role} ${s.name}`).toEqual(
          allowed ? [] : [s.name],
        );
      }
    }
  });

  it("lists every preset with its concrete scopes and the role that can mint all of them", () => {
    expect(catalog.presets.map((p) => p.name)).toEqual(Object.keys(SCOPE_PRESETS));
    for (const p of catalog.presets) {
      expect(p.description.trim().length, p.name).toBeGreaterThan(0);
      expect([...p.scopes].sort(), p.name).toEqual([...SCOPE_PRESETS[p.name]].sort());
      expect(scopesBeyondRole(p.minRole, p.scopes), p.name).toEqual([]);
      const below = TEAM_ROLES[TEAM_ROLES.indexOf(p.minRole) - 1];
      if (below) expect(scopesBeyondRole(below, p.scopes).length, p.name).toBeGreaterThan(0);
    }
    const role = (name: ScopePreset) => catalog.presets.find((p) => p.name === name)!.minRole;
    expect(role("read-only")).toBe("member");
    expect(role("full")).toBe("owner");
  });
});

describe("GET /api-keys/scopes", () => {
  let f: Fixture;
  let owner: Awaited<ReturnType<Fixture["signUp"]>>;
  const get = (headers: Record<string, string>) => f.call("GET", "/api-keys/scopes", headers);

  beforeAll(() => {
    vi.stubGlobal("fetch", async () => new Response("network disabled in tests", { status: 599 }));
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });
  beforeEach(async () => {
    f = createFixture();
    owner = await f.signUp("owner@example.com");
  });
  afterEach(() => f.cleanup());

  it("serves the catalog to a session", async () => {
    const res = await get({ cookie: owner.cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await res.json()).toEqual(JSON.parse(JSON.stringify(buildScopeCatalog())));
  });

  it("serves it to any key: one narrow scope, no scopes, unreadable scopes, legacy", async () => {
    const narrow = await f.scopedKey(owner.userId, owner.orgId, ["logs:read"]);
    const none = await f.scopedKey(owner.userId, owner.orgId, []);
    const legacy = await f.legacyKey(owner.cookie);
    const unreadable = await f.scopedKey(owner.userId, owner.orgId, ["project:read"]);
    await f.sql("UPDATE apikey SET permissions = '{bad' WHERE permissions LIKE '%project:read%'");
    for (const key of [narrow, none, legacy, unreadable]) {
      const res = await get({ "x-api-key": key });
      expect(res.status).toBe(200);
      expect(((await res.json()) as Json).scopes).toHaveLength(ALL_SCOPES.length);
    }
  });

  it("refuses an unauthenticated request and a made-up or revoked key", async () => {
    expect((await get({})).status).toBe(401);
    expect((await get({ "x-api-key": "crk_sk_live_nope" })).status).toBe(401);
    const key = await f.scopedKey(owner.userId, owner.orgId, ["logs:read"]);
    await f.sql("DELETE FROM apikey");
    expect((await get({ "x-api-key": key })).status).toBe(401);
  });

  it("sends an ETag and private cache headers, and answers 304 when it matches", async () => {
    const res = await get({ cookie: owner.cookie });
    const etag = res.headers.get("etag");
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(res.headers.get("cache-control")).toBe("private, max-age=300");

    const key = await f.scopedKey(owner.userId, owner.orgId, ["logs:read"]);
    for (const ifNoneMatch of [etag!, `W/${etag}`, `"other", ${etag}`, "*"]) {
      const again = await get({ "x-api-key": key, "if-none-match": ifNoneMatch });
      expect(again.status, ifNoneMatch).toBe(304);
      expect(again.headers.get("etag")).toBe(etag);
      expect(again.headers.get("cache-control")).toBe("private, max-age=300");
      expect(await again.text()).toBe("");
    }
    expect((await get({ cookie: owner.cookie, "if-none-match": '"other"' })).status).toBe(200);
  });

  it("does not answer 304 to an unauthenticated request", async () => {
    const etag = (await get({ cookie: owner.cookie })).headers.get("etag")!;
    expect((await get({ "if-none-match": etag })).status).toBe(401);
  });
});
