import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { createLocalTestEnv, seedTestData, seedProject, type LocalTestEnv } from "../../local/test-env.js";
import { runDeployJob } from "./deploy-job.js";

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
});
