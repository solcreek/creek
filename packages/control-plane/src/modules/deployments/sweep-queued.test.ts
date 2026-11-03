import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalTestEnv, type LocalTestEnv } from "../../local/test-env.js";
import { classifyDeployFailure } from "../build-logs/classify.js";
import {
  ABANDONED_QUEUED_BATCH,
  ABANDONED_QUEUED_MS,
  ABANDONED_UPLOAD_MESSAGE,
  ABANDONED_BUILD_MESSAGE,
  sweepAbandonedQueuedDeployments,
} from "./sweep-queued.js";

const NOW = 1_800_000_000_000;
const OLD = NOW - ABANDONED_QUEUED_MS - 1;
const RECENT = NOW - ABANDONED_QUEUED_MS + 60_000;

let t: LocalTestEnv;
let version = 0;

beforeEach(() => {
  t = createLocalTestEnv();
  version = 0;
  t.db.db
    .prepare("INSERT INTO organization (id, name, slug, createdAt) VALUES ('org', 'O', 'o', ?)")
    .run(NOW);
  t.db.db
    .prepare(
      "INSERT INTO project (id, slug, organizationId, createdAt, updatedAt) VALUES ('proj', 'site', 'org', ?, ?)",
    )
    .run(NOW, NOW);
});
afterEach(() => t.cleanup());

function deployment(id: string, status: string, updatedAt: number, triggerType = "cli") {
  t.db.db
    .prepare(
      `INSERT INTO deployment (id, projectId, version, status, triggerType, createdAt, updatedAt)
       VALUES (?, 'proj', ?, ?, ?, ?, ?)`,
    )
    .run(id, ++version, status, triggerType, updatedAt, updatedAt);
}

function row(id: string) {
  return t.db.db
    .prepare("SELECT status, failedStep, errorMessage, updatedAt FROM deployment WHERE id = ?")
    .get(id) as {
    status: string;
    failedStep: string | null;
    errorMessage: string | null;
    updatedAt: number;
  };
}

describe("sweepAbandonedQueuedDeployments", () => {
  it("fails a CLI or remote-builder deployment queued for over an hour as an upload that never arrived", async () => {
    deployment("cli-old", "queued", OLD, "cli");
    deployment("remote-old", "queued", OLD, "remote");

    expect(await sweepAbandonedQueuedDeployments(t.env, NOW)).toBe(2);

    for (const id of ["cli-old", "remote-old"]) {
      const r = row(id);
      expect(r).toEqual({
        status: "failed",
        failedStep: "uploading",
        errorMessage: ABANDONED_UPLOAD_MESSAGE,
        updatedAt: NOW,
      });
      expect(classifyDeployFailure(r.failedStep, r.errorMessage).code).toBe("upload_incomplete");
    }
  });

  it("fails a GitHub deployment queued for over an hour as a build that never reported back", async () => {
    deployment("gh-old", "queued", OLD, "github");
    await sweepAbandonedQueuedDeployments(t.env, NOW);
    const r = row("gh-old");
    expect(r.status).toBe("failed");
    expect(r.failedStep).toBe("building");
    expect(r.errorMessage).toBe(ABANDONED_BUILD_MESSAGE);
    expect(classifyDeployFailure(r.failedStep, r.errorMessage).code).toBe("build_incomplete");
  });

  it("leaves a deployment queued for under an hour, and every other status, alone", async () => {
    deployment("recent", "queued", RECENT);
    for (const s of ["active", "failed", "uploading", "deploying", "cancelled"]) {
      deployment(`old-${s}`, s, OLD);
    }
    expect(await sweepAbandonedQueuedDeployments(t.env, NOW)).toBe(0);
    expect(row("recent").status).toBe("queued");
    for (const s of ["active", "failed", "uploading", "deploying", "cancelled"]) {
      expect(row(`old-${s}`)).toMatchObject({ status: s, updatedAt: OLD });
    }
  });

  it("reclaims the swept deployment's R2 staging, and only its own", async () => {
    deployment("swept", "queued", OLD);
    deployment("kept", "queued", RECENT);
    for (const id of ["swept", "kept"]) {
      await t.env.ASSETS.put(`bundles/${id}-server/index.js`, "x");
      await t.env.ASSETS.put(`bundles/${id}-server/chunk.js`, "y");
    }

    await sweepAbandonedQueuedDeployments(t.env, NOW);

    expect((await t.env.ASSETS.list({ prefix: "bundles/swept-server/" })).objects).toHaveLength(0);
    expect((await t.env.ASSETS.list({ prefix: "bundles/kept-server/" })).objects).toHaveLength(2);
  });

  it(`fails at most ${ABANDONED_QUEUED_BATCH} per tick, oldest first, and drains the rest on later ticks`, async () => {
    const n = ABANDONED_QUEUED_BATCH + 7;
    for (let i = 0; i < n; i++) deployment(`q${i}`, "queued", OLD - (n - i));

    expect(await sweepAbandonedQueuedDeployments(t.env, NOW)).toBe(ABANDONED_QUEUED_BATCH);
    // The oldest went first.
    expect(row("q0").status).toBe("failed");
    expect(row(`q${n - 1}`).status).toBe("queued");

    expect(await sweepAbandonedQueuedDeployments(t.env, NOW)).toBe(7);
    expect(await sweepAbandonedQueuedDeployments(t.env, NOW)).toBe(0);
  });
});
