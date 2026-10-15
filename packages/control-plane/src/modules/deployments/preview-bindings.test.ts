import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createFixture, type Fixture } from "../tenant/scoped-key-fixture.js";
import { runDeployJob } from "./deploy-job.js";
import { ensureQueue } from "../resources/service.js";
import type { Scope } from "../tenant/scopes.js";

// The real deploy job runs (SQLite); only Cloudflare and the edge deploy are
// stubbed, so a test sees exactly what a deploy would bind and create.
const deploy = vi.fn(async () => {});
vi.mock("./target.js", () => ({ resolveDeployTarget: () => ({ deploy }) }));
vi.mock("../resources/cloudflare.js", async (orig) => ({
  ...(await orig<object>()),
  findExistingCFResource: vi.fn(async () => null),
  // Like the real one: only D1/R2/KV can be provisioned.
  provisionCFResource: vi.fn(async (_env: unknown, type: string, name: string) => {
    if (type !== "d1" && type !== "r2" && type !== "kv") {
      throw new Error(`Unknown CF resource type: ${type}`);
    }
    return `cf-${type}-${name}`;
  }),
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

  it("refuses Workers AI declared under a name bound to another resource, for every caller", async () => {
    // AI is bound under the name it declares. Under a bound database's name
    // (DB) it is a conflict, never AI turned on beside it.
    for (const key of [
      await keyWith(["deploy:preview"]),
      await keyWith(["deploy:preview", "resource:write"]),
      await f.legacyKey(owner.cookie),
    ]) {
      const before = await projectState();
      const res = await upload(key, "dep-prev", bundle([{ type: "ai", bindingName: "DB" }]));
      expect([res.status, res.body.error]).toEqual([409, "binding_conflict"]);
      expect(res.body.conflicts).toEqual([
        expect.stringContaining(
          "DB is attached to a database resource, but the bundle declares it as ai",
        ),
      ]);
      expect(await projectState()).toEqual(before);
      expect(await f.env.ASSETS.get("bundles/dep-prev.json")).toBeNull();
    }
    expect(deploy).not.toHaveBeenCalled();

    // A preview without resource:write may not add AI under a new name either.
    const key = await keyWith(["deploy:preview"]);
    const res = await upload(key, "dep-prev", bundle([{ type: "ai", bindingName: "AI" }]));
    expect([res.status, res.body.newBindings]).toEqual([403, ["AI"]]);

    // Once the project has AI, a preview may use it.
    const now = Date.now();
    await f.sql(
      `INSERT INTO resource (id, teamId, kind, name, cfResourceId, cfResourceType, status, createdAt, updatedAt)
       VALUES ('r-ai', ?, 'ai', 'ai', NULL, 'ai', 'active', ?, ?)`,
      owner.orgId,
      now,
      now,
    );
    await f.sql(
      "INSERT INTO project_resource_binding (projectId, bindingName, resourceId, createdAt) VALUES ('p', 'AI', 'r-ai', ?)",
      now,
    );
    const ok = await upload(key, "dep-prev", bundle([{ type: "ai", bindingName: "AI" }]));
    expect(ok.status).toBe(202);
  });

  it("accepts a preview using AI the project already has under a custom name", async () => {
    // wrangler `[ai] binding = "MODEL"` is stored under MODEL, not AI.
    const now = Date.now();
    await f.sql(
      `INSERT INTO resource (id, teamId, kind, name, cfResourceId, cfResourceType, status, createdAt, updatedAt)
       VALUES ('r-model', ?, 'ai', 'model', NULL, 'ai', 'active', ?, ?)`,
      owner.orgId,
      now,
      now,
    );
    await f.sql(
      "INSERT INTO project_resource_binding (projectId, bindingName, resourceId, createdAt) VALUES ('p', 'MODEL', 'r-model', ?)",
      now,
    );
    const key = await keyWith(["deploy:preview"]);
    const res = await upload(key, "dep-prev", bundle([{ type: "ai", bindingName: "MODEL" }]));
    expect(res.status).toBe(202);
    // Accepted is not enough: the job must deploy it, with Workers AI bound
    // under the name the worker reads (env.MODEL), and under no other.
    const [dep] = await f.sql<{ status: string; errorMessage: string | null }>(
      "SELECT status, errorMessage FROM deployment WHERE id = 'dep-prev'",
    );
    expect([dep.status, dep.errorMessage]).toEqual(["active", null]);
    const input = (deploy.mock.calls.at(-1) as unknown[])[4] as {
      bindings: { type: string; name: string }[];
    };
    expect(input.bindings.filter((b) => b.type === "ai")).toEqual([{ type: "ai", name: "MODEL" }]);
  });

  it("refuses a deploy whose declared type does not match an attached AI resource, leaving the resource intact", async () => {
    // An AI resource attached as CACHE, while the bundle declares CACHE as kv:
    // neither drop the binding nor provision a KV onto the team's AI row
    // (other projects may bind it as AI).
    const now = Date.now();
    await f.sql(
      `INSERT INTO resource (id, teamId, kind, name, cfResourceId, cfResourceType, status, createdAt, updatedAt)
       VALUES ('r-ai-cache', ?, 'ai', 'ai', NULL, 'ai', 'active', ?, ?)`,
      owner.orgId,
      now,
      now,
    );
    await f.sql(
      "INSERT INTO project_resource_binding (projectId, bindingName, resourceId, createdAt) VALUES ('p', 'CACHE', 'r-ai-cache', ?)",
      now,
    );
    const key = await keyWith(["deploy:production"]);
    const res = await upload(key, "dep-prod", bundle([{ type: "kv", bindingName: "CACHE" }]));
    expect([res.status, res.body.error]).toEqual([409, "binding_conflict"]);
    expect(res.body.message).toContain("CACHE is attached to an ai resource");
    const [dep] = await f.sql<{ status: string }>(
      "SELECT status FROM deployment WHERE id = 'dep-prod'",
    );
    expect(dep.status).toBe("queued");
    expect(deploy).not.toHaveBeenCalled();
    expect(
      await f.sql(
        "SELECT kind, cfResourceId, cfResourceType FROM resource WHERE id = 'r-ai-cache'",
      ),
    ).toEqual([{ kind: "ai", cfResourceId: null, cfResourceType: "ai" }]);

    // And the reverse: a kv resource attached under a name declared as ai.
    await f.sql(
      `INSERT INTO resource (id, teamId, kind, name, cfResourceId, cfResourceType, status, createdAt, updatedAt)
       VALUES ('r-kv-unprov', ?, 'cache', 'c', NULL, NULL, 'active', ?, ?)`,
      owner.orgId,
      now,
      now,
    );
    await f.sql(
      "INSERT INTO project_resource_binding (projectId, bindingName, resourceId, createdAt) VALUES ('p', 'MODEL', 'r-kv-unprov', ?)",
      now,
    );
    const res2 = await upload(key, "dep-prod", bundle([{ type: "ai", bindingName: "MODEL" }]));
    expect([res2.status, res2.body.message]).toEqual([
      409,
      expect.stringContaining("MODEL is attached to a cache resource"),
    ]);
    expect(
      await f.sql("SELECT cfResourceId, cfResourceType FROM resource WHERE id = 'r-kv-unprov'"),
    ).toEqual([{ cfResourceId: null, cfResourceType: null }]);
  });

  it("refuses a provisioned resource declared as another type (it used to be bound as its own type)", async () => {
    // DB is a provisioned D1. Declared as kv, binding the D1 under a name the
    // worker reads as a KV namespace would break the worker at runtime.
    const key = await keyWith(["deploy:production"]);
    const res = await upload(key, "dep-prod", bundle([{ type: "kv", bindingName: "DB" }]));
    expect([res.status, res.body.message]).toEqual([
      409,
      expect.stringContaining(
        "DB is attached to a database resource, but the bundle declares it as kv",
      ),
    ]);
    expect(deploy).not.toHaveBeenCalled();
  });

  it("refuses one binding name declared with two types", async () => {
    const key = await keyWith(["deploy:production"]);
    const before = await projectState();
    const res = await upload(
      key,
      "dep-prod",
      bundle([
        { type: "kv", bindingName: "DATA" },
        { type: "r2", bindingName: "DATA" },
      ]),
    );
    expect([res.status, res.body.message]).toEqual([
      409,
      expect.stringContaining("DATA is declared as both kv and r2"),
    ]);
    expect(await projectState()).toEqual(before);
  });

  it("skips a binding type deploys do not bind, without recording it", async () => {
    // A framework adapter's IMAGES binding: neither a resource row nor a
    // binding the worker would get, and a preview is not refused for it.
    const key = await keyWith(["deploy:preview"]);
    const before = await projectState();
    const res = await upload(
      key,
      "dep-prev",
      bundle([
        { type: "d1", bindingName: "DB" },
        { type: "images", bindingName: "IMAGES" },
      ]),
    );
    expect(res.status).toBe(202);
    expect(await projectState()).toEqual(before);
    const [dep] = await f.sql<{ status: string }>(
      "SELECT status FROM deployment WHERE id = 'dep-prev'",
    );
    expect(dep.status).toBe("active");
    const input = (deploy.mock.calls.at(-1) as unknown[])[4] as {
      bindings: { type: string; name: string }[];
    };
    expect(input.bindings.some((b) => b.name === "IMAGES")).toBe(false);
  });

  describe("a non-queue resource attached as QUEUE", () => {
    async function attachAsQueue(
      id: string,
      kind: string,
      cfResourceId: string | null,
      cfType: string,
    ) {
      const now = Date.now();
      await f.sql(
        `INSERT INTO resource (id, teamId, kind, name, cfResourceId, cfResourceType, status, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        id,
        owner.orgId,
        kind,
        id,
        cfResourceId,
        cfType,
        now,
        now,
      );
      await f.sql(
        "INSERT INTO project_resource_binding (projectId, bindingName, resourceId, createdAt) VALUES ('p', 'QUEUE', ?, ?)",
        id,
        now,
      );
    }
    const resourceRow = (id: string) =>
      f.sql("SELECT kind, cfResourceId, cfResourceType FROM resource WHERE id = ?", id);

    it("is refused for a preview that wants a queue", async () => {
      await attachAsQueue("r-ai-q", "ai", null, "ai");
      const res = await upload(
        await keyWith(["deploy:preview"]),
        "dep-prev",
        bundle([{ type: "d1", bindingName: "DB" }], true),
      );
      expect([res.status, res.body.error]).toEqual([409, "binding_conflict"]);
      expect(await resourceRow("r-ai-q")).toEqual([
        { kind: "ai", cfResourceId: null, cfResourceType: "ai" },
      ]);
    });

    for (const [label, id, kind, cfId, cfType] of [
      ["an AI resource (no Cloudflare id)", "r-ai-q", "ai", null, "ai"],
      ["a provisioned KV", "r-kv-q", "cache", "cf-kv-real", "kv"],
    ] as const) {
      it(`refuses a production deploy that wants a queue, leaving ${label} untouched`, async () => {
        await attachAsQueue(id, kind, cfId, cfType);
        const before = await resourceRow(id);
        const res = await upload(
          await keyWith(["deploy:production"]),
          "dep-prod",
          bundle([{ type: "d1", bindingName: "DB" }], true),
        );
        expect([res.status, res.body.message]).toEqual([
          409,
          expect.stringContaining("QUEUE is attached to a"),
        ]);
        expect(await resourceRow(id)).toEqual(before);
        expect(deploy).not.toHaveBeenCalled();
      });

      it(`fails the job too, if ${label} is attached as QUEUE after the upload check, before creating anything`, async () => {
        // CACHE is new: the job must refuse before provisioning it, not
        // after, when it reaches the queue.
        await f.env.ASSETS.put(
          "bundles/dep-prod.json",
          JSON.stringify(
            bundle(
              [
                { type: "d1", bindingName: "DB" },
                { type: "kv", bindingName: "CACHE" },
              ],
              true,
            ),
          ),
        );
        await attachAsQueue(id, kind, cfId, cfType);
        const before = await resourceRow(id);
        const stateBefore = await projectState();
        await runDeployJob(f.env, {
          deploymentId: "dep-prod",
          projectId: "p",
          projectSlug: "site",
          teamId: owner.orgId,
          teamSlug: owner.orgSlug,
          plan: "free",
          branch: "main",
          productionBranch: "main",
        });
        const [dep] = await f.sql<{ status: string; errorMessage: string | null }>(
          "SELECT status, errorMessage FROM deployment WHERE id = 'dep-prod'",
        );
        expect([dep.status, dep.errorMessage]).toEqual([
          "failed",
          expect.stringContaining("QUEUE is attached to a"),
        ]);
        expect(await resourceRow(id)).toEqual(before);
        expect(await projectState()).toEqual(stateBefore);
        expect(deploy).not.toHaveBeenCalled();
      });

      it(`ensureQueue itself refuses ${label} attached as QUEUE`, async () => {
        // Its own guard, for a QUEUE attached after ensureProjectBindings ran.
        await attachAsQueue(id, kind, cfId, cfType);
        const before = await resourceRow(id);
        await expect(ensureQueue(f.env, "p", owner.orgId)).rejects.toThrow(
          "QUEUE is attached to a",
        );
        expect(await resourceRow(id)).toEqual(before);
      });
    }
  });

  it("deploys a project's second Workers AI deploy (it used to fail provisioning the AI row)", async () => {
    const key = await keyWith(["deploy:production"]);
    const first = await upload(key, "dep-prod", bundle([{ type: "ai", bindingName: "AI" }]));
    expect(first.status).toBe(202);
    await f.sql(
      `INSERT INTO deployment (id, projectId, version, status, branch, triggerType, createdAt, updatedAt)
       VALUES ('dep-prod-2', 'p', 2, 'queued', 'main', 'cli', ?, ?)`,
      Date.now(),
      Date.now(),
    );
    const second = await upload(key, "dep-prod-2", bundle([{ type: "ai", bindingName: "AI" }]));
    expect(second.status).toBe(202);
    const rows = await f.sql<{ id: string; status: string; errorMessage: string | null }>(
      "SELECT id, status, errorMessage FROM deployment WHERE id IN ('dep-prod', 'dep-prod-2') ORDER BY id",
    );
    expect(rows).toEqual([
      { id: "dep-prod", status: "active", errorMessage: null },
      { id: "dep-prod-2", status: "active", errorMessage: null },
    ]);
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

  // The upload check runs before the job; the job runs later (queued, maybe
  // retried). A binding detached in between must not be re-created.
  describe("the deploy job enforces the same rule", () => {
    async function runJob(
      bindings: { type: string; bindingName: string }[],
      queue: boolean,
      mayAddBindings?: boolean,
    ) {
      await f.env.ASSETS.put("bundles/dep-prev.json", JSON.stringify(bundle(bindings, queue)));
      await runDeployJob(f.env, {
        deploymentId: "dep-prev",
        projectId: "p",
        projectSlug: "site",
        teamId: owner.orgId,
        teamSlug: owner.orgSlug,
        plan: "free",
        branch: "feature",
        productionBranch: "main",
        ...(mayAddBindings === undefined ? {} : { mayAddBindings }),
      });
      const [dep] = await f.sql<{ status: string; errorMessage: string | null }>(
        "SELECT status, errorMessage FROM deployment WHERE id = 'dep-prev'",
      );
      return dep;
    }

    it("fails instead of re-creating a binding detached after the upload check", async () => {
      // Accepted at upload while DB was bound; detached before the job ran.
      await f.sql("DELETE FROM project_resource_binding WHERE bindingName = 'DB'");
      const before = await projectState();
      const dep = await runJob([{ type: "d1", bindingName: "DB" }], false, false);
      expect(dep.status).toBe("failed");
      expect(dep.errorMessage).toContain("cannot add DB");
      expect(await projectState()).toEqual(before);
      expect(deploy).not.toHaveBeenCalled();
    });

    it("fails, in either mode, a requirement whose type differs from the bound resource's", async () => {
      for (const mayAdd of [false, true]) {
        await f.sql("UPDATE deployment SET status = 'queued' WHERE id = 'dep-prev'");
        const before = await projectState();
        const dep = await runJob([{ type: "ai", bindingName: "DB" }], false, mayAdd);
        expect([dep.status, dep.errorMessage], String(mayAdd)).toEqual([
          "failed",
          expect.stringContaining("DB is attached to a database resource"),
        ]);
        expect(await projectState()).toEqual(before);
      }
      expect(deploy).not.toHaveBeenCalled();
    });

    it("fails instead of adding Workers AI under a new name", async () => {
      const dep = await runJob([{ type: "ai", bindingName: "MODEL" }], false, false);
      expect([dep.status, dep.errorMessage]).toEqual(["failed", expect.stringContaining("MODEL")]);
      expect(deploy).not.toHaveBeenCalled();
    });

    it("fails instead of creating the queue", async () => {
      const before = await projectState();
      const dep = await runJob([{ type: "d1", bindingName: "DB" }], true, false);
      expect([dep.status, dep.errorMessage]).toEqual(["failed", expect.stringContaining("QUEUE")]);
      expect(await projectState()).toEqual(before);
    });

    it("deploys with existing bindings when it may not add any", async () => {
      const dep = await runJob([{ type: "d1", bindingName: "DB" }], false, false);
      expect(dep.status).toBe("active");
      expect(deploy).toHaveBeenCalledTimes(1);
    });

    it("provisions as before for jobs that may add bindings, and for messages queued before the field existed", async () => {
      for (const mayAdd of [true, undefined]) {
        await f.sql("UPDATE deployment SET status = 'queued' WHERE id = 'dep-prev'");
        const dep = await runJob([{ type: "kv", bindingName: `CACHE_${mayAdd}` }], false, mayAdd);
        expect(dep.status, String(mayAdd)).toBe("active");
      }
      expect((await projectState()).bindings).toEqual(["CACHE_true", "CACHE_undefined", "DB"]);
    });

    it("hands the upload's decision to the queued job", async () => {
      const sent: { mayAddBindings?: boolean }[] = [];
      (f.env as { DEPLOY_JOBS?: unknown }).DEPLOY_JOBS = {
        send: async (msg: { mayAddBindings?: boolean }) => void sent.push(msg),
      };
      const existingOnly = bundle([{ type: "d1", bindingName: "DB" }]);
      const reset = () => f.sql("UPDATE deployment SET status = 'queued'");

      await upload(await keyWith(["deploy:preview"]), "dep-prev", existingOnly);
      await reset();
      await upload(await keyWith(["deploy:preview", "resource:write"]), "dep-prev", existingOnly);
      await reset();
      await upload(await keyWith(["deploy:production"]), "dep-prod", existingOnly);
      await reset();
      await upload(await f.legacyKey(owner.cookie), "dep-prev", existingOnly);

      expect(sent.map((m) => m.mayAddBindings)).toEqual([false, true, true, true]);
    });
  });

  describe("text bindings share the worker's env", () => {
    const setVar = (key: string, target: string) =>
      f.sql(
        "INSERT INTO environment_variable (projectId, key, target, encryptedValue) VALUES ('p', ?, ?, 'x')",
        key,
        target,
      );

    it("refuses an environment variable named like a binding, for the deploys whose target it applies to", async () => {
      // DB is the project's D1. A preview-only DB variable collides with
      // preview deploys and not with production ones.
      await setVar("DB", "preview");
      const key = await keyWith(["deploy:production", "deploy:preview"]);
      const before = await projectState();

      const preview = await upload(key, "dep-prev", bundle([{ type: "d1", bindingName: "DB" }]));
      expect([preview.status, preview.body.error]).toEqual([409, "binding_conflict"]);
      expect(preview.body.message).toContain(
        "DB is both a binding and a project environment variable",
      );
      expect(await f.env.ASSETS.get("bundles/dep-prev.json")).toBeNull();

      const production = await upload(key, "dep-prod", bundle([{ type: "d1", bindingName: "DB" }]));
      expect(production.status).toBe(202);
      expect(await projectState()).toEqual(before);
    });

    it("refuses an environment variable and a [vars] value of one name", async () => {
      await setVar("MODE", "all");
      const res = await upload(await keyWith(["deploy:production"]), "dep-prod", {
        ...bundle([{ type: "d1", bindingName: "DB" }]),
        vars: { MODE: "debug" },
      });
      expect([res.status, res.body.message]).toEqual([
        409,
        expect.stringContaining("MODE is both a project environment variable and a [vars] value"),
      ]);
      expect(deploy).not.toHaveBeenCalled();
    });

    it("refuses a [vars] the job would read differently, before staging", async () => {
      // A binding named "0" and vars: ["x"]: the job would bind the array
      // index as a name. Refused for its shape, for every caller.
      for (const vars of [["x"], "MODE", 42, null]) {
        const res = await upload(await keyWith(["deploy:production"]), "dep-prod", {
          ...bundle([{ type: "kv", bindingName: "0" }]),
          vars,
        });
        expect([res.status, res.body.error], JSON.stringify(vars)).toEqual([400, "validation"]);
      }
      expect(await f.env.ASSETS.get("bundles/dep-prod.json")).toBeNull();
      expect(deploy).not.toHaveBeenCalled();
    });

    it("deploys free names, each once", async () => {
      await setVar("API_KEY", "all");
      const res = await upload(await keyWith(["deploy:production"]), "dep-prod", {
        ...bundle([{ type: "d1", bindingName: "DB" }]),
        vars: { MODE: "debug" },
      });
      expect(res.status).toBe(202);
      const input = (deploy.mock.calls.at(-1) as unknown[])[4] as {
        bindings: { type: string; name: string }[];
      };
      const names = input.bindings.map((b) => b.name);
      expect(names).toEqual(expect.arrayContaining(["DB", "API_KEY", "MODE"]));
      expect(new Set(names).size).toBe(names.length);
    });

    it("fails a job whose bundle's [vars] take a binding's name (a GitHub push skips the upload check)", async () => {
      await f.env.ASSETS.put(
        "bundles/dep-prod.json",
        JSON.stringify({
          ...bundle([
            { type: "d1", bindingName: "DB" },
            { type: "kv", bindingName: "CACHE" },
          ]),
          vars: { DB: "postgres://elsewhere" },
        }),
      );
      const before = await projectState();
      await runDeployJob(f.env, {
        deploymentId: "dep-prod",
        projectId: "p",
        projectSlug: "site",
        teamId: owner.orgId,
        teamSlug: owner.orgSlug,
        plan: "free",
        branch: "main",
        productionBranch: "main",
      });
      const [dep] = await f.sql<{ status: string; errorMessage: string | null }>(
        "SELECT status, errorMessage FROM deployment WHERE id = 'dep-prod'",
      );
      expect([dep.status, dep.errorMessage]).toEqual([
        "failed",
        expect.stringContaining("DB is both a binding and a [vars] value"),
      ]);
      expect(await projectState()).toEqual(before);
      expect(deploy).not.toHaveBeenCalled();
    });

    it("fails the job, before creating anything, when a variable takes a binding's name after the upload check", async () => {
      // Accepted at upload; the variable is set before the queued job runs.
      await f.env.ASSETS.put(
        "bundles/dep-prod.json",
        JSON.stringify(
          bundle([
            { type: "d1", bindingName: "DB" },
            { type: "kv", bindingName: "CACHE" },
          ]),
        ),
      );
      await setVar("CACHE", "production");
      const before = await projectState();
      await runDeployJob(f.env, {
        deploymentId: "dep-prod",
        projectId: "p",
        projectSlug: "site",
        teamId: owner.orgId,
        teamSlug: owner.orgSlug,
        plan: "free",
        branch: "main",
        productionBranch: "main",
      });
      const [dep] = await f.sql<{ status: string; errorMessage: string | null }>(
        "SELECT status, errorMessage FROM deployment WHERE id = 'dep-prod'",
      );
      expect([dep.status, dep.errorMessage]).toEqual([
        "failed",
        expect.stringContaining("CACHE is both a binding and a project environment variable"),
      ]);
      // CACHE was not created.
      expect(await projectState()).toEqual(before);
      expect(deploy).not.toHaveBeenCalled();
    });

    // A worker-mode deploy adds the static-assets binding ASSETS, unless
    // another binding holds the name first: then env.ASSETS.fetch() breaks.
    describe("ASSETS", () => {
      const workerBundle = (bindings: { type: string; bindingName: string }[]) => {
        const base = bundle(bindings);
        return {
          ...base,
          manifest: { ...base.manifest, hasWorker: true, renderMode: "worker" },
          serverFiles: { "worker.js": btoa("export default { fetch() {} }") },
        };
      };

      it("refuses an environment variable named ASSETS in worker mode, before staging", async () => {
        await setVar("ASSETS", "all");
        const before = await projectState();
        const res = await upload(
          await keyWith(["deploy:production"]),
          "dep-prod",
          workerBundle([{ type: "d1", bindingName: "DB" }]),
        );
        expect([res.status, res.body.error]).toEqual([409, "binding_conflict"]);
        expect(res.body.message).toContain("static-assets binding in worker mode");
        expect(await f.env.ASSETS.get("bundles/dep-prod.json")).toBeNull();
        expect(await projectState()).toEqual(before);
        expect(deploy).not.toHaveBeenCalled();
      });

      it("accepts the same variable in spa mode, where ASSETS is the app's own name", async () => {
        await setVar("ASSETS", "all");
        const res = await upload(
          await keyWith(["deploy:production"]),
          "dep-prod",
          bundle([{ type: "d1", bindingName: "DB" }]),
        );
        expect(res.status).toBe(202);
        const input = (deploy.mock.calls.at(-1) as unknown[])[4] as {
          renderMode: string;
          bindings: { type: string; name: string }[];
        };
        expect(input.renderMode).toBe("spa");
        expect(input.bindings.filter((b) => b.name === "ASSETS")).toEqual([
          expect.objectContaining({ type: "secret_text", name: "ASSETS" }),
        ]);
      });

      it("fails a worker-mode job whose [vars] declare ASSETS (a GitHub push skips the upload check)", async () => {
        await f.env.ASSETS.put(
          "bundles/dep-prod.json",
          JSON.stringify({
            ...workerBundle([{ type: "kv", bindingName: "CACHE" }]),
            vars: { ASSETS: "/static" },
          }),
        );
        const before = await projectState();
        await runDeployJob(f.env, {
          deploymentId: "dep-prod",
          projectId: "p",
          projectSlug: "site",
          teamId: owner.orgId,
          teamSlug: owner.orgSlug,
          plan: "free",
          branch: "main",
          productionBranch: "main",
        });
        const [dep] = await f.sql<{ status: string; errorMessage: string | null }>(
          "SELECT status, errorMessage FROM deployment WHERE id = 'dep-prod'",
        );
        expect([dep.status, dep.errorMessage]).toEqual([
          "failed",
          expect.stringContaining("ASSETS is the worker's static-assets binding in worker mode"),
        ]);
        // CACHE was not created.
        expect(await projectState()).toEqual(before);
        expect(deploy).not.toHaveBeenCalled();
      });
    });
  });

  it("treats a bound name whose resource row is gone as unbound, as the deploy would", async () => {
    f.t.db.db.exec("PRAGMA foreign_keys = OFF; DELETE FROM resource WHERE id = 'r-db'");
    const key = await keyWith(["deploy:preview"]);
    const res = await upload(key, "dep-prev", bundle([{ type: "d1", bindingName: "DB" }]));
    expect([res.status, res.body.newBindings]).toEqual([403, ["DB"]]);
  });
});
