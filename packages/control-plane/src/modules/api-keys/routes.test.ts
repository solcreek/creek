import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { createFixture, type Fixture } from "../tenant/scoped-key-fixture.js";
import { ALL_SCOPES, SCOPE_PRESETS } from "../tenant/scopes.js";
import { DEFAULT_EXPIRES_IN, LEGACY_KEY_WARNING, MAX_EXPIRES_IN } from "./service.js";

/**
 * API key management end to end: the deployed Worker app, real Better Auth,
 * real SQLite. Keys are minted through POST /api-keys with a dashboard
 * session and then used the way an agent would.
 */

type Json = Record<string, any>;
const DAY = 86_400;

beforeAll(() => {
  vi.stubGlobal("fetch", async () => new Response("network disabled in tests", { status: 599 }));
});
afterAll(() => {
  vi.unstubAllGlobals();
});

async function json(res: Response): Promise<Json> {
  return (await res.json()) as Json;
}

type User = Awaited<ReturnType<Fixture["signUp"]>>;

function helpers(f: Fixture) {
  const session = (cookie: string) => ({ cookie, origin: "http://localhost:5173" });
  return {
    create: (cookie: string, body: unknown) => f.call("POST", "/api-keys", session(cookie), body),
    list: (cookie: string, team?: string) =>
      f.call("GET", `/api-keys${team ? `?team=${encodeURIComponent(team)}` : ""}`, session(cookie)),
    revoke: (cookie: string, id: string) =>
      f.call("DELETE", `/api-keys/${encodeURIComponent(id)}`, session(cookie)),
    self: (key: string) => f.call("GET", "/api-keys/self", { "x-api-key": key }),
    revokeSelf: (key: string) => f.call("DELETE", "/api-keys/self", { "x-api-key": key }),
    keyRows: () =>
      f.sql<{ id: string; referenceId: string; permissions: string | null; expiresAt: number }>(
        "SELECT id, referenceId, permissions, expiresAt FROM apikey",
      ),
  };
}

async function seedProject(f: Fixture, id: string, slug: string, orgId: string) {
  const now = Date.now();
  await f.sql(
    "INSERT INTO project (id, slug, organizationId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)",
    id,
    slug,
    orgId,
    now,
    now,
  );
}

describe("POST /api-keys", () => {
  let f: Fixture;
  let owner: User;
  let h: ReturnType<typeof helpers>;
  beforeEach(async () => {
    f = createFixture();
    h = helpers(f);
    owner = await f.signUp("owner@example.com");
    await seedProject(f, "proj-site", "site", owner.orgId);
  });
  afterEach(() => f.cleanup());

  it("mints a key from a preset, stored as the concrete scope list, returned once", async () => {
    const res = await h.create(owner.cookie, {
      name: "agent",
      team: owner.orgSlug,
      scopes: "read-only",
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await json(res);
    expect(body.key).toMatch(/^crk_sk_live_/);
    expect(body.team).toEqual({ id: owner.orgId, slug: owner.orgSlug });
    expect(body.preset).toBe("read-only");
    expect([...body.scopes].sort()).toEqual([...SCOPE_PRESETS["read-only"]].sort());
    expect(body.effectiveScopes).toEqual(body.scopes);
    expect(body.start).toBe(body.key.slice(0, 16));

    const [row] = await h.keyRows();
    expect(row.id).toBe(body.id);
    expect(row.referenceId).toBe(owner.userId);
    const stored = JSON.parse(row.permissions!);
    // The preset is expanded: no preset name is stored.
    expect(stored.creekTeam).toEqual([owner.orgId]);
    expect([...stored.creek].sort()).toEqual([...SCOPE_PRESETS["read-only"]].sort());
    expect(JSON.stringify(stored)).not.toContain("read-only");
  });

  it("mints a key with explicit scopes, deduplicated", async () => {
    const res = await h.create(owner.cookie, {
      name: "ci",
      team: owner.orgId,
      scopes: ["project:read", "env:read", "project:read"],
    });
    expect(res.status).toBe(201);
    expect((await json(res)).scopes).toEqual(["project:read", "env:read"]);
  });

  it("defaults the expiry to 90 days and accepts up to 365", async () => {
    const now = Date.now() / 1000;
    const def = await json(
      await h.create(owner.cookie, { name: "a", team: owner.orgSlug, scopes: ["project:read"] }),
    );
    const max = await json(
      await h.create(owner.cookie, {
        name: "b",
        team: owner.orgSlug,
        scopes: ["project:read"],
        expiresIn: MAX_EXPIRES_IN,
      }),
    );
    const rows = new Map((await h.keyRows()).map((r) => [r.id, r.expiresAt]));
    // Better Auth stores seconds.
    expect(rows.get(def.id)! - now).toBeGreaterThan(DEFAULT_EXPIRES_IN - 60);
    expect(rows.get(def.id)! - now).toBeLessThan(DEFAULT_EXPIRES_IN + 60);
    expect(rows.get(max.id)! - now).toBeGreaterThan(MAX_EXPIRES_IN - 60);
    expect(Math.abs(Date.parse(def.expiresAt) / 1000 - rows.get(def.id)!)).toBeLessThan(1);
  });

  it("refuses an expiry that is too long, too short, not a number or null", async () => {
    for (const expiresIn of [
      MAX_EXPIRES_IN + 1,
      10 * 365 * DAY,
      DAY - 1,
      0,
      -1,
      1.5,
      "90d",
      null,
    ]) {
      const res = await h.create(owner.cookie, {
        name: "x",
        team: owner.orgSlug,
        scopes: ["project:read"],
        expiresIn,
      });
      expect([res.status, (await json(res)).error], String(expiresIn)).toEqual([
        400,
        "invalid_expiry",
      ]);
    }
    expect(await h.keyRows()).toEqual([]);
  });

  it("refuses unknown scopes, unknown presets, empty or missing scopes, and unknown fields", async () => {
    const cases: [unknown, string][] = [
      [
        { name: "x", team: owner.orgSlug, scopes: ["project:read", "project:admin"] },
        "unknown_scope",
      ],
      [{ name: "x", team: owner.orgSlug, scopes: ["*"] }, "unknown_scope"],
      [{ name: "x", team: owner.orgSlug, scopes: "everything" }, "unknown_preset"],
      [{ name: "x", team: owner.orgSlug, scopes: [] }, "validation"],
      [{ name: "x", team: owner.orgSlug }, "validation"],
      [{ team: owner.orgSlug, scopes: ["project:read"] }, "validation"],
      [{ name: "x".repeat(33), team: owner.orgSlug, scopes: ["project:read"] }, "validation"],
      [{ name: "x", scopes: ["project:read"] }, "validation"],
      [
        {
          name: "x",
          team: owner.orgSlug,
          scopes: ["project:read"],
          permissions: { creek: ["env:write"] },
        },
        "unknown_field",
      ],
      [{ name: "x", team: owner.orgSlug, scopes: ["project:read"], userId: "u" }, "unknown_field"],
      [[], "validation"],
    ];
    for (const [body, error] of cases) {
      const res = await h.create(owner.cookie, body);
      expect([res.status, (await json(res)).error], JSON.stringify(body)).toEqual([400, error]);
    }
    const unknown = await json(
      await h.create(owner.cookie, { name: "x", team: owner.orgSlug, scopes: ["nope"] }),
    );
    expect(unknown.scopes).toEqual(["nope"]);
    expect(await h.keyRows()).toEqual([]);
  });

  it("refuses values of the wrong JSON type with a 400, never coercing them", async () => {
    const base = { name: "x", team: owner.orgSlug, scopes: ["project:read"] };
    const cases: [Record<string, unknown>, string, string?][] = [
      // Objects whose string conversion throws (toString/valueOf not functions).
      [{ ...base, scopes: [{ toString: null }] }, "validation", "scopes[0]"],
      [
        { ...base, scopes: ["project:read", { toString: null, valueOf: null }] },
        "validation",
        "scopes[1]",
      ],
      [{ ...base, scopes: [42] }, "validation", "number"],
      [{ ...base, scopes: [null] }, "validation", "null"],
      [{ ...base, scopes: [["project:read"]] }, "validation", "array"],
      [{ ...base, scopes: [true] }, "validation", "boolean"],
      [{ ...base, scopes: { toString: null } }, "validation"],
      [{ ...base, scopes: 7 }, "validation"],
      [{ ...base, name: { toString: null } }, "validation"],
      [{ ...base, name: ["x"] }, "validation"],
      [{ ...base, name: 5 }, "validation"],
      [{ ...base, team: { toString: null } }, "validation"],
      [{ ...base, team: ["team"] }, "validation"],
      [{ ...base, team: null }, "validation"],
      [{ ...base, expiresIn: { toString: null, valueOf: null } }, "invalid_expiry"],
      [{ ...base, expiresIn: [86400] }, "invalid_expiry"],
      [{ ...base, expiresIn: "86400" }, "invalid_expiry"],
      [{ ...base, expiresInDays: 30 }, "unknown_field"],
      [{ ...base, teamId: owner.orgId }, "unknown_field"],
    ];
    for (const [body, error, mentions] of cases) {
      const res = await h.create(owner.cookie, body);
      const out = await json(res);
      expect([res.status, out.error], JSON.stringify(body)).toEqual([400, error]);
      if (mentions) expect(out.message).toContain(mentions);
    }
    expect(await h.keyRows()).toEqual([]);
  });

  it("clips user-supplied strings it echoes back", async () => {
    const long = "x".repeat(500);
    const preset = await json(
      await h.create(owner.cookie, { name: "x", team: owner.orgSlug, scopes: long }),
    );
    expect(preset.error).toBe("unknown_preset");
    expect(preset.message.length).toBeLessThan(200);
    const scope = await json(
      await h.create(owner.cookie, { name: "x", team: owner.orgSlug, scopes: [long] }),
    );
    expect(scope.error).toBe("unknown_scope");
    expect(JSON.stringify(scope)).not.toContain(long);
  });

  it("refuses a non-JSON body", async () => {
    const res = await f.call("POST", "/api-keys", { cookie: owner.cookie }, undefined);
    expect(res.status).toBe(415);
    expect(await h.keyRows()).toEqual([]);
  });

  it("refuses scopes the creator's role in that team does not grant, listing them", async () => {
    const member = await f.signUp("member@example.com");
    await f.sql(
      "INSERT INTO member (id, userId, organizationId, role, createdAt) VALUES ('m-x', ?, ?, 'member', ?)",
      member.userId,
      owner.orgId,
      Date.now(),
    );
    const res = await h.create(member.cookie, {
      name: "x",
      team: owner.orgSlug,
      scopes: ["project:read", "env:write", "project:delete"],
    });
    expect(res.status).toBe(403);
    const body = await json(res);
    expect(body.error).toBe("scope_exceeds_role");
    expect(body.role).toBe("member");
    expect(body.scopes).toEqual(["project:delete", "env:write"]);
    expect(body.allowedScopes).toContain("project:read");
    expect(body.allowedScopes).not.toContain("env:write");
    // The "full" preset is beyond a member too.
    const full = await h.create(member.cookie, { name: "x", team: owner.orgSlug, scopes: "full" });
    expect([full.status, (await json(full)).error]).toEqual([403, "scope_exceeds_role"]);
    // What the role allows is fine.
    const ok = await h.create(member.cookie, {
      name: "x",
      team: owner.orgSlug,
      scopes: "agent-preview",
    });
    expect(ok.status).toBe(201);
    expect((await h.keyRows()).length).toBe(1);
  });

  it("lets an owner mint the full preset", async () => {
    const res = await h.create(owner.cookie, { name: "x", team: owner.orgSlug, scopes: "full" });
    expect(res.status).toBe(201);
    expect((await json(res)).scopes).toEqual(ALL_SCOPES);
  });

  it("refuses a team the user does not belong to, by slug or id", async () => {
    const other = await f.signUp("other@example.com");
    for (const team of [other.orgSlug, other.orgId, "no-such-team"]) {
      const res = await h.create(owner.cookie, { name: "x", team, scopes: ["project:read"] });
      expect([res.status, (await json(res)).error], team).toEqual([404, "team_not_found"]);
    }
    expect(await h.keyRows()).toEqual([]);
  });

  it("refuses every API key, scoped or legacy, even with a session cookie alongside", async () => {
    const scoped = await f.scopedKey(owner.userId, owner.orgId, ALL_SCOPES);
    const legacy = await f.legacyKey(owner.cookie);
    const before = (await h.keyRows()).length;
    for (const key of [scoped, legacy]) {
      const variants: Record<string, string>[] = [
        { "x-api-key": key },
        { "x-api-key": key, cookie: owner.cookie },
      ];
      for (const headers of variants) {
        const res = await f.call("POST", "/api-keys", headers, {
          name: "escalate",
          team: owner.orgSlug,
          scopes: "full",
        });
        expect([res.status, (await json(res)).error]).toEqual([403, "api_key_not_allowed"]);
      }
    }
    expect((await h.keyRows()).length).toBe(before);
  });

  it("refuses an unauthenticated request and a signed-out session", async () => {
    const anon = await f.call("POST", "/api-keys", {}, { name: "x", team: "t", scopes: "full" });
    expect(anon.status).toBe(401);
    await f.sql("DELETE FROM session");
    const res = await h.create(owner.cookie, {
      name: "x",
      team: owner.orgSlug,
      scopes: ["project:read"],
    });
    expect(res.status).toBe(401);
    expect(await h.keyRows()).toEqual([]);
  });

  it("refuses an impersonated session", async () => {
    await f.sql("UPDATE session SET impersonatedBy = 'some-admin'");
    const res = await h.create(owner.cookie, {
      name: "x",
      team: owner.orgSlug,
      scopes: ["project:read"],
    });
    expect([res.status, (await json(res)).error]).toEqual([403, "forbidden"]);
    expect(await h.keyRows()).toEqual([]);
  });

  it("never returns the mint attempt's tag (create, list, self)", async () => {
    const res = await h.create(owner.cookie, {
      name: "agent",
      team: owner.orgSlug,
      scopes: ["project:read"],
    });
    const createText = await res.text();
    const { key, id } = JSON.parse(createText);
    const [row] = await f.sql<{ metadata: string }>("SELECT metadata FROM apikey WHERE id = ?", id);
    const nonce = JSON.stringify(row.metadata).match(/[0-9a-f-]{72}/)?.[0];
    expect(nonce).toBeTruthy();
    const texts = [
      createText,
      await (await h.list(owner.cookie)).text(),
      await (await h.list(owner.cookie, owner.orgSlug)).text(),
      await (await h.self(key)).text(),
    ];
    for (const text of texts) {
      expect(text).not.toContain(nonce);
      expect(text).not.toContain("creekMintNonce");
      expect(text).not.toContain("metadata");
    }
  });

  it("records the creation in the audit log, without the secret", async () => {
    const body = await json(
      await h.create(owner.cookie, { name: "audited", team: owner.orgSlug, scopes: "read-only" }),
    );
    const rows = await f.sql<{
      action: string;
      teamId: string;
      resourceId: string;
      metadata: string;
    }>("SELECT action, teamId, resourceId, metadata FROM audit_log");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "api_key.create",
      teamId: owner.orgId,
      resourceId: body.id,
    });
    expect(JSON.parse(rows[0].metadata)).toMatchObject({ name: "audited", preset: "read-only" });
    expect(rows[0].metadata).not.toContain(body.key);
  });
});

describe("a minted key does exactly what its scopes allow, in its team only", () => {
  let f: Fixture;
  let owner: User;
  let h: ReturnType<typeof helpers>;
  beforeEach(async () => {
    f = createFixture();
    h = helpers(f);
    owner = await f.signUp("owner@example.com");
    await seedProject(f, "proj-site", "site", owner.orgId);
    await f.sql(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES ('org-b', 'B', 'team-b', ?)",
      Date.now(),
    );
    await f.sql(
      "INSERT INTO member (id, userId, organizationId, role, createdAt) VALUES ('m-b', ?, 'org-b', 'owner', ?)",
      owner.userId,
      Date.now(),
    );
    await seedProject(f, "proj-b", "site-b", "org-b");
  });
  afterEach(() => f.cleanup());

  it("calls a route its scopes cover and is refused one they do not", async () => {
    const { key } = await json(
      await h.create(owner.cookie, {
        name: "reader",
        team: owner.orgSlug,
        scopes: ["project:read", "env:read"],
      }),
    );
    const list = await f.call("GET", "/projects", { "x-api-key": key });
    expect(list.status).toBe(200);
    expect(JSON.stringify(await json(list))).toContain("site");
    expect((await f.call("GET", "/projects/site/env", { "x-api-key": key })).status).toBe(200);

    const set = await f.call(
      "POST",
      "/projects/site/env",
      { "x-api-key": key },
      { key: "A", value: "b" },
    );
    expect(set.status).toBe(403);
    const body = await json(set);
    expect(body.error).toBe("insufficient_scope");
    expect(body.required).toEqual(["env:write"]);
    expect(body.granted).toEqual(["env:read", "project:read"]);
    expect(await f.sql("SELECT * FROM environment_variable")).toEqual([]);
  });

  it("is pinned to the team it was minted for", async () => {
    const { key } = await json(
      await h.create(owner.cookie, { name: "b", team: "team-b", scopes: ["project:read"] }),
    );
    const own = await f.call("GET", "/projects", { "x-api-key": key });
    expect(own.status).toBe(200);
    const projects = JSON.stringify(await json(own));
    expect(projects).toContain("site-b");
    expect(projects).not.toContain('"site"');
    const other = await f.call("GET", "/projects", {
      "x-api-key": key,
      "x-creek-team": owner.orgSlug,
    });
    expect([other.status, (await json(other)).error]).toEqual([403, "team_mismatch"]);
    expect((await f.call("GET", "/projects/proj-site", { "x-api-key": key })).status).toBe(404);
  });
});

describe("GET /api-keys/self", () => {
  let f: Fixture;
  let owner: User;
  let h: ReturnType<typeof helpers>;
  beforeEach(async () => {
    f = createFixture();
    h = helpers(f);
    owner = await f.signUp("owner@example.com");
  });
  afterEach(() => f.cleanup());

  it("describes a scoped key: scopes, team, role, effective scopes, expiry, no secret", async () => {
    const created = await json(
      await h.create(owner.cookie, { name: "agent", team: owner.orgSlug, scopes: "agent-preview" }),
    );
    const res = await h.self(created.key);
    expect(res.status).toBe(200);
    const self = await json(res);
    expect(self).toMatchObject({
      id: created.id,
      name: "agent",
      start: created.start,
      legacy: false,
      team: { id: owner.orgId, slug: owner.orgSlug },
      role: "owner",
      access: "scoped",
      expiresAt: created.expiresAt,
      expired: false,
      enabled: true,
    });
    expect([...self.scopes].sort()).toEqual([...SCOPE_PRESETS["agent-preview"]].sort());
    expect(self.effectiveScopes).toEqual(self.scopes);
    expect(self.lastUsedAt).not.toBeNull();
    expect(self.warning).toBeUndefined();
    const text = JSON.stringify(self);
    expect(text).not.toContain(created.key);
    expect(Object.keys(self)).not.toContain("key");
  });

  it("works for a key with no scopes at all", async () => {
    const key = await f.scopedKey(owner.userId, owner.orgId, []);
    const self = await json(await h.self(key));
    expect(self).toMatchObject({ scopes: [], effectiveScopes: [], access: "none" });
  });

  it("shrinks effective scopes with the owner's current role", async () => {
    const { key } = await json(
      await h.create(owner.cookie, {
        name: "x",
        team: owner.orgSlug,
        scopes: ["project:read", "env:write"],
      }),
    );
    await f.sql("UPDATE member SET role = 'member'");
    const self = await json(await h.self(key));
    expect(self.role).toBe("member");
    expect(self.scopes).toEqual(["project:read", "env:write"]);
    expect(self.effectiveScopes).toEqual(["project:read"]);
  });

  it("reports a key whose owner left its team, instead of refusing to answer", async () => {
    const { key } = await json(
      await h.create(owner.cookie, { name: "x", team: owner.orgSlug, scopes: ["project:read"] }),
    );
    await f.sql("DELETE FROM member");
    const self = await json(await h.self(key));
    expect(self).toMatchObject({ role: null, effectiveScopes: [], access: "none" });
    expect(self.warning).toMatch(/no longer a member/);
  });

  it("describes a legacy key as full access with the sunset warning", async () => {
    const key = await f.legacyKey(owner.cookie);
    const res = await h.self(key);
    expect(res.status).toBe(200);
    const self = await json(res);
    expect(self).toMatchObject({
      legacy: true,
      access: "full",
      scopes: null,
      effectiveScopes: null,
      team: null,
      warning: LEGACY_KEY_WARNING,
    });
  });

  it("describes a key with unreadable scopes as having no access", async () => {
    const key = await f.scopedKey(owner.userId, owner.orgId, ["project:read"]);
    await f.sql("UPDATE apikey SET permissions = '{\"creek\":1}'");
    const self = await json(await h.self(key));
    expect(self).toMatchObject({ access: "none", effectiveScopes: [], legacy: false });
  });

  it("refuses an expired, revoked or made-up key with 401", async () => {
    const { key } = await json(
      await h.create(owner.cookie, { name: "x", team: owner.orgSlug, scopes: ["project:read"] }),
    );
    await f.sql("UPDATE apikey SET expiresAt = ?", Math.floor(Date.now() / 1000) - 10);
    expect((await h.self(key)).status).toBe(401);
    expect((await h.self("crk_sk_live_" + "a".repeat(64))).status).toBe(401);
  });

  it("turns a session away with a pointer to GET /api-keys", async () => {
    const res = await f.call("GET", "/api-keys/self", { cookie: owner.cookie });
    const body = await json(res);
    expect([res.status, body.error]).toEqual([400, "api_key_required"]);
    expect(body.message).toContain("GET /api-keys");
  });
});

describe("GET /api-keys", () => {
  let f: Fixture;
  let owner: User;
  let h: ReturnType<typeof helpers>;
  beforeEach(async () => {
    f = createFixture();
    h = helpers(f);
    owner = await f.signUp("owner@example.com");
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

  it("lists the user's keys without secrets, filtered by team", async () => {
    const a = await json(
      await h.create(owner.cookie, { name: "a", team: owner.orgSlug, scopes: "read-only" }),
    );
    const b = await json(
      await h.create(owner.cookie, { name: "b", team: "team-b", scopes: ["project:read"] }),
    );
    const legacy = await f.legacyKey(owner.cookie);
    // Someone else's key never shows up.
    const other = await f.signUp("other@example.com");
    await f.legacyKey(other.cookie);

    const all = await h.list(owner.cookie);
    expect(all.status).toBe(200);
    const { keys } = await json(all);
    expect(keys.map((k: Json) => k.name).sort()).toEqual(["a", "b", "legacy"]);
    const text = JSON.stringify(keys);
    for (const secret of [a.key, b.key, legacy]) expect(text).not.toContain(secret);
    for (const k of keys) expect(Object.keys(k)).not.toContain("key");
    const legacyView = keys.find((k: Json) => k.legacy);
    expect(legacyView).toMatchObject({ scopes: null, team: null, warning: LEGACY_KEY_WARNING });
    expect(keys.find((k: Json) => k.name === "b").team).toEqual({ id: "org-b", slug: "team-b" });

    const teamB = (await json(await h.list(owner.cookie, "team-b"))).keys;
    expect(teamB.map((k: Json) => k.name).sort()).toEqual(["b", "legacy"]);
    const byId = (await json(await h.list(owner.cookie, owner.orgId))).keys;
    expect(byId.map((k: Json) => k.name).sort()).toEqual(["a", "legacy"]);
  });

  it("shows a key with unreadable scopes only in the unfiltered list, marked unreadable", async () => {
    const scoped = await json(
      await h.create(owner.cookie, { name: "ok", team: owner.orgSlug, scopes: ["project:read"] }),
    );
    await f.legacyKey(owner.cookie);
    const broken = await json(
      await h.create(owner.cookie, { name: "broken", team: "team-b", scopes: ["project:read"] }),
    );
    await f.sql("UPDATE apikey SET permissions = '{\"creek\":1}' WHERE id = ?", broken.id);

    const all = (await json(await h.list(owner.cookie))).keys as Json[];
    expect(all.map((k) => k.name).sort()).toEqual(["broken", "legacy", "ok"]);
    const shown = all.find((k) => k.id === broken.id)!;
    expect(shown).toMatchObject({ unreadable: true, legacy: false, scopes: [], team: null });
    expect(shown.warning).toMatch(/unreadable/);
    expect(all.find((k) => k.id === scoped.id)!.unreadable).toBeUndefined();

    for (const team of [owner.orgSlug, "team-b", owner.orgId]) {
      const keys = (await json(await h.list(owner.cookie, team))).keys as Json[];
      expect(
        keys.map((k) => k.id),
        team,
      ).not.toContain(broken.id);
      expect(
        keys.some((k) => k.legacy),
        team,
      ).toBe(true);
    }
    // And the owner can still revoke it.
    expect((await h.revoke(owner.cookie, broken.id)).status).toBe(200);
  });

  it("refuses a team the user is not in, and API keys", async () => {
    const other = await f.signUp("other@example.com");
    const res = await h.list(owner.cookie, other.orgSlug);
    expect([res.status, (await json(res)).error]).toEqual([404, "team_not_found"]);
    const key = await f.scopedKey(owner.userId, owner.orgId, ALL_SCOPES);
    const byKey = await f.call("GET", "/api-keys", { "x-api-key": key });
    expect([byKey.status, (await json(byKey)).error]).toEqual([403, "api_key_not_allowed"]);
  });
});

describe("revoking keys", () => {
  let f: Fixture;
  let owner: User;
  let h: ReturnType<typeof helpers>;
  beforeEach(async () => {
    f = createFixture();
    h = helpers(f);
    owner = await f.signUp("owner@example.com");
  });
  afterEach(() => f.cleanup());

  const mint = async (cookie: string, team: string) =>
    json(await h.create(cookie, { name: "k", team, scopes: ["project:read"] }));

  it("revokes one of the user's keys, which then stops working", async () => {
    const created = await mint(owner.cookie, owner.orgSlug);
    expect((await f.call("GET", "/projects", { "x-api-key": created.key })).status).toBe(200);
    const res = await h.revoke(owner.cookie, created.id);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ revoked: true, id: created.id });
    expect((await f.call("GET", "/projects", { "x-api-key": created.key })).status).toBe(401);
    expect((await h.self(created.key)).status).toBe(401);
    expect(await h.keyRows()).toEqual([]);
    // Twice is not found.
    expect((await h.revoke(owner.cookie, created.id)).status).toBe(404);

    const [audit] = await f.sql<{ action: string; resourceId: string; metadata: string }>(
      "SELECT action, resourceId, metadata FROM audit_log WHERE action = 'api_key.revoke'",
    );
    expect(audit.resourceId).toBe(created.id);
    expect(JSON.parse(audit.metadata).via).toBe("session");
  });

  it("does not let a user revoke another user's key", async () => {
    const other = await f.signUp("other@example.com");
    const theirs = await mint(other.cookie, other.orgSlug);
    const res = await h.revoke(owner.cookie, theirs.id);
    expect([res.status, (await json(res)).error]).toEqual([404, "not_found"]);
    expect((await h.keyRows()).map((r) => r.id)).toEqual([theirs.id]);
    expect((await f.call("GET", "/projects", { "x-api-key": theirs.key })).status).toBe(200);
  });

  it("does not let a key revoke another key, even its owner's", async () => {
    const target = await mint(owner.cookie, owner.orgSlug);
    for (const key of [
      await f.scopedKey(owner.userId, owner.orgId, ALL_SCOPES),
      await f.legacyKey(owner.cookie),
    ]) {
      const res = await f.call("DELETE", `/api-keys/${target.id}`, { "x-api-key": key });
      expect([res.status, (await json(res)).error]).toEqual([403, "api_key_not_allowed"]);
    }
    expect((await h.keyRows()).map((r) => r.id)).toContain(target.id);
  });

  it("lets a key revoke itself, scoped or legacy, and nothing else", async () => {
    const keep = await mint(owner.cookie, owner.orgSlug);
    const drop = await mint(owner.cookie, owner.orgSlug);
    const res = await h.revokeSelf(drop.key);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ revoked: true, id: drop.id });
    expect((await h.keyRows()).map((r) => r.id)).toEqual([keep.id]);
    expect((await h.self(drop.key)).status).toBe(401);
    expect((await h.self(keep.key)).status).toBe(200);

    const legacy = await f.legacyKey(owner.cookie);
    expect((await h.revokeSelf(legacy)).status).toBe(200);
    expect((await h.keyRows()).map((r) => r.id)).toEqual([keep.id]);

    const [audit] = await f.sql<{ metadata: string }>(
      "SELECT metadata FROM audit_log WHERE action = 'api_key.revoke' AND resourceId = ?",
      drop.id,
    );
    expect(JSON.parse(audit.metadata).via).toBe("self");
  });

  it("does not treat DELETE /api-keys/self from a session as a key id", async () => {
    await mint(owner.cookie, owner.orgSlug);
    const res = await f.call("DELETE", "/api-keys/self", { cookie: owner.cookie });
    expect([res.status, (await json(res)).error]).toEqual([400, "api_key_required"]);
    expect((await h.keyRows()).length).toBe(1);
  });

  it("refuses a cross-site revoke", async () => {
    const created = await mint(owner.cookie, owner.orgSlug);
    const res = await f.call("DELETE", `/api-keys/${created.id}`, {
      cookie: owner.cookie,
      origin: "https://evil.example",
    });
    expect(res.status).toBe(403);
    expect((await h.keyRows()).length).toBe(1);
  });
});
