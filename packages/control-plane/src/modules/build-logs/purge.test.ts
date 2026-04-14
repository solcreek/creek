import { describe, test, expect, vi } from "vitest";
import { purgeExpiredBuildLogs } from "./purge.js";
import type { Env } from "../../types.js";

const DAY = 24 * 60 * 60 * 1000;

function makeEnv(rows: Array<{ deploymentId: string; r2Key: string }>) {
  const all = vi.fn().mockResolvedValue({ results: rows });
  const deleteRowRun = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
  const r2Delete = vi.fn().mockResolvedValue(undefined);

  const prepare = vi.fn((_sql: string) => {
    // Two shapes: SELECT and DELETE. Distinguish by return.
    return {
      bind: vi.fn().mockReturnValue({
        all,
        run: deleteRowRun,
      }),
    };
  });

  const env = {
    DB: { prepare },
    LOGS_BUCKET: { delete: r2Delete },
  } as unknown as Env;

  return { env, prepare, all, deleteRowRun, r2Delete };
}

describe("purgeExpiredBuildLogs", () => {
  test("returns 0 when LOGS_BUCKET is unconfigured", async () => {
    const env = { DB: {}, LOGS_BUCKET: undefined } as unknown as Env;
    const deleted = await purgeExpiredBuildLogs(env);
    expect(deleted).toBe(0);
  });

  test("deletes R2 object and D1 row for each expired build", async () => {
    const { env, r2Delete, deleteRowRun } = makeEnv([
      { deploymentId: "dep-1", r2Key: "builds/acme/app/dep-1.ndjson.gz" },
      { deploymentId: "dep-2", r2Key: "builds/acme/app/dep-2.ndjson.gz" },
    ]);
    const deleted = await purgeExpiredBuildLogs(env);
    expect(deleted).toBe(2);
    expect(r2Delete).toHaveBeenCalledTimes(2);
    expect(r2Delete).toHaveBeenNthCalledWith(1, "builds/acme/app/dep-1.ndjson.gz");
    expect(r2Delete).toHaveBeenNthCalledWith(2, "builds/acme/app/dep-2.ndjson.gz");
    expect(deleteRowRun).toHaveBeenCalledTimes(2);
  });

  test("continues to D1 cleanup even if R2 delete throws", async () => {
    const { env, deleteRowRun } = makeEnv([
      { deploymentId: "dep-x", r2Key: "builds/acme/app/dep-x.ndjson.gz" },
    ]);
    // Override r2Delete to throw
    (env.LOGS_BUCKET as unknown as { delete: typeof vi.fn }).delete = vi
      .fn()
      .mockRejectedValue(new Error("r2 gone"));
    const deleted = await purgeExpiredBuildLogs(env);
    // Still counts as handled — orphan R2 object tolerated, D1 cleaned.
    expect(deleted).toBe(1);
    expect(deleteRowRun).toHaveBeenCalledTimes(1);
  });

  test("passes correct cutoff timestamps for success vs failed", async () => {
    const { env, prepare } = makeEnv([]);
    const now = Date.now();
    vi.setSystemTime(now);
    await purgeExpiredBuildLogs(env);
    // First bind call (select) should receive success cutoff, failed cutoff, batch size
    const bindMock = prepare.mock.results[0].value.bind;
    const args = bindMock.mock.calls[0];
    const successCutoff = args[0] as number;
    const failedCutoff = args[1] as number;
    expect(now - successCutoff).toBeGreaterThanOrEqual(30 * DAY - 1000);
    expect(now - successCutoff).toBeLessThanOrEqual(30 * DAY + 1000);
    expect(now - failedCutoff).toBeGreaterThanOrEqual(90 * DAY - 1000);
    expect(now - failedCutoff).toBeLessThanOrEqual(90 * DAY + 1000);
  });
});
