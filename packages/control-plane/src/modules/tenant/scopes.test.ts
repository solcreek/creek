import { describe, it, expect } from "vitest";
import { ALL_SCOPES, SCOPES, SCOPE_PRESETS, isScope } from "./scopes.js";
import { parseGrant, scopedKeyPermissions } from "./api-key-grant.js";
import { roleGrants, type Permission } from "./permissions.js";

describe("scope registry", () => {
  it("maps every scope to a role permission that some role holds", () => {
    for (const scope of ALL_SCOPES) {
      const perm = SCOPES[scope].rolePermission as Permission;
      expect(roleGrants("owner", perm), scope).toBe(true);
    }
  });

  it("names scopes as resource:action", () => {
    for (const scope of ALL_SCOPES) expect(scope).toMatch(/^[a-z]+:[a-z]+$/);
  });

  it("builds presets only from registered scopes, without duplicates", () => {
    for (const [name, scopes] of Object.entries(SCOPE_PRESETS)) {
      for (const s of scopes) expect(isScope(s), `${name}: ${s}`).toBe(true);
      expect(new Set(scopes).size, name).toBe(scopes.length);
    }
  });

  it("keeps read-only free of anything that writes", () => {
    for (const s of SCOPE_PRESETS["read-only"]) expect(s).toMatch(/:read$/);
  });

  // Not "away from data": deploy:preview code runs with production bindings
  // (see its description). This only keeps the direct scopes out.
  it("keeps agent-preview away from production deploys and direct data scopes", () => {
    const preset: readonly string[] = SCOPE_PRESETS["agent-preview"];
    for (const s of ["deploy:production", "env:write", "db:query", "resource:delete"]) {
      expect(preset).not.toContain(s);
    }
  });

  it("rates every scope that can reach secrets, production or data as high risk", () => {
    for (const s of [
      "deploy:preview",
      "deploy:production",
      "env:write",
      "db:query",
      "resource:delete",
      "project:delete",
      "domain:write",
    ] as const) {
      expect(SCOPES[s].risk, s).toBe("high");
    }
  });

  it("does not treat inherited object keys as scopes", () => {
    for (const s of ["constructor", "__proto__", "toString", "hasOwnProperty", ""]) {
      expect(isScope(s)).toBe(false);
    }
  });
});

describe("roleGrants", () => {
  it("grants nothing to unknown, missing or prototype-named roles", () => {
    for (const role of [undefined, null, "", "superuser", "constructor", "__proto__"]) {
      expect(roleGrants(role, "project:read")).toBe(false);
    }
  });
});

describe("parseGrant", () => {
  it("treats a key with no permissions as legacy", () => {
    expect(parseGrant("k", null)).toEqual({ kind: "legacy", keyId: "k" });
  });

  it("reads what scopedKeyPermissions writes", () => {
    const stored = JSON.stringify(
      scopedKeyPermissions(["env:read", "env:read", "logs:read"], "t1"),
    );
    const grant = parseGrant("k", stored);
    expect(grant.kind).toBe("scoped");
    if (grant.kind !== "scoped") return;
    expect([...grant.scopes].sort()).toEqual(["env:read", "logs:read"]);
    expect(grant.teamId).toBe("t1");
  });

  it("keeps a scoped key with no scopes as scoped (it can do nothing)", () => {
    const grant = parseGrant("k", JSON.stringify({ creek: [], creekTeam: ["t1"] }));
    expect(grant.kind === "scoped" && grant.scopes.size).toBe(0);
  });

  it("drops scopes it does not know instead of failing open", () => {
    const grant = parseGrant(
      "k",
      JSON.stringify({
        creek: ["env:read", "env:*", "*", "admin", "constructor"],
        creekTeam: ["t"],
      }),
    );
    expect(grant.kind === "scoped" && [...grant.scopes]).toEqual(["env:read"]);
  });

  it.each([
    ["not JSON", "{creek"],
    ["JSON null", "null"],
    ["an array", "[]"],
    ["a string", '"env:read"'],
    ["missing creek", JSON.stringify({ creekTeam: ["t"] })],
    ["creek not an array", JSON.stringify({ creek: "env:read", creekTeam: ["t"] })],
    ["creek with a non-string", JSON.stringify({ creek: ["env:read", 1], creekTeam: ["t"] })],
    ["missing team", JSON.stringify({ creek: ["env:read"] })],
    ["empty team", JSON.stringify({ creek: ["env:read"], creekTeam: [""] })],
    ["two teams", JSON.stringify({ creek: ["env:read"], creekTeam: ["a", "b"] })],
    ["team not a string", JSON.stringify({ creek: ["env:read"], creekTeam: [1] })],
    ["team as a string", JSON.stringify({ creek: ["env:read"], creekTeam: "t" })],
  ])("treats %s as invalid", (_label, stored) => {
    expect(parseGrant("k", stored).kind).toBe("invalid");
  });
});
