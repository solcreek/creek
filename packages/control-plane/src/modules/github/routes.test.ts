import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../../types.js";
import type { AuthUser } from "../tenant/types.js";
import { github } from "./routes.js";
import { createLocalTestEnv, seedTestData, seedProject, type LocalTestEnv } from "../../local/test-env.js";
import { TEST_USER, TEST_TEAM } from "../../test-helpers.js";

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
  waitUntil: (p: Promise<unknown>) => { p.catch(() => {}); },
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

let testEnv: LocalTestEnv;
let app: ReturnType<typeof buildApp>;

beforeEach(async () => {
  vi.clearAllMocks();
  testEnv = createLocalTestEnv();
  seedTestData(testEnv);
  app = buildApp(testEnv.env);
});

afterEach(() => {
  testEnv.cleanup();
});

describe("POST /github/deploy-latest", () => {
  test("returns 400 when projectId is missing", async () => {
    const res = await app.request("/github/deploy-latest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }, testEnv.env, mockExecutionCtx);

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("validation");
  });

  test("returns 404 when project does not exist", async () => {
    const res = await app.request("/github/deploy-latest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "nope" }),
    }, testEnv.env, mockExecutionCtx);

    expect(res.status).toBe(404);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe("not_found");
    expect(body.message).toBe("Project not found");
  });

  test("returns 404 when project has no github_connection", async () => {
    seedProject(testEnv, "my-app", { id: "proj-1" });

    const res = await app.request("/github/deploy-latest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "proj-1" }),
    }, testEnv.env, mockExecutionCtx);

    expect(res.status).toBe(404);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe("not_found");
    expect(body.message).toContain("no GitHub connection");
  });

  test("returns 404 when GitHub has no commit on production branch", async () => {
    seedProject(testEnv, "my-app", { id: "proj-1" });
    seedGithubConnection("proj-1", {
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
    }, testEnv.env, mockExecutionCtx);

    expect(res.status).toBe(404);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe("not_found");
    expect(body.message).toContain("main");
  });

  test("happy path: dispatches handlePush with synthesized payload", async () => {
    seedProject(testEnv, "my-app", { id: "proj-1" });
    seedGithubConnection("proj-1", {
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
    }, testEnv.env, mockExecutionCtx);

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
    seedProject(testEnv, "my-app", { id: "proj-uuid-xyz" });
    seedGithubConnection("proj-uuid-xyz", {
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
    }, testEnv.env, mockExecutionCtx);

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
      testEnv.env,
      mockExecutionCtx,
    );

    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("not_found");
  });

  test("returns { connection: null } when project has no connection", async () => {
    seedProject(testEnv, "my-app", { id: "proj-1" });

    const res = await app.request(
      "/github/connections/by-project/proj-1",
      { method: "GET" },
      testEnv.env,
      mockExecutionCtx,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as { connection: unknown };
    expect(body.connection).toBeNull();
  });

  test("returns the connection row when it exists", async () => {
    seedProject(testEnv, "my-app", { id: "proj-1" });
    seedGithubConnection("proj-1", {
      id: "conn-1",
      installationId: 12345,
      repoOwner: "linyiru",
      repoName: "subs-landing-page",
      productionBranch: "main",
    });

    const res = await app.request(
      "/github/connections/by-project/proj-1",
      { method: "GET" },
      testEnv.env,
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
    seedProject(testEnv, "subs-landing-page", { id: "proj-uuid" });
    seedGithubConnection("proj-uuid", {
      id: "conn-slug",
      installationId: 1,
      repoOwner: "linyiru",
      repoName: "subs-landing-page",
      productionBranch: "main",
    });

    const res = await app.request(
      "/github/connections/by-project/subs-landing-page",
      { method: "GET" },
      testEnv.env,
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
      testEnv.env,
      mockExecutionCtx,
    );

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("validation");
  });

  test("returns 404 when project is not owned by caller's team", async () => {
    // No project seeded -> not found
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
      testEnv.env,
      mockExecutionCtx,
    );

    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("not_found");
  });

  test("returns 409 when project already has a github_connection", async () => {
    seedProject(testEnv, "my-app", { id: "proj-1" });
    seedGithubConnection("proj-1", {
      id: "existing-conn",
      installationId: 999,
      repoOwner: "linyiru",
      repoName: "other-repo",
      productionBranch: "main",
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
      testEnv.env,
      mockExecutionCtx,
    );

    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe("conflict");
    expect(body.message).toContain("already has a GitHub connection");
  });

  test("returns 409 when the target repo is already connected to another project", async () => {
    seedProject(testEnv, "my-app", { id: "proj-1" });
    // Another project owns the target repo
    seedProject(testEnv, "other-app", { id: "other-proj" });
    seedGithubConnection("other-proj", {
      installationId: 999,
      repoOwner: "linyiru",
      repoName: "shared-repo",
      productionBranch: "main",
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
      testEnv.env,
      mockExecutionCtx,
    );

    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe("conflict");
    expect(body.message).toContain("already connected");
  });

  test("happy path: inserts connection row with repoId and updates project.githubRepo", async () => {
    seedProject(testEnv, "my-app", { id: "proj-1" });

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
      testEnv.env,
      mockExecutionCtx,
    );

    expect(res.status).toBe(201);
    const body = await res.json() as { ok: boolean; connectionId: string; repoId: number | null };
    expect(body.ok).toBe(true);
    expect(body.connectionId).toBeTruthy();
    // repoId comes from the mocked getRepoInfo
    expect(body.repoId).toBe(987654321);

    // Verify DB: github_connection row
    const conn = testEnv.db.db.prepare("SELECT * FROM github_connection WHERE projectId = 'proj-1'").get() as any;
    expect(conn).toBeDefined();
    expect(conn.installationId).toBe(123);
    expect(conn.repoId).toBe(987654321);
    expect(conn.repoOwner).toBe("linyiru");
    expect(conn.repoName).toBe("my-app");
    expect(conn.productionBranch).toBe("dev");

    // Verify DB: project.githubRepo updated
    const proj = testEnv.db.db.prepare("SELECT githubRepo FROM project WHERE id = 'proj-1'").get() as any;
    expect(proj.githubRepo).toBe("linyiru/my-app");
  });

  test("still creates connection when getRepoInfo fails (repoId = null)", async () => {
    seedProject(testEnv, "my-app", { id: "proj-1" });

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
      testEnv.env,
      mockExecutionCtx,
    );

    expect(res.status).toBe(201);
    const body = await res.json() as { repoId: number | null };
    expect(body.repoId).toBeNull();

    const conn = testEnv.db.db.prepare("SELECT repoId FROM github_connection WHERE projectId = 'proj-1'").get() as any;
    expect(conn.repoId).toBeNull();
  });
});

describe("DELETE /github/connections/:id", () => {
  test("returns 404 when the connection does not belong to the caller's team", async () => {
    // No connection seeded -> not found
    const res = await app.request(
      "/github/connections/conn-nope",
      { method: "DELETE" },
      testEnv.env,
      mockExecutionCtx,
    );

    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("not_found");
  });

  test("deletes the connection and clears project.githubRepo when owned", async () => {
    seedProject(testEnv, "my-app", { id: "proj-1" });
    // Set githubRepo so we can verify it gets cleared
    testEnv.db.db.prepare("UPDATE project SET githubRepo = ? WHERE id = ?").run("linyiru/my-app", "proj-1");
    seedGithubConnection("proj-1", {
      id: "conn-1",
      installationId: 123,
      repoOwner: "linyiru",
      repoName: "my-app",
      productionBranch: "main",
    });

    const res = await app.request(
      "/github/connections/conn-1",
      { method: "DELETE" },
      testEnv.env,
      mockExecutionCtx,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);

    // Connection deleted
    const conn = testEnv.db.db.prepare("SELECT * FROM github_connection WHERE id = 'conn-1'").get();
    expect(conn).toBeUndefined();

    // githubRepo cleared
    const proj = testEnv.db.db.prepare("SELECT githubRepo FROM project WHERE id = 'proj-1'").get() as any;
    expect(proj.githubRepo).toBeNull();
  });
});

/**
 * Helper: seed a github_connection row.
 */
function seedGithubConnection(projectId: string, opts: {
  id?: string;
  installationId: number;
  repoOwner: string;
  repoName: string;
  productionBranch: string;
}) {
  const id = opts.id ?? crypto.randomUUID();
  const now = Date.now();
  testEnv.db.db.prepare(
    `INSERT INTO github_connection (id, projectId, installationId, repoOwner, repoName, productionBranch, autoDeployEnabled, previewEnabled, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)`,
  ).run(id, projectId, opts.installationId, opts.repoOwner, opts.repoName, opts.productionBranch, now);
}
