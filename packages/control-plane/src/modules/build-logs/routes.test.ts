import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { gzipSync } from "node:zlib";
import {
  createLocalTestEnv,
  seedTestData,
  seedProject,
  type LocalTestEnv,
} from "../../local/test-env.js";
import { createTestApp, TEST_USER, TEST_TEAM } from "../../test-helpers.js";

// GET /projects/:slug/deployments/:id/logs — exercises the fallback that
// surfaces a server-side deploy failure (recorded on the deployment row, not
// in build_log) instead of the bare "Build log not yet available" response.

let testEnv: LocalTestEnv;
let app: ReturnType<typeof createTestApp>;

const executionCtx = {
  waitUntil: (p: Promise<unknown>) => {
    p.catch(() => {});
  },
  passThroughOnException: () => {},
};

const PROJECT_SLUG = "my-app";
const PROJECT_ID = "proj-my-app";

beforeEach(() => {
  testEnv = createLocalTestEnv();
  seedTestData(testEnv);
  seedProject(testEnv, PROJECT_SLUG, { orgId: TEST_TEAM.id, id: PROJECT_ID });
  app = createTestApp(TEST_USER, TEST_TEAM.id, TEST_TEAM.slug);
});

afterEach(() => {
  testEnv.cleanup();
});

function seedDeployment(opts: {
  id: string;
  status: string;
  failedStep?: string | null;
  errorMessage?: string | null;
}) {
  const now = Date.now();
  testEnv.db.db.exec(
    `INSERT OR IGNORE INTO deployment
       (id, projectId, version, status, triggerType, failedStep, errorMessage, createdAt, updatedAt)
     VALUES ('${opts.id}', '${PROJECT_ID}', 1, '${opts.status}', 'cli',
       ${opts.failedStep ? `'${opts.failedStep}'` : "NULL"},
       ${opts.errorMessage ? `'${opts.errorMessage}'` : "NULL"}, ${now}, ${now})`,
  );
}

function getLogs(deploymentId: string) {
  return app.request(
    `/projects/${PROJECT_SLUG}/deployments/${deploymentId}/logs`,
    { method: "GET" },
    testEnv.env,
    executionCtx as never,
  );
}

describe("GET deployment logs — server-side failure fallback", () => {
  test("surfaces the recorded failure when no build_log row exists", async () => {
    seedDeployment({
      id: "dep-failed",
      status: "failed",
      failedStep: "deploying",
      errorMessage: "WfP activation timed out",
    });

    const res = await getLogs("dep-failed");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: { step: string; level: string; msg: string }[];
      metadata: { status: string; errorStep: string | null; synthesized?: boolean };
      message: string;
    };

    // One synthesized error entry carrying the deployment's recorded reason.
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toMatchObject({
      level: "error",
      msg: "WfP activation timed out",
      step: "activate",
    });
    expect(body.metadata).toMatchObject({
      status: "failed",
      errorStep: "deploying",
      synthesized: true,
    });
    expect(body.message).toContain("deploying");
  });

  test("classifies the recorded failure into a stable reason code + actionable hint", async () => {
    // A reaper-style activation timeout — agents branch on metadata.errorCode.
    seedDeployment({
      id: "dep-timeout",
      status: "failed",
      failedStep: "deploying",
      errorMessage:
        "Activation exceeded the 10-minute deploy window — most often the asset count/size.",
    });

    const res = await getLogs("dep-timeout");
    const body = (await res.json()) as {
      metadata: { errorCode: string | null };
      message: string;
    };
    expect(body.metadata.errorCode).toBe("activation_timeout");
    // The hint is appended so a human/agent gets a next step, not just a code.
    expect(body.message).toMatch(/reduce assets|split the deploy/i);
  });

  test("populates metadata.errorCode for a real timeout where a build_log exists but its errorCode is null", async () => {
    // The reaper fails the deploy out from under a still-running job, so the job
    // never records a code — the persisted build_log has errorCode = null even
    // though the deployment row says failedStep='deploying'. metadata.errorCode
    // must still resolve (was null before this fix; entries had the code but
    // metadata didn't).
    seedDeployment({
      id: "dep-real-timeout",
      status: "failed",
      failedStep: "deploying",
      errorMessage: "Activation exceeded the 10-minute deploy window",
    });
    const now = Date.now();
    const r2Key = "builds/acme/my-app/dep-real-timeout.ndjson.gz";
    testEnv.db.db.exec(
      `INSERT INTO build_log (deploymentId, r2Key, status, bytes, lines, startedAt, endedAt, errorCode)
       VALUES ('dep-real-timeout', '${r2Key}', 'failed', 20, 1, ${now}, ${now}, NULL)`,
    );
    const ndjson =
      JSON.stringify({ ts: now, step: "activate", stream: "creek", level: "error", msg: "Activation exceeded", code: "activation_timeout" }) + "\n";
    await testEnv.env.LOGS_BUCKET!.put(r2Key, gzipSync(Buffer.from(ndjson)));

    const res = await getLogs("dep-real-timeout");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { metadata: { errorCode: string | null }; entries: unknown[] };
    expect(body.metadata.errorCode).toBe("activation_timeout"); // derived, not null
    expect(body.entries.length).toBeGreaterThan(0); // the persisted entries still show
  });

  test("falls back to a sensible message even without a failedStep/errorMessage", async () => {
    seedDeployment({ id: "dep-bare", status: "failed" });

    const res = await getLogs("dep-bare");
    const body = (await res.json()) as { entries: { step: string; msg: string }[] };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toMatchObject({ step: "activate", msg: "Deploy failed" });
  });

  test("reports the live status for an in-progress deploy (no row yet)", async () => {
    seedDeployment({ id: "dep-running", status: "deploying" });

    const res = await getLogs("dep-running");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: unknown[];
      metadata: { status: string; synthesized?: boolean } | null;
      message: string;
    };
    expect(body.entries).toEqual([]);
    expect(body.metadata).toMatchObject({ status: "deploying", synthesized: true });
    expect(body.message).toContain("deploying");
  });

  test("returns 404 for an unknown deployment", async () => {
    const res = await getLogs("nope");
    expect(res.status).toBe(404);
  });

  test("maps server-side step names onto build-log steps", async () => {
    seedDeployment({
      id: "dep-prov",
      status: "failed",
      failedStep: "provisioning",
      errorMessage: "quota exceeded",
    });

    const res = await getLogs("dep-prov");
    const body = (await res.json()) as {
      entries: { step: string }[];
      metadata: { errorStep: string | null };
    };
    expect(body.entries[0].step).toBe("provision");
    // The raw server-side step is preserved in metadata.
    expect(body.metadata.errorStep).toBe("provisioning");
  });
});
