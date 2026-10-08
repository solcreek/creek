import { describe, it, expect } from "vitest";
import { Hono, type MiddlewareHandler } from "hono";
import {
  apiKeyAuthRouteGuard,
  apiKeyRouteGate,
  assertScope,
  deployScopeFor,
  guardInfo,
  publicRoute,
  requireAnyScope,
  requireScopes,
} from "./scope-guard.js";
import { ALL_SCOPES, type Scope } from "./scopes.js";
import type { ApiKeyGrant } from "./api-key-grant.js";

/**
 * The intended policy, written out by hand rather than derived from
 * SCOPES/ROLE_PERMISSIONS, so a change to either table that alters who can
 * do what fails here until this table is changed on purpose.
 */
const ROLE_SCOPES: Record<string, ReadonlySet<Scope>> = {
  owner: new Set(ALL_SCOPES),
  admin: new Set(ALL_SCOPES.filter((s) => s !== "project:delete")),
  member: new Set<Scope>([
    "project:read",
    "deploy:preview",
    "deploy:production",
    "env:read",
    "domain:read",
    "resource:read",
    "logs:read",
    "github:read",
    "queue:send",
  ]),
};
const ROLES = ["owner", "admin", "member", "viewer", undefined] as const;

type Ctx = { grant?: ApiKeyGrant; role?: string; key?: boolean };

function run(guard: MiddlewareHandler, ctx: Ctx) {
  const app = new Hono<{ Variables: { apiKeyGrant?: ApiKeyGrant; memberRole?: string } }>();
  let reached = false;
  app.use("*", async (c, next) => {
    if (ctx.grant) c.set("apiKeyGrant", ctx.grant);
    if (ctx.role) c.set("memberRole", ctx.role);
    await next();
  });
  app.get("/r", guard, (c) => {
    reached = true;
    return c.json({ ok: true });
  });
  const headers: Record<string, string> = ctx.key === false ? {} : { "x-api-key": "k" };
  return Promise.resolve(app.request("/r", { headers })).then(async (res) => ({
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
    reached,
  }));
}

const scoped = (scopes: Scope[]): ApiKeyGrant => ({
  kind: "scoped",
  keyId: "k",
  scopes: new Set(scopes),
  teamId: "t",
});

/** Deterministic PRNG (mulberry32) so a failure reproduces from its seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function subset(rand: () => number, p: number): Scope[] {
  return ALL_SCOPES.filter(() => rand() < p);
}

describe("requireScopes / requireAnyScope against the hand-written policy", () => {
  it("agrees with the policy on 4000 random grants, roles and requirements", async () => {
    const rand = rng(0xc0ffee);
    for (let i = 0; i < 4000; i++) {
      const held = subset(rand, rand());
      const role = ROLES[Math.floor(rand() * ROLES.length)];
      const mode = rand() < 0.5 ? "all" : "any";
      let required = subset(rand, 0.15);
      if (required.length < (mode === "any" ? 2 : 1))
        required = ALL_SCOPES.slice(i % 15, (i % 15) + 2);
      const guard = mode === "all" ? requireScopes(...required) : requireAnyScope(...required);

      const usable = (s: Scope) => held.includes(s) && !!role && !!ROLE_SCOPES[role]?.has(s);
      const expected = mode === "all" ? required.every(usable) : required.some(usable);

      const res = await run(guard, { grant: scoped(held), role });
      const label = `#${i} held=[${held}] role=${role} ${mode}=[${required}]`;
      expect(res.reached, label).toBe(expected);
      expect(res.status, label).toBe(expected ? 200 : 403);
      if (!expected) {
        expect(["insufficient_scope", "insufficient_role"], label).toContain(res.body.error);
      }
    }
  });

  it("names the missing scope, and tells a missing scope from a missing role", async () => {
    const lacking = await run(requireScopes("env:write"), {
      grant: scoped(["env:read"]),
      role: "owner",
    });
    expect(lacking.body).toMatchObject({
      error: "insufficient_scope",
      required: ["env:write"],
      granted: ["env:read"],
    });
    const demoted = await run(requireScopes("env:write"), {
      grant: scoped(["env:write"]),
      role: "member",
    });
    expect(demoted.body.error).toBe("insufficient_role");
    expect(demoted.reached).toBe(false);
  });

  it("lets non-key requests and legacy keys through untouched", async () => {
    const guard = requireScopes("project:delete");
    expect((await run(guard, { key: false })).reached).toBe(true);
    expect((await run(guard, { key: false, grant: scoped([]) })).reached).toBe(true);
    expect(
      (await run(guard, { grant: { kind: "legacy", keyId: "k" }, role: "member" })).reached,
    ).toBe(true);
  });

  it("fails closed for a key request with no grant loaded, or an invalid one", async () => {
    const guard = requireScopes("project:read");
    const unresolved = await run(guard, { role: "owner" });
    expect(unresolved).toMatchObject({ status: 403, reached: false });
    expect(unresolved.body.error).toBe("scope_unresolved");
    const invalid = await run(guard, { grant: { kind: "invalid", keyId: "k" }, role: "owner" });
    expect(invalid).toMatchObject({ status: 403, reached: false });
  });

  it("refuses to build a guard that requires nothing", () => {
    expect(() => requireScopes()).toThrow();
    expect(() => requireAnyScope("project:read")).toThrow();
  });
});

describe("assertScope + deployScopeFor", () => {
  it("treats no branch and the production branch as production", () => {
    expect(deployScopeFor(undefined, "main")).toBe("deploy:production");
    expect(deployScopeFor(null, "main")).toBe("deploy:production");
    expect(deployScopeFor("", "main")).toBe("deploy:production");
    expect(deployScopeFor("main", "main")).toBe("deploy:production");
    expect(deployScopeFor("feature", "main")).toBe("deploy:preview");
    expect(deployScopeFor("Main", "main")).toBe("deploy:preview");
  });

  it("denies inside a handler exactly as a guard would", async () => {
    const handlerCheck: MiddlewareHandler = async (c, next) =>
      assertScope(c, "deploy:production") ?? next();
    expect(
      (await run(handlerCheck, { grant: scoped(["deploy:preview"]), role: "owner" })).status,
    ).toBe(403);
    expect(
      (await run(handlerCheck, { grant: scoped(["deploy:production"]), role: "member" })).status,
    ).toBe(200);
  });
});

describe("apiKeyAuthRouteGuard", () => {
  function authApp() {
    const app = new Hono();
    app.on(["GET", "POST"], "/api/auth/*", apiKeyAuthRouteGuard, (c) => c.json({ reached: true }));
    return app;
  }
  const call = (method: string, path: string, key = true) =>
    authApp().request(path, { method, headers: key ? { "x-api-key": "k" } : {} });

  it("lets a key read its session and nothing else", async () => {
    expect((await call("GET", "/api/auth/get-session")).status).toBe(200);
    for (const [method, path] of [
      ["POST", "/api/auth/api-key/create"],
      ["POST", "/api/auth/api-key/update"],
      ["POST", "/api/auth/api-key/delete"],
      ["GET", "/api/auth/api-key/list"],
      ["POST", "/api/auth/organization/create"],
      ["POST", "/api/auth/organization/invite-member"],
      ["POST", "/api/auth/admin/set-role"],
      ["POST", "/api/auth/change-email"],
      ["POST", "/api/auth/delete-user"],
      ["POST", "/api/auth/get-session"],
      ["GET", "/api/auth/get-session/"],
      ["GET", "/api/auth/GET-SESSION"],
      ["GET", "/api/auth//get-session"],
      ["GET", "/api/auth/get%2Dsession"],
      ["GET", "/api/auth/get-session/../api-key/list"],
    ]) {
      const res = await call(method, path);
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });

  it("leaves session (cookie) requests to Better Auth", async () => {
    expect((await call("POST", "/api/auth/api-key/create", false)).status).toBe(200);
  });
});

describe("apiKeyRouteGate", () => {
  function gatedApp(reached: string[]) {
    const app = new Hono();
    app.use("*", apiKeyRouteGate);
    app.get("/guarded", requireScopes("project:read"), (c) => {
      reached.push("guarded");
      return c.text("ok");
    });
    app.get("/public", publicRoute, (c) => {
      reached.push("public");
      return c.text("ok");
    });
    app.get("/unguarded", (c) => {
      reached.push("unguarded");
      return c.text("ok");
    });
    // Guard after the endpoint: runs too late to protect it.
    app.get("/late", (c) => {
      reached.push("late");
      return c.text("ok");
    });
    app.get("/late", requireScopes("project:read"));
    return app;
  }

  it("refuses a key request to an endpoint without a guard, before it runs", async () => {
    const reached: string[] = [];
    const app = gatedApp(reached);
    for (const path of ["/unguarded", "/late"]) {
      const res = await app.request(path, { headers: { "x-api-key": "k" } });
      expect(res.status, path).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe("route_not_scoped");
    }
    // HEAD is dispatched as GET: same verdict.
    expect(
      (await app.request("/unguarded", { method: "HEAD", headers: { "X-API-KEY": "k" } })).status,
    ).toBe(403);
    expect(reached).toEqual([]);
  });

  it("does not touch requests without a key, or guarded routes", async () => {
    const reached: string[] = [];
    const app = gatedApp(reached);
    expect((await app.request("/unguarded")).status).toBe(200);
    expect((await app.request("/public", { headers: { "x-api-key": "k" } })).status).toBe(200);
    expect(reached).toEqual(["unguarded", "public"]);
  });

  it("sees a guard through Hono's sub-app error wrapper", () => {
    const guard = requireScopes("project:read");
    const wrapped = Object.assign(async () => {}, { __COMPOSED_HANDLER: guard });
    expect(guardInfo(wrapped)).toEqual({ kind: "scopes", mode: "all", scopes: ["project:read"] });
    expect(guardInfo(async () => {})).toBeUndefined();
  });
});
