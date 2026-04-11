import { describe, test, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../../types.js";
import type { AuthUser } from "../tenant/types.js";
import { github } from "./routes.js";
import {
  createMockD1,
  createTestEnv,
  TEST_USER,
  TEST_TEAM,
  type MockD1,
} from "../../test-helpers.js";

// Mock the external collaborators so we can assert on the synthesized
// PushPayload without actually calling GitHub, remote-builder, or runDeployJob.
vi.mock("./api.js", () => ({
  exchangeInstallationToken: vi.fn().mockResolvedValue("mock-installation-token"),
  getLatestCommit: vi.fn(),
  getRepoInfo: vi.fn().mockResolvedValue({ id: 987654321, defaultBranch: "main" }),
  listInstallationRepos: vi.fn().mockResolvedValue([]),
  createCommitStatus: vi.fn().mockResolvedValue(undefined),
  createOrUpdatePRComment: vi.fn().mockResolvedValue(undefined),
  formatPreviewComment: vi.fn().mockReturnValue("preview comment"),
}));

vi.mock("./handlers.js", () => ({
  handlePush: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./scan.js", () => ({
  scanRepo: vi.fn().mockResolvedValue({
    framework: null,
    configType: null,
    bindings: [],
    envHints: [],
    deployable: false,
  }),
}));

// Build a wrapper app that injects the tenant middleware context
// (user/teamId/teamSlug) that the github routes expect, matching how
// tenantMiddleware runs in production.
function buildApp(env: Env) {
  type GitHubEnv = {
    Bindings: Env;
    Variables: { user: AuthUser; teamId: string; teamSlug: string };
  };
  const app = new Hono<GitHubEnv>();
  // Surface errors as JSON with full stack so assertions against non-2xx
  // responses get the real failure instead of a generic 500.
  app.onError((err, c) => {
    console.error("[test app onError]", err);
    return c.json({ error: "test_error", message: err.message, stack: err.stack }, 500);
  });
  app.use("*", async (c, next) => {
    c.set("user", TEST_USER);
    c.set("teamId", TEST_TEAM.id);
    c.set("teamSlug", TEST_TEAM.slug);
    return next();
  });
  app.route("/github", github);
  return app;
}

// Hono's app.request() requires an ExecutionContext for c.executionCtx.waitUntil
// to work. Minimal stub that just swallows the promises.
const mockExecutionCtx = {
  waitUntil: (_p: Promise<unknown>) => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

let db: MockD1;
let env: ReturnType<typeof createTestEnv>;
let app: ReturnType<typeof buildApp>;

beforeEach(async () => {
  vi.clearAllMocks();
  db = createMockD1();
  env = createTestEnv(db);
  app = buildApp(env);
});

describe("POST /github/deploy-latest", () => {
  test("returns 400 when projectId is missing", async () => {
    const res = await app.request("/github/deploy-latest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }, env, mockExecutionCtx);

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("validation");
  });

  test("returns 404 when project does not exist", async () => {
    // No seeded project → first() returns null
    const res = await app.request("/github/deploy-latest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "nope" }),
    }, env, mockExecutionCtx);

    expect(res.status).toBe(404);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe("not_found");
    expect(body.message).toBe("Project not found");
  });

  test("returns 404 when project has no github_connection", async () => {
    // Project exists but no github_connection
    db.seedFirst("SELECT id FROM project", ["proj-1", "proj-1", TEST_TEAM.id], {
      id: "proj-1",
    });

    const res = await app.request("/github/deploy-latest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "proj-1" }),
    }, env, mockExecutionCtx);

    expect(res.status).toBe(404);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe("not_found");
    expect(body.message).toContain("no GitHub connection");
  });

  test("returns 404 when GitHub has no commit on production branch", async () => {
    db.seedFirst("SELECT id FROM project", ["proj-1", "proj-1", TEST_TEAM.id], {
      id: "proj-1",
    });
    db.seedFirst("SELECT gc.installationId", ["proj-1", TEST_TEAM.id], {
      installationId: 12345,
      repoOwner: "myorg",
      repoName: "my-app",
      productionBranch: "main",
    });

    const { getLatestCommit } = await import("./api.js");
    (getLatestCommit as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const res = await app.request("/github/deploy-latest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "proj-1" }),
    }, env, mockExecutionCtx);

    expect(res.status).toBe(404);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe("not_found");
    expect(body.message).toContain("main");
  });

  test("happy path: dispatches handlePush with synthesized payload", async () => {
    db.seedFirst("SELECT id FROM project", ["proj-1", "proj-1", TEST_TEAM.id], {
      id: "proj-1",
    });
    db.seedFirst("SELECT gc.installationId", ["proj-1", TEST_TEAM.id], {
      installationId: 12345,
      repoOwner: "myorg",
      repoName: "my-app",
      productionBranch: "main",
    });

    const { getLatestCommit } = await import("./api.js");
    (getLatestCommit as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      sha: "abc123def456",
      message: "feat: ship it",
    });

    const { handlePush } = await import("./handlers.js");

    const res = await app.request("/github/deploy-latest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "proj-1" }),
    }, env, mockExecutionCtx);

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; commitSha: string; branch: string };
    expect(body).toEqual({ ok: true, commitSha: "abc123def456", branch: "main" });

    expect(handlePush).toHaveBeenCalledTimes(1);
    const [, payload] = (handlePush as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(payload).toEqual({
      ref: "refs/heads/main",
      after: "abc123def456",
      head_commit: { message: "feat: ship it" },
      repository: {
        owner: { login: "myorg" },
        name: "my-app",
        clone_url: "https://github.com/myorg/my-app.git",
      },
      installation: { id: 12345 },
    });
  });

  test("accepts project slug and resolves it to the UUID before connection lookup", async () => {
    // Client sends the slug (dashboard's /projects/:slug route); the endpoint
    // should resolve it to the UUID via (id = ? OR slug = ?) first, then use
    // that UUID to look up github_connection.
    db.seedFirst("SELECT id FROM project", ["my-app", "my-app", TEST_TEAM.id], {
      id: "proj-uuid-xyz",
    });
    db.seedFirst("SELECT gc.installationId", ["proj-uuid-xyz", TEST_TEAM.id], {
      installationId: 999,
      repoOwner: "linyiru",
      repoName: "my-app",
      productionBranch: "main",
    });

    const { getLatestCommit } = await import("./api.js");
    (getLatestCommit as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      sha: "sha123",
      message: "chore: bump",
    });

    const res = await app.request("/github/deploy-latest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "my-app" }),
    }, env, mockExecutionCtx);

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

describe("GET /github/connections/by-project/:projectId", () => {
  test("returns 404 when project does not exist", async () => {
    const res = await app.request(
      "/github/connections/by-project/nope",
      { method: "GET" },
      env,
      mockExecutionCtx,
    );

    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("not_found");
  });

  test("returns { connection: null } when project has no connection", async () => {
    db.seedFirst("SELECT id FROM project", ["proj-1", "proj-1", TEST_TEAM.id], {
      id: "proj-1",
    });
    // No github_connection row seeded → first() returns null

    const res = await app.request(
      "/github/connections/by-project/proj-1",
      { method: "GET" },
      env,
      mockExecutionCtx,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as { connection: unknown };
    expect(body.connection).toBeNull();
  });

  test("returns the connection row when it exists", async () => {
    db.seedFirst("SELECT id FROM project", ["proj-1", "proj-1", TEST_TEAM.id], {
      id: "proj-1",
    });
    db.seedFirst("FROM github_connection", ["proj-1"], {
      id: "conn-1",
      projectId: "proj-1",
      installationId: 12345,
      repoOwner: "linyiru",
      repoName: "subs-landing-page",
      productionBranch: "main",
      autoDeployEnabled: 1,
      previewEnabled: 1,
      createdAt: 1775867000671,
    });

    const res = await app.request(
      "/github/connections/by-project/proj-1",
      { method: "GET" },
      env,
      mockExecutionCtx,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as {
      connection: {
        id: string;
        repoOwner: string;
        repoName: string;
        productionBranch: string;
      } | null;
    };
    expect(body.connection).not.toBeNull();
    expect(body.connection!.id).toBe("conn-1");
    expect(body.connection!.repoOwner).toBe("linyiru");
    expect(body.connection!.repoName).toBe("subs-landing-page");
    expect(body.connection!.productionBranch).toBe("main");
  });

  test("accepts project slug (matches dashboard /projects/:slug route)", async () => {
    db.seedFirst("SELECT id FROM project", ["subs-landing-page", "subs-landing-page", TEST_TEAM.id], {
      id: "proj-uuid",
    });
    db.seedFirst("FROM github_connection", ["proj-uuid"], {
      id: "conn-slug",
      projectId: "proj-uuid",
      installationId: 1,
      repoOwner: "linyiru",
      repoName: "subs-landing-page",
      productionBranch: "main",
      autoDeployEnabled: 1,
      previewEnabled: 1,
      createdAt: 1,
    });

    const res = await app.request(
      "/github/connections/by-project/subs-landing-page",
      { method: "GET" },
      env,
      mockExecutionCtx,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as { connection: { id: string } | null };
    expect(body.connection?.id).toBe("conn-slug");
  });
});

describe("POST /github/connect", () => {
  test("returns 400 when required fields are missing", async () => {
    const res = await app.request(
      "/github/connect",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: "proj-1" }),
      },
      env,
      mockExecutionCtx,
    );

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("validation");
  });

  test("returns 404 when project is not owned by caller's team", async () => {
    // No seeded project → first() returns null
    const res = await app.request(
      "/github/connect",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "proj-nope",
          installationId: 123,
          repoOwner: "linyiru",
          repoName: "test-repo",
        }),
      },
      env,
      mockExecutionCtx,
    );

    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("not_found");
  });

  test("returns 409 when project already has a github_connection", async () => {
    db.seedFirst("SELECT id FROM project", ["proj-1", TEST_TEAM.id], {
      id: "proj-1",
    });
    // First lookup: existing connection for this project — must return a row
    db.seedFirst("SELECT id FROM github_connection WHERE projectId", ["proj-1"], {
      id: "existing-conn",
    });

    const res = await app.request(
      "/github/connect",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "proj-1",
          installationId: 123,
          repoOwner: "linyiru",
          repoName: "test-repo",
        }),
      },
      env,
      mockExecutionCtx,
    );

    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe("conflict");
    expect(body.message).toContain("already has a GitHub connection");
  });

  test("returns 409 when the target repo is already connected to another project", async () => {
    db.seedFirst("SELECT id FROM project", ["proj-1", TEST_TEAM.id], {
      id: "proj-1",
    });
    // No existing connection for this project
    // But the target repo is taken by a different project
    db.seedFirst("SELECT projectId FROM github_connection WHERE repoOwner", ["linyiru", "shared-repo"], {
      projectId: "other-proj",
    });

    const res = await app.request(
      "/github/connect",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "proj-1",
          installationId: 123,
          repoOwner: "linyiru",
          repoName: "shared-repo",
        }),
      },
      env,
      mockExecutionCtx,
    );

    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe("conflict");
    expect(body.message).toContain("already connected");
  });

  test("happy path: inserts connection row with repoId and updates project.githubRepo", async () => {
    db.seedFirst("SELECT id FROM project", ["proj-1", TEST_TEAM.id], {
      id: "proj-1",
    });

    const res = await app.request(
      "/github/connect",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "proj-1",
          installationId: 123,
          repoOwner: "linyiru",
          repoName: "my-app",
          productionBranch: "dev",
        }),
      },
      env,
      mockExecutionCtx,
    );

    expect(res.status).toBe(201);
    const body = await res.json() as { ok: boolean; connectionId: string; repoId: number | null };
    expect(body.ok).toBe(true);
    expect(body.connectionId).toBeTruthy();
    // repoId comes from the mocked getRepoInfo
    expect(body.repoId).toBe(987654321);

    const executed = db.getExecuted();
    const insertQ = executed.find((q) => q.sql.includes("INSERT INTO github_connection"));
    expect(insertQ).toBeDefined();
    expect(insertQ!.args).toContain("proj-1");
    expect(insertQ!.args).toContain(123);
    expect(insertQ!.args).toContain(987654321); // repoId
    expect(insertQ!.args).toContain("linyiru");
    expect(insertQ!.args).toContain("my-app");
    expect(insertQ!.args).toContain("dev");

    const updateQ = executed.find((q) => q.sql.includes("UPDATE project SET githubRepo"));
    expect(updateQ).toBeDefined();
    expect(updateQ!.args).toContain("linyiru/my-app");
    expect(updateQ!.args).toContain("proj-1");
  });

  test("still creates connection when getRepoInfo fails (repoId = null)", async () => {
    db.seedFirst("SELECT id FROM project", ["proj-1", TEST_TEAM.id], {
      id: "proj-1",
    });

    const { getRepoInfo } = await import("./api.js");
    (getRepoInfo as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const res = await app.request(
      "/github/connect",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "proj-1",
          installationId: 123,
          repoOwner: "linyiru",
          repoName: "my-app",
        }),
      },
      env,
      mockExecutionCtx,
    );

    expect(res.status).toBe(201);
    const body = await res.json() as { repoId: number | null };
    expect(body.repoId).toBeNull();

    const executed = db.getExecuted();
    const insertQ = executed.find((q) => q.sql.includes("INSERT INTO github_connection"));
    expect(insertQ).toBeDefined();
    expect(insertQ!.args).toContain(null);
  });
});

describe("DELETE /github/connections/:id", () => {
  test("returns 404 when the connection does not belong to the caller's team", async () => {
    // No seeded row → team ownership join returns null
    const res = await app.request(
      "/github/connections/conn-nope",
      { method: "DELETE" },
      env,
      mockExecutionCtx,
    );

    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("not_found");
  });

  test("deletes the connection and clears project.githubRepo when owned", async () => {
    // The DELETE handler does a join lookup first:
    //   SELECT gc.id, gc.projectId FROM github_connection gc
    //   JOIN project p ON gc.projectId = p.id
    //   WHERE gc.id = ? AND p.organizationId = ?
    db.seedFirst("FROM github_connection gc", ["conn-1", TEST_TEAM.id], {
      id: "conn-1",
      projectId: "proj-1",
    });
    db.seedRun("DELETE FROM github_connection", ["conn-1"]);
    db.seedRun("UPDATE project SET githubRepo = NULL", []);

    const res = await app.request(
      "/github/connections/conn-1",
      { method: "DELETE" },
      env,
      mockExecutionCtx,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);

    const executed = db.getExecuted();
    expect(executed.some((q) => q.sql.includes("DELETE FROM github_connection"))).toBe(true);
    expect(
      executed.some((q) => q.sql.includes("UPDATE project SET githubRepo = NULL")),
    ).toBe(true);
  });
});
