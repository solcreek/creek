import { describe, test, expect } from "vitest";
import {
  parseHostnameWithTeams,
  getLimitsForPlan,
  PLAN_LIMITS,
  type TeamInfo,
} from "./parse.js";

const DOMAIN = "bycreek.com";

const teams: TeamInfo[] = [
  // Sorted by slug length DESC (longest first) — matches DB query
  { slug: "acme-corp", plan: "enterprise" },
  { slug: "acme", plan: "pro" },
  { slug: "bob", plan: "free" },
];

describe("parseHostnameWithTeams", () => {
  // --- Production ---

  test("production: {project}-{team}.domain", () => {
    const result = parseHostnameWithTeams("my-blog-acme.bycreek.com", DOMAIN, teams);
    expect(result).toEqual({
      type: "production",
      team: "acme",
      project: "my-blog",
    });
  });

  test("production: single-word project", () => {
    const result = parseHostnameWithTeams("app-bob.bycreek.com", DOMAIN, teams);
    expect(result).toEqual({
      type: "production",
      team: "bob",
      project: "app",
    });
  });

  // --- Branch preview ---

  test("branch: {project}-git-{branch}-{team}.domain", () => {
    const result = parseHostnameWithTeams(
      "my-blog-git-feat-auth-acme.bycreek.com",
      DOMAIN,
      teams,
    );
    expect(result).toEqual({
      type: "branch",
      team: "acme",
      project: "my-blog",
      branch: "feat-auth",
    });
  });

  test("branch: nested branch name", () => {
    const result = parseHostnameWithTeams(
      "app-git-fix-login-page-bob.bycreek.com",
      DOMAIN,
      teams,
    );
    expect(result).toEqual({
      type: "branch",
      team: "bob",
      project: "app",
      branch: "fix-login-page",
    });
  });

  // --- Deployment preview ---

  test("deployment: {project}-{8-hex}-{team}.domain", () => {
    const result = parseHostnameWithTeams(
      "my-blog-a1b2c3d4-acme.bycreek.com",
      DOMAIN,
      teams,
    );
    expect(result).toEqual({
      type: "deployment",
      team: "acme",
      project: "my-blog",
      deployId: "a1b2c3d4",
    });
  });

  test("deployment: only matches exactly 8 hex chars", () => {
    // 7 hex chars — should be production, not deployment
    const result = parseHostnameWithTeams(
      "my-blog-a1b2c3d-acme.bycreek.com",
      DOMAIN,
      teams,
    );
    expect(result.type).toBe("production");
  });

  test("deployment: uppercase hex is not matched", () => {
    const result = parseHostnameWithTeams(
      "my-blog-A1B2C3D4-acme.bycreek.com",
      DOMAIN,
      teams,
    );
    // A1B2C3D4 doesn't match /^[0-9a-f]{8}$/ — falls through to production
    expect(result.type).toBe("production");
  });

  // --- Custom domain ---

  test("custom: hostname not ending with domain", () => {
    const result = parseHostnameWithTeams("app.customer.com", DOMAIN, teams);
    expect(result).toEqual({
      type: "custom",
      customHostname: "app.customer.com",
    });
  });

  test("custom: bare domain", () => {
    const result = parseHostnameWithTeams("bycreek.com", DOMAIN, teams);
    expect(result).toEqual({
      type: "custom",
      customHostname: "bycreek.com",
    });
  });

  test("custom: multi-level subdomain", () => {
    const result = parseHostnameWithTeams(
      "deep.sub.bycreek.com",
      DOMAIN,
      teams,
    );
    expect(result).toEqual({
      type: "custom",
      customHostname: "deep.sub.bycreek.com",
    });
  });

  // --- Team slug matching ---

  test("longest team slug wins (acme-corp before acme)", () => {
    const result = parseHostnameWithTeams(
      "app-acme-corp.bycreek.com",
      DOMAIN,
      teams,
    );
    expect(result).toEqual({
      type: "production",
      team: "acme-corp",
      project: "app",
    });
  });

  test("unknown team slug → custom", () => {
    const result = parseHostnameWithTeams(
      "app-unknown.bycreek.com",
      DOMAIN,
      teams,
    );
    expect(result).toEqual({
      type: "custom",
      customHostname: "app-unknown.bycreek.com",
    });
  });

  test("team slug only (no project) → custom", () => {
    // "acme.bycreek.com" — sub = "acme", rest = "" → skip
    const result = parseHostnameWithTeams("acme.bycreek.com", DOMAIN, teams);
    expect(result).toEqual({
      type: "custom",
      customHostname: "acme.bycreek.com",
    });
  });

  // --- Edge cases ---

  test("empty teams list → everything is custom", () => {
    const result = parseHostnameWithTeams(
      "app-acme.bycreek.com",
      DOMAIN,
      [],
    );
    expect(result.type).toBe("custom");
  });

  test("project name with hyphens", () => {
    const result = parseHostnameWithTeams(
      "my-cool-app-bob.bycreek.com",
      DOMAIN,
      teams,
    );
    expect(result).toEqual({
      type: "production",
      team: "bob",
      project: "my-cool-app",
    });
  });
});

describe("getLimitsForPlan", () => {
  test("free plan limits", () => {
    expect(getLimitsForPlan("free")).toEqual({ cpuMs: 10, subRequests: 5 });
  });

  test("pro plan limits", () => {
    expect(getLimitsForPlan("pro")).toEqual({ cpuMs: 50, subRequests: 50 });
  });

  test("enterprise plan limits", () => {
    expect(getLimitsForPlan("enterprise")).toEqual({ cpuMs: 500, subRequests: 1000 });
  });

  test("unknown plan falls back to free", () => {
    expect(getLimitsForPlan("unknown")).toEqual(PLAN_LIMITS.free);
  });
});
