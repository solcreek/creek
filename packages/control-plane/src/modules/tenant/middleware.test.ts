import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { resolveTeam } from "./resolve.js";
import { createLocalTestEnv, type LocalTestEnv } from "../../local/test-env.js";

/**
 * Tests for resolveTeam() — the real team resolution function
 * used by tenantMiddleware. Uses real SQLite via createLocalTestEnv.
 */

let testEnv: LocalTestEnv;

const USER_ID = "user-1";

beforeEach(() => {
  testEnv = createLocalTestEnv();
  // Insert the test user (needed for FK or just to have a user row)
  const now = Date.now();
  testEnv.db.db.exec(
    `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('${USER_ID}', 'Test User', 'test@example.com', 0, ${now}, ${now})`,
  );
});

afterEach(() => {
  testEnv.cleanup();
});

function seedOrg(orgId: string, slug: string) {
  const now = Date.now();
  testEnv.db.db.exec(
    `INSERT OR IGNORE INTO organization (id, name, slug, createdAt) VALUES ('${orgId}', '${slug}', '${slug}', ${now})`,
  );
}

function seedMembership(orgId: string, userId: string = USER_ID) {
  const now = Date.now();
  const memId = `mem-${orgId}-${userId}`;
  testEnv.db.db.exec(
    `INSERT OR IGNORE INTO member (id, userId, organizationId, role, createdAt) VALUES ('${memId}', '${userId}', '${orgId}', 'owner', ${now})`,
  );
}

// --- Resolution via x-creek-team header (slug) ---

describe("resolveTeam: explicit header", () => {
  test("resolves team by slug when user is a member", async () => {
    seedOrg("team-1", "my-team");
    seedMembership("team-1");

    const result = await resolveTeam(testEnv.env.DB as any, USER_ID, "my-team", null);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.team.id).toBe("team-1");
      expect(result.team.slug).toBe("my-team");
    }
  });

  test("returns not_found when user is not a member", async () => {
    seedOrg("team-1", "not-my-team");
    // Don't add membership

    const result = await resolveTeam(testEnv.env.DB as any, USER_ID, "not-my-team", null);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("not_found");
    }
  });
});

// --- Resolution via activeOrganizationId ---

describe("resolveTeam: session active org", () => {
  test("resolves team from active org when user is a member", async () => {
    seedOrg("team-2", "other-team");
    seedMembership("team-2");

    const result = await resolveTeam(testEnv.env.DB as any, USER_ID, undefined, "team-2");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.team.id).toBe("team-2");
    }
  });

  test("falls through when user is no longer a member of active org", async () => {
    seedOrg("stale-team", "stale");
    // No membership seeded for active org → falls to fallback
    // No fallback membership either → no_team
    const result = await resolveTeam(testEnv.env.DB as any, USER_ID, undefined, "stale-team");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("no_team");
    }
  });

  test("falls through to fallback when active org stale but user has other orgs", async () => {
    seedOrg("stale-team", "stale");
    // Active org membership gone, but user has another org
    seedOrg("fallback-team", "fallback");
    seedMembership("fallback-team");

    const result = await resolveTeam(testEnv.env.DB as any, USER_ID, undefined, "stale-team");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.team.id).toBe("fallback-team");
    }
  });
});

// --- Fallback ---

describe("resolveTeam: fallback", () => {
  test("uses first org when no header and no active org", async () => {
    seedOrg("default-team", "default");
    seedMembership("default-team");

    const result = await resolveTeam(testEnv.env.DB as any, USER_ID, undefined, null);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.team.slug).toBe("default");
    }
  });

  test("returns no_team when user has no orgs at all", async () => {
    const result = await resolveTeam(testEnv.env.DB as any, USER_ID, undefined, null);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("no_team");
    }
  });
});

// --- Priority ---

describe("resolveTeam: priority", () => {
  test("header takes priority over active org", async () => {
    seedOrg("team-header", "header-team");
    seedMembership("team-header");
    seedOrg("team-session", "session-team");
    seedMembership("team-session");

    // activeOrganizationId is set but header should win
    const result = await resolveTeam(testEnv.env.DB as any, USER_ID, "header-team", "team-session");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.team.id).toBe("team-header");
    }
  });
});
