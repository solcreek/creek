import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { gunzipSync } from "node:zlib";
import { createLocalTestEnv, seedTestData, seedProject, type LocalTestEnv } from "../../local/test-env.js";
import { runDeployJob, withDeployHeartbeat } from "./deploy-job.js";
import { buildR2Key } from "../build-logs/storage.js";
import type { BuildLogLine } from "../build-logs/types.js";

// Integration: drives the full async deploy pipeline (read R2 bundle ->
// provision -> deploy to WfP -> status) against a real test DB + R2, with
// MSW mocking every Cloudflare API call. Asserts the status orchestration
// (active on success, failed + failedStep on a CF error) that nothing else
// covers. Fabricated IDs only.
const NS = "https://api.cloudflare.com/client/v4/accounts/:acc/workers/dispatch/namespaces/:ns/scripts/:name";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

let testEnv: LocalTestEnv;
beforeEach(() => {
  testEnv = createLocalTestEnv();
  seedTestData(testEnv);
  seedProject(testEnv, "myapp", { id: "proj-myapp" });
  // A pending deployment row for runDeployJob to drive to a terminal state.
  testEnv.db.db.exec(
    `INSERT INTO deployment (id, projectId, version, status, triggerType, createdAt, updatedAt)
     VALUES ('dep-1', 'proj-myapp', 1, 'pending', 'api', ${Date.now()}, ${Date.now()})`,
  );
  // Token must be set or deployWithAssets short-circuits (local-dev mode).
  testEnv.env.CLOUDFLARE_API_TOKEN = "test-token";
});
afterEach(() => testEnv.cleanup());

async function stageBundle() {
  const bundle = {
    manifest: { assets: ["index.html"], hasWorker: false, entrypoint: null, renderMode: "spa" },
    assets: { "index.html": btoa("<html>hi</html>") },
  };
  await testEnv.env.ASSETS.put("bundles/dep-1.json", JSON.stringify(bundle));
}

const input = {
  deploymentId: "dep-1",
  projectId: "proj-myapp",
  projectSlug: "myapp",
  teamId: "team-1",
  teamSlug: "team",
  plan: "free",
  branch: null,
  productionBranch: "main",
  framework: null,
};

function deploymentRow() {
  return testEnv.db.db.prepare("SELECT status, failedStep, errorMessage FROM deployment WHERE id = 'dep-1'").get() as {
    status: string;
    failedStep: string | null;
    errorMessage: string | null;
  };
}

function buildLogRow() {
  return testEnv.db.db
    .prepare("SELECT status, lines, errorCode, errorStep, r2Key, bytes FROM build_log WHERE deploymentId = 'dep-1'")
    .get() as
    | { status: string; lines: number; errorCode: string | null; errorStep: string | null; r2Key: string; bytes: number }
    | undefined;
}

/** Fetch + gunzip the stored ndjson log and parse its lines. */
async function readLogEntries(): Promise<BuildLogLine[]> {
  const key = buildR2Key("team", "myapp", "dep-1");
  const obj = await testEnv.env.LOGS_BUCKET!.get(key);
  if (!obj) return [];
  const gz = Buffer.from(await obj.arrayBuffer());
  const ndjson = gunzipSync(gz).toString("utf-8");
  return ndjson
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as BuildLogLine);
}

describe("runDeployJob (integration via MSW)", () => {
  it("marks the deployment active after a successful WfP deploy", async () => {
    let scriptPut = false;
    server.use(
      // asset upload session: no buckets => nothing to upload
      http.post(`${NS}/assets-upload-session`, () =>
        HttpResponse.json({ success: true, result: { jwt: "session-jwt", buckets: [] }, errors: [] }),
      ),
      // worker script upload
      http.put(NS, () => {
        scriptPut = true;
        return HttpResponse.json({ success: true, result: { id: "script" }, errors: [] });
      }),
    );

    await stageBundle();
    await runDeployJob(testEnv.env, input);

    expect(scriptPut).toBe(true);
    expect(deploymentRow().status).toBe("active");
  });

  it("records failed + failedStep when the WfP deploy errors", async () => {
    server.use(
      http.post(`${NS}/assets-upload-session`, () =>
        HttpResponse.json({ success: true, result: { jwt: "session-jwt", buckets: [] }, errors: [] }),
      ),
      http.put(NS, () =>
        HttpResponse.json({ success: false, errors: [{ code: 10000, message: "namespace boom" }] }),
      ),
    );

    await stageBundle();
    await runDeployJob(testEnv.env, input);

    const row = deploymentRow();
    expect(row.status).toBe("failed");
    expect(row.failedStep).toBe("deploying");
    expect(row.errorMessage).toContain("namespace boom");
  });

  it("fails at the uploading step when the bundle is missing from staging", async () => {
    // No stageBundle() — R2 has no bundle for dep-1.
    await runDeployJob(testEnv.env, input);
    const row = deploymentRow();
    expect(row.status).toBe("failed");
    expect(row.failedStep).toBe("uploading");
  });

  it("uploads every bucket the session asks for (bounded-concurrency loop)", async () => {
    const UPLOAD = "https://api.cloudflare.com/client/v4/accounts/:acc/workers/assets/upload";
    const BUCKETS = [["h1"], ["h2"], ["h3"], ["h4"], ["h5"], ["h6"], ["h7"]]; // > CONCURRENCY (6)
    let uploadCalls = 0;
    server.use(
      http.post(`${NS}/assets-upload-session`, () =>
        HttpResponse.json({ success: true, result: { jwt: "session-jwt", buckets: BUCKETS }, errors: [] }),
      ),
      http.post(UPLOAD, () => {
        uploadCalls++;
        return HttpResponse.json({ success: true, result: { jwt: "completion-jwt" }, errors: [] });
      }),
      http.put(NS, () => HttpResponse.json({ success: true, result: { id: "script" }, errors: [] })),
    );

    await stageBundle();
    await runDeployJob(testEnv.env, input);

    expect(deploymentRow().status).toBe("active");
    // Every bucket uploaded, none dropped by the concurrency pool: the count is
    // a whole multiple of the 7 buckets (once per deployed script).
    expect(uploadCalls).toBeGreaterThanOrEqual(BUCKETS.length);
    expect(uploadCalls % BUCKETS.length).toBe(0);
  });
});

describe("runDeployJob deploy-stage logging (B2)", () => {
  const okHandlers = () => [
    http.post(`${NS}/assets-upload-session`, () =>
      HttpResponse.json({ success: true, result: { jwt: "session-jwt", buckets: [] }, errors: [] }),
    ),
    http.put(NS, () => HttpResponse.json({ success: true, result: { id: "script" }, errors: [] })),
  ];

  it("persists a server-side stage log on a successful deploy", async () => {
    server.use(...okHandlers());
    await stageBundle();
    await runDeployJob(testEnv.env, input);

    const row = buildLogRow();
    expect(row?.status).toBe("success");
    expect(row?.lines).toBeGreaterThan(0);

    const entries = await readLogEntries();
    const steps = entries.map((e) => e.step);
    expect(steps).toContain("upload");
    expect(steps).toContain("provision");
    expect(steps).toContain("activate");
    // The last line marks the terminal state so a reader sees it went active.
    expect(entries.at(-1)?.msg).toMatch(/active/i);
    expect(entries.every((e) => e.level !== "error")).toBe(true);
  });

  it("persists a failure log with the failing step and an error line", async () => {
    server.use(
      http.post(`${NS}/assets-upload-session`, () =>
        HttpResponse.json({ success: true, result: { jwt: "session-jwt", buckets: [] }, errors: [] }),
      ),
      http.put(NS, () =>
        HttpResponse.json({ success: false, errors: [{ code: 10000, message: "namespace boom" }] }),
      ),
    );
    await stageBundle();
    await runDeployJob(testEnv.env, input);

    const row = buildLogRow();
    expect(row?.status).toBe("failed");
    expect(row?.errorStep).toBe("deploying");
    expect(row?.errorCode).toBe("deploy_error");

    const entries = await readLogEntries();
    const errorLine = entries.find((e) => e.level === "error");
    expect(errorLine?.step).toBe("activate");
    expect(errorLine?.msg).toContain("namespace boom");
  });

  it("attributes a malformed bundle to the uploading step, not deploying", async () => {
    // Invalid JSON in staging — the failure belongs to the upload stage.
    await testEnv.env.ASSETS.put("bundles/dep-1.json", "{ not valid json");
    await runDeployJob(testEnv.env, input);

    expect(deploymentRow().failedStep).toBe("uploading");
    const row = buildLogRow();
    expect(row?.status).toBe("failed");
    expect(row?.errorStep).toBe("uploading");
    const errorLine = (await readLogEntries()).find((e) => e.level === "error");
    expect(errorLine?.step).toBe("upload");
  });

  it("does not clobber an existing client/remote-builder build log", async () => {
    // Simulate a build_log row the CLI/remote-builder already uploaded.
    testEnv.db.db.exec(
      `INSERT INTO build_log (deploymentId, status, startedAt, endedAt, bytes, lines, truncated, errorCode, errorStep, r2Key)
       VALUES ('dep-1', 'success', ${Date.now()}, ${Date.now()}, 4242, 99, 0, NULL, NULL, 'client/sentinel/key')`,
    );

    server.use(...okHandlers());
    await stageBundle();
    await runDeployJob(testEnv.env, input);

    // Deploy still succeeds…
    expect(deploymentRow().status).toBe("active");
    // …but the pre-existing (richer) log row is untouched — not overwritten.
    const row = buildLogRow();
    expect(row?.bytes).toBe(4242);
    expect(row?.lines).toBe(99);
    expect(row?.r2Key).toBe("client/sentinel/key");
  });
});

describe("withDeployHeartbeat", () => {
  function updatedAt(): number {
    return (
      testEnv.db.db.prepare("SELECT updatedAt FROM deployment WHERE id = 'dep-1'").get() as {
        updatedAt: number;
      }
    ).updatedAt;
  }
  function setDeploying(staleMs: number): void {
    testEnv.db.db
      .prepare("UPDATE deployment SET status = 'deploying', updatedAt = ? WHERE id = 'dep-1'")
      .run(Date.now() - staleMs);
  }

  it("advances updatedAt while a slow deploy is in flight", async () => {
    setDeploying(10 * 60 * 1000); // looks stale to the reaper
    const before = updatedAt();
    await withDeployHeartbeat(
      testEnv.env,
      "dep-1",
      () => new Promise((r) => setTimeout(r, 70)), // outlives ~3 beats
      20,
    );
    expect(updatedAt()).toBeGreaterThan(before);
    // Beaten to roughly "now", no longer stale.
    expect(Date.now() - updatedAt()).toBeLessThan(60 * 1000);
  });

  it("returns the wrapped function's value and stops beating after it settles", async () => {
    setDeploying(0);
    const result = await withDeployHeartbeat(testEnv.env, "dep-1", async () => "ok", 20);
    expect(result).toBe("ok");
    const settled = updatedAt();
    await new Promise((r) => setTimeout(r, 60)); // would be >2 beats if still running
    expect(updatedAt()).toBe(settled); // no further beats
  });

  it("propagates the wrapped function's error (and still stops beating)", async () => {
    setDeploying(0);
    await expect(
      withDeployHeartbeat(testEnv.env, "dep-1", async () => {
        throw new Error("deploy boom");
      }, 20),
    ).rejects.toThrow("deploy boom");
  });

  it("does not resurrect a row the reaper already failed", async () => {
    // Reaper marks it failed mid-deploy; a late heartbeat must not flip it back.
    testEnv.db.db
      .prepare("UPDATE deployment SET status = 'failed', updatedAt = ? WHERE id = 'dep-1'")
      .run(Date.now() - 1000);
    const before = updatedAt();
    await withDeployHeartbeat(
      testEnv.env,
      "dep-1",
      () => new Promise((r) => setTimeout(r, 50)),
      20,
    );
    // status guard means the beats no-op'd; updatedAt untouched.
    expect(updatedAt()).toBe(before);
    expect(
      (testEnv.db.db.prepare("SELECT status FROM deployment WHERE id = 'dep-1'").get() as { status: string }).status,
    ).toBe("failed");
  });
});
