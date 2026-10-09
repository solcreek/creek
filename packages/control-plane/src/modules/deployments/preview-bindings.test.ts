import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createFixture, type Fixture } from "../tenant/scoped-key-fixture.js";
import type { Scope } from "../tenant/scopes.js";

// The real deploy job runs (SQLite); only Cloudflare and the edge deploy are
// stubbed, so a test sees exactly what a deploy would bind and create.
const deploy = vi.fn(async () => {});
vi.mock("./target.js", () => ({ resolveDeployTarget: () => ({ deploy }) }));
vi.mock("../resources/cloudflare.js", async (orig) => ({
  ...(await orig<object>()),
  findExistingCFResource: vi.fn(async () => null),
  provisionCFResource: vi.fn(
    async (_env: unknown, type: string, name: string) => `cf-${type}-${name}`,
  ),
  getQueue: vi.fn(async () => null),
  createQueue: vi.fn(async (_env: unknown, name: string) => `cfq-${name}`),
  setQueueConsumer: vi.fn(async () => {}),
}));

/**
 * A deploy binds every resource its bundle declares, creating what the
 * project lacks, and the project keeps those bindings: production picks them
 * up on its next deploy. A preview deploy by a scoped key without
 * resource:write may therefore only use what is already bound.
 */
describe("preview deploys and new bindings", () => {
  let f: Fixture;
  let owner: Awaited<ReturnType<Fixture["signUp"]>>;

  beforeEach(async () => {
    deploy.mockClear();
    f = createFixture();
    owner = await f.signUp("owner@example.com");
    const now = Date.now();
    await f.sql(
      "INSERT INTO project (id, slug, organizationId, createdAt, updatedAt) VALUES ('p', 'site', ?, ?, ?)",
      owner.orgId,
      now,
      now,
    );
    await f.sql(
      `INSERT INTO resource (id, teamId, kind, name, cfResourceId, cfResourceType, status, createdAt, updatedAt)
       VALUES ('r-db', ?, 'database', 'prod-db', 'cf-d1-prod', 'd1', 'active', ?, ?)`,
      owner.orgId,
      now,
      now,
    );
    await f.sql(
      "INSERT INTO project_resource_binding (projectId, bindingName, resourceId, createdAt) VALUES ('p', 'DB', 'r-db', ?)",
      now,
    );
    for (const [id, branch] of [
      ["dep-prev", "feature"],
      ["dep-prod", "main"],
    ]) {
      await f.sql(
        `INSERT INTO deployment (id, projectId, version, status, branch, triggerType, createdAt, updatedAt)
         VALUES (?, 'p', 1, 'queued', ?, 'cli', ?, ?)`,
        id,
        branch,
        now,
        now,
      );
    }
  });
  afterEach(() => f.cleanup());

  const bundle = (bindings: { type: string; bindingName: string }[], queue = false) => ({
    assets: { "index.html": btoa("<h1>x</h1>") },
    manifest: { assets: ["index.html"], hasWorker: false, entrypoint: null, renderMode: "spa" },
    bindings,
    queue,
  });

  async function upload(key: string, deployment: string, body: unknown) {
    const res = await f.call(
      "PUT",
      `/projects/site/deployments/${deployment}/bundle`,
      { "x-api-key": key },
      body,
    );
    await f.settle();
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  const keyWith = (scopes: Scope[]) => f.scopedKey(owner.userId, owner.orgId, scopes);
  const projectState = async () => ({
    resources: (await f.sql<{ id: string }>("SELECT id FROM resource ORDER BY id")).map(
      (r) => r.id,
    ),
    bindings: (
      await f.sql<{ bindingName: string }>(
        "SELECT bindingName FROM project_resource_binding ORDER BY bindingName",
      )
    ).map((b) => b.bindingName),
  });

  it("refuses a preview deploy that would add a binding, before anything is staged or run", async () => {
    const key = await keyWith(["deploy:preview"]);
    const before = await projectState();
    const res = await upload(
      key,
      "dep-prev",
      bundle(
        [
          { type: "d1", bindingName: "DB" },
          { type: "kv", bindingName: "CACHE" },
        ],
        true,
      ),
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error: "insufficient_scope",
      required: ["resource:write"],
      newBindings: ["CACHE", "QUEUE"],
    });
    expect(res.body.message).toContain("CACHE, QUEUE");
    expect(await projectState()).toEqual(before);
    expect(deploy).not.toHaveBeenCalled();
    expect(await f.env.ASSETS.get("bundles/dep-prev.json")).toBeNull();
    const [dep] = await f.sql<{ status: string }>(
      "SELECT status FROM deployment WHERE id = 'dep-prev'",
    );
    expect(dep.status).toBe("queued");
  });

  it("counts a new name for an existing resource (alias adoption) and an AI binding as added", async () => {
    const key = await keyWith(["deploy:preview"]);
    for (const binding of [
      { type: "d1", bindingName: "DATABASE" }, // DB's deprecated-alias primary
      { type: "ai", bindingName: "AI" },
    ]) {
      const res = await upload(key, "dep-prev", bundle([binding]));
      expect([res.status, res.body.newBindings], binding.bindingName).toEqual([
        403,
        [binding.bindingName],
      ]);
    }
  });

  it("deploys a preview that only uses what is already bound", async () => {
    const key = await keyWith(["deploy:preview"]);
    const before = await projectState();
    const res = await upload(key, "dep-prev", bundle([{ type: "d1", bindingName: "DB" }]));
    expect(res.status).toBe(202);
    expect(deploy).toHaveBeenCalledTimes(1);
    expect(await projectState()).toEqual(before);
  });

  it("lets a preview add bindings when the key may manage resources", async () => {
    const key = await keyWith(["deploy:preview", "resource:write"]);
    const res = await upload(key, "dep-prev", bundle([{ type: "kv", bindingName: "CACHE" }]));
    expect(res.status).toBe(202);
    expect((await projectState()).bindings).toEqual(["CACHE", "DB"]);
  });

  it("still refuses when the key holds resource:write but its owner's role no longer allows it", async () => {
    const key = await keyWith(["deploy:preview", "resource:write"]);
    await f.sql("UPDATE member SET role = 'member'");
    const res = await upload(key, "dep-prev", bundle([{ type: "kv", bindingName: "CACHE" }]));
    expect([res.status, res.body.error]).toEqual([403, "insufficient_role"]);
    expect((await projectState()).bindings).toEqual(["DB"]);
  });

  it("leaves production deploys provisioning as before", async () => {
    const key = await keyWith(["deploy:production"]);
    const res = await upload(key, "dep-prod", bundle([{ type: "kv", bindingName: "CACHE" }], true));
    expect(res.status).toBe(202);
    expect((await projectState()).bindings).toEqual(["CACHE", "DB", "QUEUE"]);
  });

  it("leaves legacy keys and dashboard sessions as before", async () => {
    const legacy = await f.legacyKey(owner.cookie);
    const res = await upload(legacy, "dep-prev", bundle([{ type: "kv", bindingName: "CACHE" }]));
    expect(res.status).toBe(202);
    expect((await projectState()).bindings).toEqual(["CACHE", "DB"]);
  });

  it("refuses malformed bindings for every caller, so nothing slips past the check", async () => {
    const preview = await keyWith(["deploy:preview"]);
    const legacy = await f.legacyKey(owner.cookie);
    const before = await projectState();
    for (const bindings of [
      [{ type: "kv", bindingName: 123 }],
      [{ type: "kv" }],
      [{ bindingName: "CACHE" }],
      [null],
      ["CACHE"],
      { CACHE: "kv" },
      "CACHE",
    ]) {
      for (const key of [preview, legacy]) {
        const res = await upload(key, "dep-prev", {
          ...bundle([]),
          bindings,
        });
        expect([res.status, res.body.error], JSON.stringify(bindings)).toEqual([400, "validation"]);
      }
    }
    expect(await projectState()).toEqual(before);
    expect(deploy).not.toHaveBeenCalled();
    expect(await f.env.ASSETS.get("bundles/dep-prev.json")).toBeNull();
  });

  it("treats a bound name whose resource row is gone as unbound, as the deploy would", async () => {
    f.t.db.db.exec("PRAGMA foreign_keys = OFF; DELETE FROM resource WHERE id = 'r-db'");
    const key = await keyWith(["deploy:preview"]);
    const res = await upload(key, "dep-prev", bundle([{ type: "d1", bindingName: "DB" }]));
    expect([res.status, res.body.newBindings]).toEqual([403, ["DB"]]);
  });
});
