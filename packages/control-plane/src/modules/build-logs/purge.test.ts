import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { purgeExpiredBuildLogs } from "./purge.js";
import { createLocalTestEnv, type LocalTestEnv } from "../../local/test-env.js";
import type { Env } from "../../types.js";

const DAY = 24 * 60 * 60 * 1000;

let testEnv: LocalTestEnv;

beforeEach(() => {
  testEnv = createLocalTestEnv();
  // Disable FK checks — purge tests don't need referential integrity
  testEnv.db.db.pragma("foreign_keys = OFF");
});

afterEach(() => {
  testEnv.cleanup();
  vi.useRealTimers();
});

async function insertBuildLog(
  deploymentId: string,
  r2Key: string,
  status: string,
  startedAt: number,
) {
  // FK checks disabled — insert build_log directly
  await testEnv.env.DB.prepare(
    `INSERT INTO build_log (deploymentId, r2Key, status, bytes, lines, startedAt, endedAt)
     VALUES (?, ?, ?, 100, 10, ?, ?)`,
  ).bind(deploymentId, r2Key, status, startedAt, startedAt).run();
}

describe("purgeExpiredBuildLogs", () => {
  test("returns 0 when LOGS_BUCKET is unconfigured", async () => {
    const env = { ...testEnv.env, LOGS_BUCKET: undefined } as unknown as Env;
    const deleted = await purgeExpiredBuildLogs(env);
    expect(deleted).toBe(0);
  });

  test("deletes R2 object and D1 row for expired successful builds", async () => {
    const oldDate = Date.now() - 31 * DAY;
    await insertBuildLog("dep-1", "builds/acme/app/dep-1.ndjson.gz", "success", oldDate);
    await insertBuildLog("dep-2", "builds/acme/app/dep-2.ndjson.gz", "success", oldDate);

    // Put files in R2
    await testEnv.env.LOGS_BUCKET!.put("builds/acme/app/dep-1.ndjson.gz", "log1");
    await testEnv.env.LOGS_BUCKET!.put("builds/acme/app/dep-2.ndjson.gz", "log2");

    const deleted = await purgeExpiredBuildLogs(testEnv.env);
    expect(deleted).toBe(2);

    // R2 objects deleted
    expect(await testEnv.env.LOGS_BUCKET!.get("builds/acme/app/dep-1.ndjson.gz")).toBeNull();
    expect(await testEnv.env.LOGS_BUCKET!.get("builds/acme/app/dep-2.ndjson.gz")).toBeNull();

    // D1 rows deleted
    const remaining = await testEnv.env.DB.prepare("SELECT COUNT(*) as cnt FROM build_log").first() as any;
    expect(remaining.cnt).toBe(0);
  });

  test("does not delete recent builds", async () => {
    const recentDate = Date.now() - 1 * DAY;
    await insertBuildLog("dep-new", "builds/acme/app/dep-new.ndjson.gz", "success", recentDate);

    const deleted = await purgeExpiredBuildLogs(testEnv.env);
    expect(deleted).toBe(0);

    const remaining = await testEnv.env.DB.prepare("SELECT COUNT(*) as cnt FROM build_log").first() as any;
    expect(remaining.cnt).toBe(1);
  });

  test("continues to D1 cleanup even if R2 delete throws", async () => {
    const oldDate = Date.now() - 31 * DAY;
    await insertBuildLog("dep-x", "builds/acme/app/dep-x.ndjson.gz", "success", oldDate);
    // Don't put the R2 file — delete will be a no-op (not throw)

    const deleted = await purgeExpiredBuildLogs(testEnv.env);
    expect(deleted).toBe(1);

    const remaining = await testEnv.env.DB.prepare("SELECT COUNT(*) as cnt FROM build_log").first() as any;
    expect(remaining.cnt).toBe(0);
  });

  test("failed builds use 90-day cutoff", async () => {
    const thirtyOneDays = Date.now() - 31 * DAY;
    const ninetyOneDays = Date.now() - 91 * DAY;

    // 31 days old failed build — should NOT be purged
    await insertBuildLog("dep-recent-fail", "builds/f1.gz", "failed", thirtyOneDays);
    // 91 days old failed build — should be purged
    await insertBuildLog("dep-old-fail", "builds/f2.gz", "failed", ninetyOneDays);

    const deleted = await purgeExpiredBuildLogs(testEnv.env);
    expect(deleted).toBe(1);

    const remaining = await testEnv.env.DB.prepare("SELECT deploymentId FROM build_log").all() as any;
    expect(remaining.results).toHaveLength(1);
    expect(remaining.results[0].deploymentId).toBe("dep-recent-fail");
  });
});
