import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import {
  handleInstallation,
  handlePush,
  handleRepository,
  type PushPayload,
  type InstallationPayload,
  type RepositoryEventPayload,
} from "./handlers.js";
import { createLocalTestEnv, seedTestData, type LocalTestEnv } from "../../local/test-env.js";
import { TEST_USER, TEST_TEAM } from "../../test-helpers.js";

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

let testEnv: LocalTestEnv;

beforeEach(() => {
  vi.clearAllMocks();
  testEnv = createLocalTestEnv();
  seedTestData(testEnv);
});

afterEach(() => {
  testEnv.cleanup();
});

// --- Installation handler ---

describe("handleInstallation", () => {
  test("created action inserts installation record", async () => {
    const payload: InstallationPayload = {
      action: "created",
      installation: { id: 12345, account: { login: "myorg", type: "Organization" }, app_id: 999 },
      repositories: [{ name: "my-app", full_name: "myorg/my-app" }],
    };

    await handleInstallation(testEnv.env, payload);

    const row = testEnv.db.db.prepare("SELECT * FROM github_installation WHERE id = 12345").get() as any;
    expect(row).toBeDefined();
    expect(row.id).toBe(12345);
    expect(row.accountLogin).toBe("myorg");
  });

  test("deleted action removes installation and related data", async () => {
    // Seed installation + project (FK target) + connection + scan
    const now = Date.now();
    testEnv.db.db.exec(`INSERT INTO github_installation (id, accountLogin, accountType, appId, createdAt, updatedAt) VALUES (12345, 'myorg', 'Organization', 999, ${now}, ${now})`);
    testEnv.db.db.exec(`INSERT OR IGNORE INTO project (id, slug, organizationId, createdAt, updatedAt) VALUES ('proj-test', 'test-app', '${TEST_TEAM.id}', ${now}, ${now})`);
    testEnv.db.db.exec(`INSERT INTO github_connection (id, projectId, installationId, repoOwner, repoName, productionBranch, autoDeployEnabled, previewEnabled, createdAt) VALUES ('conn-1', 'proj-test', 12345, 'myorg', 'my-app', 'main', 1, 1, ${now})`);
    testEnv.db.db.exec(`INSERT INTO repo_scan (repoOwner, repoName, installationId, deployable, scannedAt) VALUES ('myorg', 'my-app', 12345, 0, ${now})`);

    const payload: InstallationPayload = {
      action: "deleted",
      installation: { id: 12345, account: { login: "myorg", type: "Organization" }, app_id: 999 },
    };

    await handleInstallation(testEnv.env, payload);

    // Should have deleted connections, scans, and installation
    expect(testEnv.db.db.prepare("SELECT * FROM github_connection WHERE installationId = 12345").get()).toBeUndefined();
    expect(testEnv.db.db.prepare("SELECT * FROM repo_scan WHERE installationId = 12345").get()).toBeUndefined();
    expect(testEnv.db.db.prepare("SELECT * FROM github_installation WHERE id = 12345").get()).toBeUndefined();
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
    // No github_connection seeded
    await handlePush(testEnv.env, basePushPayload);

    // Should NOT create a deployment
    const row = testEnv.db.db.prepare("SELECT * FROM deployment").get();
    expect(row).toBeUndefined();
  });

  test("no-op when autoDeployEnabled is false", async () => {
    seedConnection({ autoDeployEnabled: 0 });

    await handlePush(testEnv.env, basePushPayload);

    const row = testEnv.db.db.prepare("SELECT * FROM deployment").get();
    expect(row).toBeUndefined();
  });

  test("creates deployment for production push", async () => {
    seedConnection();
    seedProjectForPush();

    await handlePush(testEnv.env, basePushPayload).catch(() => {});

    const row = testEnv.db.db.prepare("SELECT * FROM deployment WHERE projectId = 'proj-1'").get() as any;
    expect(row).toBeDefined();
    expect(row.branch).toBe("main");
    expect(row.commitSha).toBe("abc123def456");
    expect(row.triggerType).toBe("github");
  });

  test("calls remote-builder via service binding with internal secret", async () => {
    seedConnection();
    seedProjectForPush();

    const builderFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: "stop here" })),
    );
    testEnv.env.REMOTE_BUILDER = { fetch: builderFetch } as unknown as Fetcher;

    await handlePush(testEnv.env, basePushPayload).catch(() => {});

    expect(builderFetch).toHaveBeenCalledTimes(1);
    const [url, init] = builderFetch.mock.calls[0];
    expect(url).toBe("http://remote-builder/build");
    expect(init.method).toBe("POST");
    expect(init.headers["X-Internal-Secret"]).toBe(testEnv.env.INTERNAL_SECRET);
    const body = JSON.parse(init.body);
    expect(body.branch).toBe("main");
    expect(body.repoUrl).toContain("x-access-token:mock-token@github.com/myorg/my-app.git");
  });

  test("skips non-production branch when previewEnabled is false", async () => {
    seedConnection({ previewEnabled: 0 });

    const featurePush = { ...basePushPayload, ref: "refs/heads/feature/auth" };
    await handlePush(testEnv.env, featurePush);

    const row = testEnv.db.db.prepare("SELECT * FROM deployment").get();
    expect(row).toBeUndefined();
  });

  function seedConnection(overrides?: { autoDeployEnabled?: number; previewEnabled?: number }) {
    const now = Date.now();
    // Project must exist before github_connection (FK constraint)
    testEnv.db.db.exec(
      `INSERT OR IGNORE INTO project (id, slug, organizationId, productionBranch, createdAt, updatedAt)
       VALUES ('proj-1', 'my-app', '${TEST_TEAM.id}', 'main', ${now}, ${now})`,
    );
    testEnv.db.db.exec(
      `INSERT INTO github_connection (id, projectId, installationId, repoOwner, repoName, productionBranch, autoDeployEnabled, previewEnabled, createdAt)
       VALUES ('conn-1', 'proj-1', 12345, 'myorg', 'my-app', 'main', ${overrides?.autoDeployEnabled ?? 1}, ${overrides?.previewEnabled ?? 1}, ${now})`,
    );
  }

  function seedProjectForPush() {
    // Project already seeded in seedConnection; this is a no-op but kept
    // for clarity that handlePush joins project with organization.
  }
});

// --- Repository event handler (rename + transfer) ---

describe("handleRepository", () => {
  test("ignores events other than renamed/transferred", async () => {
    const payload: RepositoryEventPayload = {
      action: "edited",
      repository: { id: 999, name: "whatever", owner: { login: "linyiru" } },
      installation: { id: 1 },
    };

    await handleRepository(testEnv.env, payload);

    // No updates should have occurred
    const row = testEnv.db.db.prepare("SELECT * FROM github_connection").get();
    expect(row).toBeUndefined();
  });

  test("renamed: updates connection when matching row exists by repoId", async () => {
    const now = Date.now();
    testEnv.db.db.exec(
      `INSERT OR IGNORE INTO project (id, slug, organizationId, createdAt, updatedAt)
       VALUES ('proj-1', 'my-app', '${TEST_TEAM.id}', ${now}, ${now})`,
    );
    testEnv.db.db.exec(
      `INSERT INTO github_connection (id, projectId, installationId, repoId, repoOwner, repoName, productionBranch, autoDeployEnabled, previewEnabled, createdAt)
       VALUES ('conn-1', 'proj-1', 1, 12345, 'linyiru', 'old-name', 'main', 1, 1, ${now})`,
    );

    const payload: RepositoryEventPayload = {
      action: "renamed",
      repository: { id: 12345, name: "new-name", owner: { login: "linyiru" } },
      changes: { repository: { name: { from: "old-name" } } },
      installation: { id: 1 },
    };

    await handleRepository(testEnv.env, payload);

    const conn = testEnv.db.db.prepare("SELECT * FROM github_connection WHERE id = 'conn-1'").get() as any;
    expect(conn.repoOwner).toBe("linyiru");
    expect(conn.repoName).toBe("new-name");
    expect(conn.repoId).toBe(12345);

    const proj = testEnv.db.db.prepare("SELECT githubRepo FROM project WHERE id = 'proj-1'").get() as any;
    expect(proj.githubRepo).toBe("linyiru/new-name");
  });

  test("renamed: falls back to (owner, old name) lookup for legacy rows with null repoId, backfills repoId", async () => {
    const now = Date.now();
    testEnv.db.db.exec(
      `INSERT OR IGNORE INTO project (id, slug, organizationId, createdAt, updatedAt)
       VALUES ('proj-legacy', 'legacy-app', '${TEST_TEAM.id}', ${now}, ${now})`,
    );
    // Legacy row with null repoId
    testEnv.db.db.exec(
      `INSERT INTO github_connection (id, projectId, installationId, repoOwner, repoName, productionBranch, autoDeployEnabled, previewEnabled, createdAt)
       VALUES ('conn-legacy', 'proj-legacy', 1, 'linyiru', 'old-name', 'main', 1, 1, ${now})`,
    );

    const payload: RepositoryEventPayload = {
      action: "renamed",
      repository: { id: 12345, name: "new-name", owner: { login: "linyiru" } },
      changes: { repository: { name: { from: "old-name" } } },
      installation: { id: 1 },
    };

    await handleRepository(testEnv.env, payload);

    const conn = testEnv.db.db.prepare("SELECT * FROM github_connection WHERE id = 'conn-legacy'").get() as any;
    expect(conn.repoName).toBe("new-name");
    // Backfills the previously-null repoId
    expect(conn.repoId).toBe(12345);
  });

  test("renamed: no-op when no connection matches by either path", async () => {
    const payload: RepositoryEventPayload = {
      action: "renamed",
      repository: { id: 99999, name: "phantom", owner: { login: "linyiru" } },
      changes: { repository: { name: { from: "ghost" } } },
      installation: { id: 1 },
    };

    await handleRepository(testEnv.env, payload);

    const row = testEnv.db.db.prepare("SELECT * FROM github_connection").get();
    expect(row).toBeUndefined();
  });

  test("transferred: updates connection when repoId matches (no fallback for transfers)", async () => {
    const now = Date.now();
    testEnv.db.db.exec(
      `INSERT OR IGNORE INTO project (id, slug, organizationId, createdAt, updatedAt)
       VALUES ('proj-xfer', 'xfer-app', '${TEST_TEAM.id}', ${now}, ${now})`,
    );
    testEnv.db.db.exec(
      `INSERT INTO github_connection (id, projectId, installationId, repoId, repoOwner, repoName, productionBranch, autoDeployEnabled, previewEnabled, createdAt)
       VALUES ('conn-xfer', 'proj-xfer', 1, 55555, 'old-org', 'my-app', 'main', 1, 1, ${now})`,
    );

    const payload: RepositoryEventPayload = {
      action: "transferred",
      repository: { id: 55555, name: "my-app", owner: { login: "new-org" } },
      installation: { id: 1 },
    };

    await handleRepository(testEnv.env, payload);

    const conn = testEnv.db.db.prepare("SELECT * FROM github_connection WHERE id = 'conn-xfer'").get() as any;
    expect(conn.repoOwner).toBe("new-org");
    expect(conn.repoName).toBe("my-app");

    const proj = testEnv.db.db.prepare("SELECT githubRepo FROM project WHERE id = 'proj-xfer'").get() as any;
    expect(proj.githubRepo).toBe("new-org/my-app");
  });
});
