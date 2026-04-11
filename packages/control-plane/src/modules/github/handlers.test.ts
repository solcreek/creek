import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  handleInstallation,
  handlePush,
  type PushPayload,
  type InstallationPayload,
} from "./handlers.js";
import { createMockD1, createTestEnv, type MockD1 } from "../../test-helpers.js";

// Mock external modules
vi.mock("./api.js", () => ({
  exchangeInstallationToken: vi.fn().mockResolvedValue("mock-token"),
  createCommitStatus: vi.fn().mockResolvedValue(undefined),
  createOrUpdatePRComment: vi.fn().mockResolvedValue(undefined),
  formatPreviewComment: vi.fn().mockReturnValue("preview comment"),
}));

vi.mock("./scan.js", () => ({
  scanRepo: vi.fn().mockResolvedValue({
    framework: "nuxt",
    configType: "wrangler.jsonc",
    bindings: [{ type: "kv", name: "KV" }],
    envHints: [],
    deployable: true,
  }),
}));

let db: MockD1;
let env: ReturnType<typeof createTestEnv>;

beforeEach(() => {
  vi.clearAllMocks();
  db = createMockD1();
  env = createTestEnv(db);
});

// --- Installation handler ---

describe("handleInstallation", () => {
  test("created action inserts installation record", async () => {
    const payload: InstallationPayload = {
      action: "created",
      installation: { id: 12345, account: { login: "myorg", type: "Organization" }, app_id: 999 },
      repositories: [{ name: "my-app", full_name: "myorg/my-app" }],
    };

    await handleInstallation(env, payload);

    const queries = db.getExecuted();
    const insertQuery = queries.find((q) => q.sql.includes("INSERT INTO github_installation"));
    expect(insertQuery).toBeDefined();
    expect(insertQuery!.args[0]).toBe(12345); // installation ID
    expect(insertQuery!.args[1]).toBe("myorg");
  });

  test("deleted action removes installation and related data", async () => {
    const payload: InstallationPayload = {
      action: "deleted",
      installation: { id: 12345, account: { login: "myorg", type: "Organization" }, app_id: 999 },
    };

    await handleInstallation(env, payload);

    const queries = db.getExecuted();
    // Should batch-delete connections, scans, and installation
    expect(queries.some((q) => q.sql.includes("DELETE FROM github_connection"))).toBe(true);
    expect(queries.some((q) => q.sql.includes("DELETE FROM repo_scan"))).toBe(true);
    expect(queries.some((q) => q.sql.includes("DELETE FROM github_installation"))).toBe(true);
  });
});

// --- Push handler ---

describe("handlePush", () => {
  const basePushPayload: PushPayload = {
    ref: "refs/heads/main",
    after: "abc123def456",
    head_commit: { message: "fix: update styles" },
    repository: { owner: { login: "myorg" }, name: "my-app", clone_url: "https://github.com/myorg/my-app.git" },
    installation: { id: 12345 },
  };

  test("no-op when repo is not connected", async () => {
    // No github_connection seeded → first() returns null
    await handlePush(env, basePushPayload);

    // Should NOT create a deployment
    const queries = db.getExecuted();
    expect(queries.some((q) => q.sql.includes("INSERT INTO deployment"))).toBe(false);
  });

  test("no-op when autoDeployEnabled is false", async () => {
    db.seedFirst("SELECT * FROM github_connection WHERE", ["myorg", "my-app"], {
      id: "conn-1",
      projectId: "proj-1",
      installationId: 12345,
      productionBranch: "main",
      autoDeployEnabled: 0,
      previewEnabled: 1,
    });

    await handlePush(env, basePushPayload);

    const queries = db.getExecuted();
    expect(queries.some((q) => q.sql.includes("INSERT INTO deployment"))).toBe(false);
  });

  test("creates deployment for production push", async () => {
    db.seedFirst("SELECT * FROM github_connection WHERE", ["myorg", "my-app"], {
      id: "conn-1",
      projectId: "proj-1",
      installationId: 12345,
      productionBranch: "main",
      autoDeployEnabled: 1,
      previewEnabled: 1,
    });

    db.seedFirst("SELECT p.slug", ["proj-1"], {
      slug: "my-app",
      teamSlug: "myorg",
      teamId: "team-1",
      plan: "free",
    });

    db.seedFirst("SELECT MAX(version)", ["proj-1"], { v: 3 });

    await handlePush(env, basePushPayload).catch(() => {});

    const queries = db.getExecuted();
    const deployInsert = queries.find((q) => q.sql.includes("INSERT INTO deployment"));
    expect(deployInsert).toBeDefined();
    expect(deployInsert!.args).toContain("main");        // branch
    expect(deployInsert!.args).toContain("abc123def456"); // commitSha
    // triggerType "github" is hardcoded in SQL, not a bind param
    expect(deployInsert!.sql).toContain("'github'");
  });

  test("calls remote-builder via service binding with internal secret", async () => {
    db.seedFirst("SELECT * FROM github_connection WHERE", ["myorg", "my-app"], {
      id: "conn-1",
      projectId: "proj-1",
      installationId: 12345,
      productionBranch: "main",
      autoDeployEnabled: 1,
      previewEnabled: 1,
    });
    db.seedFirst("SELECT p.slug", ["proj-1"], {
      slug: "my-app",
      teamSlug: "myorg",
      teamId: "team-1",
      plan: "free",
    });
    db.seedFirst("SELECT MAX(version)", ["proj-1"], { v: 0 });

    const builderFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: "stop here" })),
    );
    env.REMOTE_BUILDER = { fetch: builderFetch } as unknown as Fetcher;

    await handlePush(env, basePushPayload).catch(() => {});

    expect(builderFetch).toHaveBeenCalledTimes(1);
    const [url, init] = builderFetch.mock.calls[0];
    expect(url).toBe("http://remote-builder/build");
    expect(init.method).toBe("POST");
    expect(init.headers["X-Internal-Secret"]).toBe(env.INTERNAL_SECRET);
    const body = JSON.parse(init.body);
    expect(body.branch).toBe("main");
    expect(body.repoUrl).toContain("x-access-token:mock-token@github.com/myorg/my-app.git");
  });

  test("skips non-production branch when previewEnabled is false", async () => {
    db.seedFirst("SELECT * FROM github_connection WHERE", ["myorg", "my-app"], {
      id: "conn-1",
      projectId: "proj-1",
      installationId: 12345,
      productionBranch: "main",
      autoDeployEnabled: 1,
      previewEnabled: 0,
    });

    const featurePush = { ...basePushPayload, ref: "refs/heads/feature/auth" };
    await handlePush(env, featurePush);

    const queries = db.getExecuted();
    expect(queries.some((q) => q.sql.includes("INSERT INTO deployment"))).toBe(false);
  });
});
