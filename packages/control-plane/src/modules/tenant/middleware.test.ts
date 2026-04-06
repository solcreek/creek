import { describe, test, expect, beforeEach } from "vitest";
import { resolveTeam } from "./resolve.js";
import { createMockD1, type MockD1 } from "../../test-helpers.js";

/**
 * Tests for resolveTeam() — the real team resolution function
 * used by tenantMiddleware. No copies, no mocked logic.
 */

let db: MockD1;

const USER_ID = "user-1";

beforeEach(() => {
  db = createMockD1();
});

// --- Resolution via x-creek-team header (slug) ---

describe("resolveTeam: explicit header", () => {
  test("resolves team by slug when user is a member", async () => {
    db.seedFirst("SELECT o.id, o.slug FROM organization o", ["my-team", USER_ID], {
      id: "team-1",
      slug: "my-team",
    });

    const result = await resolveTeam(db as any, USER_ID, "my-team", null);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.team.id).toBe("team-1");
      expect(result.team.slug).toBe("my-team");
    }
  });

  test("returns not_found when user is not a member", async () => {
    const result = await resolveTeam(db as any, USER_ID, "not-my-team", null);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("not_found");
    }
  });
});

// --- Resolution via activeOrganizationId ---

describe("resolveTeam: session active org", () => {
  test("resolves team from active org when user is a member", async () => {
    db.seedFirst("SELECT o.id, o.slug FROM organization o", ["team-2", USER_ID], {
      id: "team-2",
      slug: "other-team",
    });

    const result = await resolveTeam(db as any, USER_ID, undefined, "team-2");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.team.id).toBe("team-2");
    }
  });

  test("falls through when user is no longer a member of active org", async () => {
    // No membership seeded for active org → falls to fallback
    // No fallback membership either → no_team
    const result = await resolveTeam(db as any, USER_ID, undefined, "stale-team");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("no_team");
    }
  });

  test("falls through to fallback when active org stale but user has other orgs", async () => {
    // Active org membership gone, but user has another org
    db.seedFirst("SELECT o.id, o.slug FROM organization o\n       JOIN member", [USER_ID], {
      id: "fallback-team",
      slug: "fallback",
    });

    const result = await resolveTeam(db as any, USER_ID, undefined, "stale-team");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.team.id).toBe("fallback-team");
    }
  });
});

// --- Fallback ---

describe("resolveTeam: fallback", () => {
  test("uses first org when no header and no active org", async () => {
    db.seedFirst("SELECT o.id, o.slug FROM organization o\n       JOIN member", [USER_ID], {
      id: "default-team",
      slug: "default",
    });

    const result = await resolveTeam(db as any, USER_ID, undefined, null);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.team.slug).toBe("default");
    }
  });

  test("returns no_team when user has no orgs at all", async () => {
    const result = await resolveTeam(db as any, USER_ID, undefined, null);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("no_team");
    }
  });
});

// --- Priority ---

describe("resolveTeam: priority", () => {
  test("header takes priority over active org", async () => {
    db.seedFirst("SELECT o.id, o.slug FROM organization o", ["header-team", USER_ID], {
      id: "team-header",
      slug: "header-team",
    });

    // activeOrganizationId is set but header should win
    const result = await resolveTeam(db as any, USER_ID, "header-team", "team-session");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.team.id).toBe("team-header");
    }
  });
});
