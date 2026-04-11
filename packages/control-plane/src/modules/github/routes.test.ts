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

  test("returns 404 when project has no github_connection", async () => {
    // No seeded row → first() returns null
    const res = await app.request("/github/deploy-latest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "proj-nope" }),
    }, env, mockExecutionCtx);

    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("not_found");
  });

  test("returns 404 when GitHub has no commit on production branch", async () => {
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
});
