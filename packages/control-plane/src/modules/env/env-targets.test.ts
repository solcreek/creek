import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createFixture, type Fixture } from "../tenant/scoped-key-fixture.js";

// The real deploy job runs; only Cloudflare and the edge deploy are stubbed,
// so a test sees the exact bindings — secrets included — a worker would get.
const deploy = vi.fn(async () => {});
vi.mock("../deployments/target.js", () => ({ resolveDeployTarget: () => ({ deploy }) }));
vi.mock("../resources/cloudflare.js", async (orig) => ({
  ...(await orig<object>()),
  findExistingCFResource: vi.fn(async () => null),
  provisionCFResource: vi.fn(async () => "cf-x"),
  setQueueConsumer: vi.fn(async () => {}),
}));

describe("environment variables per deploy target", () => {
  let f: Fixture;
  let key: string;

  beforeEach(async () => {
    deploy.mockClear();
    f = createFixture();
    f.env.ENCRYPTION_KEY = "test-encryption-key";
    const owner = await f.signUp("owner@example.com");
    key = await f.legacyKey(owner.cookie);
    const now = Date.now();
    await f.sql(
      "INSERT INTO project (id, slug, organizationId, createdAt, updatedAt) VALUES ('p', 'site', ?, ?, ?)",
      owner.orgId,
      now,
      now,
    );
  });
  afterEach(() => f.cleanup());

  const set = (k: string, value: string, target?: string) =>
    f.call("POST", "/projects/site/env", { "x-api-key": key }, { key: k, value, target });
  const list = async () =>
    (await (await f.call("GET", "/projects/site/env", { "x-api-key": key })).json()) as {
      key: string;
      target: string;
      value: string;
    }[];

  async function secretsOfDeploy(branch: string | null): Promise<Record<string, string>> {
    const id = `dep-${branch ?? "prod"}`;
    const now = Date.now();
    await f.sql(
      `INSERT INTO deployment (id, projectId, version, status, branch, triggerType, createdAt, updatedAt)
       VALUES (?, 'p', 1, 'queued', ?, 'cli', ?, ?)`,
      id,
      branch,
      now,
      now,
    );
    deploy.mockClear();
    const res = await f.call(
      "PUT",
      `/projects/site/deployments/${id}/bundle`,
      { "x-api-key": key },
      {
        assets: { "index.html": btoa("<h1>x</h1>") },
        manifest: { assets: ["index.html"], hasWorker: false, entrypoint: null, renderMode: "spa" },
      },
    );
    expect(res.status).toBe(202);
    await f.settle();
    expect(deploy).toHaveBeenCalledTimes(1);
    const input = (deploy.mock.calls[0] as unknown[])[4] as {
      bindings: { type: string; name: string; text?: string }[];
    };
    const secrets = input.bindings.filter((b) => b.type === "secret_text");
    // Each name bound once: a second binding of the same name would leave the
    // value to whichever the runtime keeps.
    const names = secrets.map((b) => b.name);
    expect(new Set(names).size, `duplicate bindings: ${names.join(", ")}`).toBe(names.length);
    return Object.fromEntries(secrets.map((b) => [b.name, b.text!]));
  }

  it("stores one value per key and target, and lists them without values", async () => {
    expect((await set("STRIPE_KEY", "sk_default")).status).toBe(201);
    expect(await (await set("STRIPE_KEY", "sk_live", "production")).json()).toMatchObject({
      ok: true,
      key: "STRIPE_KEY",
      target: "production",
    });
    expect((await set("STRIPE_KEY", "sk_test", "preview")).status).toBe(201);
    expect((await set("STRIPE_KEY", "sk_live_2", "production")).status).toBe(201); // update

    const vars = await list();
    expect(vars.map((v) => [v.key, v.target])).toEqual([
      ["STRIPE_KEY", "all"],
      ["STRIPE_KEY", "preview"],
      ["STRIPE_KEY", "production"],
    ]);
    for (const v of vars) expect(JSON.stringify(v)).not.toMatch(/sk_/);
    const stored = await f.sql<{ encryptedValue: string }>(
      "SELECT encryptedValue FROM environment_variable",
    );
    for (const row of stored) expect(row.encryptedValue).not.toMatch(/sk_/);
  });

  it("refuses an unknown target", async () => {
    for (const target of ["staging", "Production", "", 1]) {
      const res = await set("K", "v", target as string);
      expect(res.status, String(target)).toBe(400);
    }
    const del = await f.call("DELETE", "/projects/site/env/K?target=staging", { "x-api-key": key });
    expect(del.status).toBe(400);
    expect(await f.sql("SELECT key FROM environment_variable")).toEqual([]);
  });

  it("gives a branch deploy preview values and a production deploy production values, each falling back to all", async () => {
    await set("STRIPE_KEY", "sk_default");
    await set("STRIPE_KEY", "sk_live", "production");
    await set("STRIPE_KEY", "sk_test", "preview");
    await set("PROD_ONLY_SECRET", "prod-secret", "production");
    await set("PREVIEW_ONLY", "preview-value", "preview");
    await set("SHARED", "shared-value");

    expect(await secretsOfDeploy(null)).toEqual({
      STRIPE_KEY: "sk_live",
      PROD_ONLY_SECRET: "prod-secret",
      SHARED: "shared-value",
    });
    expect(await secretsOfDeploy("feature")).toEqual({
      STRIPE_KEY: "sk_test",
      PREVIEW_ONLY: "preview-value",
      SHARED: "shared-value",
    });
  });

  it("follows the project's production branch", async () => {
    await f.sql("UPDATE project SET productionBranch = 'release' WHERE id = 'p'");
    await set("PROD_ONLY_SECRET", "prod-secret", "production");
    expect(await secretsOfDeploy("main")).toEqual({});
    expect(await secretsOfDeploy("release")).toEqual({ PROD_ONLY_SECRET: "prod-secret" });
  });

  it("deploys variables set before targets existed (all) to both, as before", async () => {
    await set("LEGACY", "legacy-value");
    expect(await secretsOfDeploy(null)).toEqual({ LEGACY: "legacy-value" });
    expect(await secretsOfDeploy("feature")).toEqual({ LEGACY: "legacy-value" });
  });

  it("removes one target's value with ?target=, or every target's without", async () => {
    await set("K", "a");
    await set("K", "p", "production");
    await set("K", "q", "preview");

    const one = await f.call("DELETE", "/projects/site/env/K?target=preview", { "x-api-key": key });
    expect(await one.json()).toEqual({ ok: true, removed: 1 });
    expect((await list()).map((v) => v.target)).toEqual(["all", "production"]);

    const missing = await f.call("DELETE", "/projects/site/env/K?target=preview", {
      "x-api-key": key,
    });
    expect(missing.status).toBe(404);

    const all = await f.call("DELETE", "/projects/site/env/K", { "x-api-key": key });
    expect(await all.json()).toEqual({ ok: true, removed: 2 });
    expect(await list()).toEqual([]);
  });

  it("records the target in the audit log", async () => {
    await set("K", "v", "production");
    await f.call("DELETE", "/projects/site/env/K?target=production", { "x-api-key": key });
    const rows = await f.sql<{ action: string; metadata: string }>(
      "SELECT action, metadata FROM audit_log WHERE action LIKE 'envvar.%' ORDER BY createdAt",
    );
    expect(rows.map((r) => [r.action, JSON.parse(r.metadata)])).toEqual([
      ["envvar.set", { key: "K", target: "production" }],
      ["envvar.delete", { key: "K", target: "production" }],
    ]);
  });
});
