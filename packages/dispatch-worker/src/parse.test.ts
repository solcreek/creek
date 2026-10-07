import { describe, test, expect } from "vitest";
import {
  parseHostnameWithTeams,
  getLimitsForPlan,
  limitExceededBody,
  upgradeHintForPlan,
  PLANS,
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
    const result = parseHostnameWithTeams("my-blog-git-feat-auth-acme.bycreek.com", DOMAIN, teams);
    expect(result).toEqual({
      type: "branch",
      team: "acme",
      project: "my-blog",
      branch: "feat-auth",
    });
  });

  test("branch: nested branch name", () => {
    const result = parseHostnameWithTeams("app-git-fix-login-page-bob.bycreek.com", DOMAIN, teams);
    expect(result).toEqual({
      type: "branch",
      team: "bob",
      project: "app",
      branch: "fix-login-page",
    });
  });

  // --- Deployment preview ---

  test("deployment: {project}-{8-hex}-{team}.domain", () => {
    const result = parseHostnameWithTeams("my-blog-a1b2c3d4-acme.bycreek.com", DOMAIN, teams);
    expect(result).toEqual({
      type: "deployment",
      team: "acme",
      project: "my-blog",
      deployId: "a1b2c3d4",
    });
  });

  test("deployment: only matches exactly 8 hex chars", () => {
    // 7 hex chars — should be production, not deployment
    const result = parseHostnameWithTeams("my-blog-a1b2c3d-acme.bycreek.com", DOMAIN, teams);
    expect(result.type).toBe("production");
  });

  test("deployment: uppercase hex is not matched", () => {
    const result = parseHostnameWithTeams("my-blog-A1B2C3D4-acme.bycreek.com", DOMAIN, teams);
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
    const result = parseHostnameWithTeams("deep.sub.bycreek.com", DOMAIN, teams);
    expect(result).toEqual({
      type: "custom",
      customHostname: "deep.sub.bycreek.com",
    });
  });

  // --- Team slug matching ---

  test("longest team slug wins (acme-corp before acme)", () => {
    const result = parseHostnameWithTeams("app-acme-corp.bycreek.com", DOMAIN, teams);
    expect(result).toEqual({
      type: "production",
      team: "acme-corp",
      project: "app",
    });
  });

  test("unknown team slug → custom", () => {
    const result = parseHostnameWithTeams("app-unknown.bycreek.com", DOMAIN, teams);
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
    const result = parseHostnameWithTeams("app-acme.bycreek.com", DOMAIN, []);
    expect(result.type).toBe("custom");
  });

  test("project name with hyphens", () => {
    const result = parseHostnameWithTeams("my-cool-app-bob.bycreek.com", DOMAIN, teams);
    expect(result).toEqual({
      type: "production",
      team: "bob",
      project: "my-cool-app",
    });
  });
});

describe("getLimitsForPlan", () => {
  test("free plan limits", () => {
    expect(getLimitsForPlan("free")).toEqual({ cpuMs: 5_000, subRequests: 200 });
  });

  // Regression: starter is on the pricing page but had no entry, so a starter
  // team silently got free's limits.
  test("starter plan has its own limits", () => {
    expect(getLimitsForPlan("starter")).toEqual({ cpuMs: 10_000, subRequests: 1_000 });
  });

  test("pro plan limits", () => {
    expect(getLimitsForPlan("pro")).toEqual({ cpuMs: 20_000, subRequests: 5_000 });
  });

  test("enterprise plan limits", () => {
    expect(getLimitsForPlan("enterprise")).toEqual({ cpuMs: 30_000, subRequests: 10_000 });
  });

  test("every plan has limits", () => {
    expect(Object.keys(PLAN_LIMITS).sort()).toEqual([...PLANS].sort());
  });

  test("free plan CPU ceiling clears the heaviest observed production SSR request", () => {
    // Every production team is on free; the heaviest app's slowest successful
    // request took 3.9 s of CPU (30 days to 2026-10-07).
    expect(getLimitsForPlan("free").cpuMs).toBeGreaterThan(3_900);
  });

  test("limits never shrink going up the plans", () => {
    for (let i = 1; i < PLANS.length; i++) {
      const lower = PLAN_LIMITS[PLANS[i - 1]!];
      const higher = PLAN_LIMITS[PLANS[i]!];
      expect(higher.cpuMs).toBeGreaterThan(lower.cpuMs);
      expect(higher.subRequests).toBeGreaterThan(lower.subRequests);
    }
  });

  // Regression: enterprise was set to 120,000 ms against the general Workers
  // 5-minute ceiling, but Workers for Platforms caps a user worker's HTTP
  // invocation at 30 s of CPU, so the limit could never be granted.
  test("no plan exceeds the Workers for Platforms ceilings (30 s CPU, 10,000 subrequests)", () => {
    for (const limits of Object.values(PLAN_LIMITS)) {
      expect(limits.cpuMs).toBeLessThanOrEqual(30_000);
      expect(limits.subRequests).toBeLessThanOrEqual(10_000);
    }
  });

  test("unknown plan falls back to free", () => {
    expect(getLimitsForPlan("unknown")).toEqual(PLAN_LIMITS.free);
  });

  test("an inherited object key is not a plan", () => {
    expect(getLimitsForPlan("constructor")).toEqual(PLAN_LIMITS.free);
    expect(getLimitsForPlan("toString")).toEqual(PLAN_LIMITS.free);
  });
});

describe("upgradeHintForPlan", () => {
  test("points each plan at the next one up", () => {
    expect(upgradeHintForPlan("free")).toBe("Upgrade to Starter for higher limits.");
    expect(upgradeHintForPlan("starter")).toBe("Upgrade to Pro for higher limits.");
    expect(upgradeHintForPlan("pro")).toBe("Contact us about Enterprise for higher limits.");
  });

  test("has nothing to suggest on the top plan", () => {
    expect(upgradeHintForPlan("enterprise")).toBeUndefined();
  });

  test("treats an unknown plan as free", () => {
    expect(upgradeHintForPlan("unknown")).toBe(upgradeHintForPlan("free"));
  });
});

describe("limitExceededBody", () => {
  test("describes a CPU limit hit with the plan's ceiling and the next plan", () => {
    expect(limitExceededBody("Worker exceeded CPU time limit.", "free", PLAN_LIMITS.free)).toEqual({
      error: "cpu_limit_exceeded",
      message: "CPU time limit exceeded (5000ms on free plan).",
      upgrade: "Upgrade to Starter for higher limits.",
    });
  });

  test("describes a subrequest limit hit", () => {
    expect(limitExceededBody("Too many subrequests.", "starter", PLAN_LIMITS.starter)).toEqual({
      error: "subrequest_limit_exceeded",
      message: "Subrequest limit exceeded (1000 on starter plan).",
      upgrade: "Upgrade to Pro for higher limits.",
    });
  });

  test("omits the upgrade on the top plan", () => {
    const body = limitExceededBody("CPU time limit", "enterprise", PLAN_LIMITS.enterprise);
    expect(body?.upgrade).toBeUndefined();
    expect(JSON.parse(JSON.stringify(body))).not.toHaveProperty("upgrade");
  });

  // Regression: the matcher looked for "subrequest limit", but the runtime
  // throws "Too many subrequests.", so a real hit fell through to a 500.
  test.each([
    ["Too many subrequests.", "subrequest_limit_exceeded"],
    ["Error: TOO MANY SUBREQUESTS", "subrequest_limit_exceeded"],
    ["exceeded the Subrequest Limit", "subrequest_limit_exceeded"],
    ["Worker exceeded CPU time limit.", "cpu_limit_exceeded"],
    ["worker exceeded cpu time limit", "cpu_limit_exceeded"],
  ])("recognizes %j", (thrown, code) => {
    expect(limitExceededBody(thrown, "free", PLAN_LIMITS.free)?.error).toBe(code);
  });

  // Regression: an unknown plan is enforced with free's limits, but the
  // message named the raw value ("5000ms on legacy-beta plan").
  test("names the plan whose limits were enforced when the plan is unknown", () => {
    expect(
      limitExceededBody(
        "Worker exceeded CPU time limit.",
        "legacy-beta",
        getLimitsForPlan("legacy-beta"),
      ),
    ).toEqual({
      error: "cpu_limit_exceeded",
      message: "CPU time limit exceeded (5000ms on free plan).",
      upgrade: "Upgrade to Starter for higher limits.",
    });
    expect(
      limitExceededBody("Too many subrequests.", "legacy-beta", getLimitsForPlan("legacy-beta"))
        ?.message,
    ).toBe("Subrequest limit exceeded (200 on free plan).");
  });

  test("returns null for any other error", () => {
    expect(limitExceededBody("Network connection lost.", "free", PLAN_LIMITS.free)).toBeNull();
  });
});
