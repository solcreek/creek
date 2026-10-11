import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createFixture, type Fixture } from "../tenant/scoped-key-fixture.js";

const deploy = vi.fn(async () => {});
vi.mock("../deployments/target.js", () => ({ resolveDeployTarget: () => ({ deploy }) }));

const MIGRATION_0013 = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../drizzle/0013_env_var_targets.sql",
);

/**
 * The Worker deploys on merge; migrations are applied by hand. This code
 * must therefore work on the table before 0013 (one value per key), and
 * pick up targets as soon as 0013 is applied — no redeploy, no window where
 * deploys or `env set` fail.
 */
describe("environment variables before and after migration 0013", () => {
  let f: Fixture;
  afterEach(() => {
    deploy.mockClear();
    f.cleanup();
  });

  async function setup() {
    f = createFixture({ migrationsUpTo: "0012_project_production_branch_from_github.sql" });
    f.env.ENCRYPTION_KEY = "test-encryption-key";
    const owner = await f.signUp("owner@example.com");
    const key = await f.legacyKey(owner.cookie);
    const now = Date.now();
    await f.sql(
      "INSERT INTO project (id, slug, organizationId, createdAt, updatedAt) VALUES ('p', 'site', ?, ?, ?)",
      owner.orgId,
      now,
      now,
    );
    return key;
  }

  const call = (key: string, method: string, path: string, body?: unknown) =>
    f.call(method, path, { "x-api-key": key }, body);

  async function secretsOfDeploy(key: string, id: string, branch: string | null) {
    await f.sql(
      `INSERT INTO deployment (id, projectId, version, status, branch, triggerType, createdAt, updatedAt)
       VALUES (?, 'p', 1, 'queued', ?, 'cli', ?, ?)`,
      id,
      branch,
      Date.now(),
      Date.now(),
    );
    deploy.mockClear();
    const res = await call(key, "PUT", `/projects/site/deployments/${id}/bundle`, {
      assets: { "index.html": btoa("<h1>x</h1>") },
      manifest: { assets: ["index.html"], hasWorker: false, entrypoint: null, renderMode: "spa" },
    });
    expect(res.status).toBe(202);
    await f.settle();
    const [dep] = await f.sql<{ status: string; errorMessage: string | null }>(
      "SELECT status, errorMessage FROM deployment WHERE id = ?",
      id,
    );
    expect([dep.status, dep.errorMessage], id).toEqual(["active", null]);
    const input = (deploy.mock.calls[0] as unknown[])[4] as {
      bindings: { type: string; name: string; text?: string }[];
    };
    return Object.fromEntries(
      input.bindings.filter((b) => b.type === "secret_text").map((b) => [b.name, b.text!]),
    );
  }

  it("works on the old table, refusing only per-target values, then picks up targets once 0013 is applied", async () => {
    const key = await setup();
    const columns = await f.sql<{ name: string }>(
      "SELECT name FROM pragma_table_info('environment_variable')",
    );
    expect(columns.map((c) => c.name)).not.toContain("target");

    // Before 0013: all-deploys values work as before.
    const set = await call(key, "POST", "/projects/site/env", { key: "SHARED", value: "v1" });
    expect([set.status, ((await set.json()) as { target: string }).target]).toEqual([201, "all"]);
    expect(
      (await call(key, "POST", "/projects/site/env", { key: "SHARED", value: "v2" })).status,
    ).toBe(201);

    // A per-target value is refused, not stored for every deploy.
    const prod = await call(key, "POST", "/projects/site/env", {
      key: "STRIPE_KEY",
      value: "sk_live",
      target: "production",
    });
    expect([prod.status, ((await prod.json()) as { error: string }).error]).toEqual([
      409,
      "env_targets_unavailable",
    ]);

    const list = (await (await call(key, "GET", "/projects/site/env")).json()) as {
      key: string;
      target: string;
    }[];
    expect(list.map((v) => [v.key, v.target])).toEqual([["SHARED", "all"]]);

    // Deploys keep working and get the all-deploys values.
    expect(await secretsOfDeploy(key, "d-prod-1", null)).toEqual({ SHARED: "v2" });
    expect(await secretsOfDeploy(key, "d-prev-1", "feature")).toEqual({ SHARED: "v2" });

    // A per-target delete is refused rather than deleting the all value.
    const rm = await call(key, "DELETE", "/projects/site/env/SHARED?target=preview");
    expect(rm.status).toBe(409);
    expect((await f.sql("SELECT key FROM environment_variable")).length).toBe(1);

    // Apply 0013 to the live database: no redeploy, no restart.
    f.t.db.db.exec(readFileSync(MIGRATION_0013, "utf-8"));

    expect(
      (
        await call(key, "POST", "/projects/site/env", {
          key: "STRIPE_KEY",
          value: "sk_live",
          target: "production",
        })
      ).status,
    ).toBe(201);
    expect(await secretsOfDeploy(key, "d-prod-2", null)).toEqual({
      SHARED: "v2",
      STRIPE_KEY: "sk_live",
    });
    expect(await secretsOfDeploy(key, "d-prev-2", "feature")).toEqual({ SHARED: "v2" });
  });

  it("still removes a whole key on the old table", async () => {
    const key = await setup();
    await call(key, "POST", "/projects/site/env", { key: "OLD", value: "v" });
    for (const path of ["/projects/site/env/OLD?target=all", "/projects/site/env/OLD"]) {
      await call(key, "POST", "/projects/site/env", { key: "OLD", value: "v" });
      const res = await call(key, "DELETE", path);
      expect(res.status, path).toBe(200);
      expect(await f.sql("SELECT key FROM environment_variable")).toEqual([]);
    }
  });
});

describe("envTargetsAvailable", () => {
  const db = (fail: Error | null) =>
    ({
      prepare: () => ({
        all: async () => {
          if (fail) throw fail;
          return { results: [] };
        },
      }),
    }) as never;

  it("says no only for a missing column, and rethrows any other error", async () => {
    const { envTargetsAvailable } = await import("./schema-compat.js");
    expect(
      await envTargetsAvailable(db(new Error("D1_ERROR: no such column: target: SQLITE_ERROR"))),
    ).toBe(false);
    await expect(
      envTargetsAvailable(db(new Error("D1_ERROR: Network connection lost."))),
    ).rejects.toThrow("Network connection lost");
    expect(await envTargetsAvailable(db(null))).toBe(true);
  });
});
