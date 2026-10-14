import { describe, it, expect, vi, afterEach } from "vitest";
import { createFixture, type Fixture } from "../tenant/scoped-key-fixture.js";
import {
  BindingConflictError,
  BindingNotAllowedError,
  buildBindings,
  ensureProjectBindings,
  ensureQueue,
  planBindings,
  planDeployBindings,
  resourceBindingType,
} from "./service.js";
import { createQueue, provisionCFResource } from "./cloudflare.js";

vi.mock("./cloudflare.js", async (orig) => ({
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
  createQueue: vi.fn(async (_env: unknown, name: string) => `cf-queue-${name}`),
}));

const row = (bindingName: string, kind: string, cfResourceType: string | null = null) => ({
  bindingName,
  kind,
  cfResourceType,
});

describe("resourceBindingType", () => {
  it.each([
    ["database", "d1", "d1"],
    ["database", null, "d1"],
    ["storage", null, "r2"],
    ["cache", null, "kv"],
    ["ai", null, "ai"],
    ["ai", "ai", "ai"],
    ["queue", "queue", "queue"],
    ["mystery", "kv", "kv"],
    ["mystery", null, null],
    ["cache", "d1", null],
    ["ai", "d1", null],
    ["database", "queue", null],
  ] as const)("%s / %s binds as %s", (kind, cfResourceType, expected) => {
    expect(resourceBindingType({ kind, cfResourceType })).toBe(expected);
  });
});

describe("planBindings", () => {
  const db = row("DB", "database", "d1");
  const model = row("MODEL", "ai", "ai");

  it.each([
    ["nothing declared", [db], [], false, [], 0],
    ["an existing name of the same type", [db], [{ type: "d1", bindingName: "DB" }], false, [], 0],
    ["a new name", [db], [{ type: "kv", bindingName: "CACHE" }], false, ["CACHE"], 0],
    ["the queue when unbound", [db], [], true, ["QUEUE"], 0],
    ["not the queue when bound", [db, row("QUEUE", "queue", "queue")], [], true, [], 0],
    ["AI under its default name", [db], [{ type: "ai", bindingName: "AI" }], false, ["AI"], 0],
    ["AI under a custom name", [db], [{ type: "ai", bindingName: "MODEL" }], false, ["MODEL"], 0],
    [
      "nothing for AI bound under its name",
      [model],
      [{ type: "ai", bindingName: "MODEL" }],
      false,
      [],
      0,
    ],
    [
      "AI under a new name beside AI bound under another",
      [model],
      [{ type: "ai", bindingName: "AI" }],
      false,
      ["AI"],
      0,
    ],
    [
      "the same requirement twice, once",
      [],
      [
        { type: "kv", bindingName: "C" },
        { type: "kv", bindingName: "C" },
      ],
      false,
      ["C"],
      0,
    ],
    [
      "nothing for an unsupported type",
      [db],
      [{ type: "images", bindingName: "IMAGES" }],
      false,
      [],
      0,
    ],
    // Conflicts
    ["AI declared on a bound database", [db], [{ type: "ai", bindingName: "DB" }], false, [], 1],
    [
      "a database declared on bound AI",
      [model],
      [{ type: "d1", bindingName: "MODEL" }],
      false,
      [],
      1,
    ],
    [
      "a database declared on a bound cache",
      [row("CACHE", "cache")],
      [{ type: "d1", bindingName: "CACHE" }],
      false,
      [],
      1,
    ],
    [
      "a resource whose kind and type disagree",
      [row("DATA", "cache", "d1")],
      [{ type: "d1", bindingName: "DATA" }],
      false,
      [],
      1,
    ],
    [
      "one name with two types",
      [],
      [
        { type: "kv", bindingName: "X" },
        { type: "d1", bindingName: "X" },
      ],
      false,
      ["X"],
      1,
    ],
    [
      "a requirement named QUEUE beside the queue",
      [],
      [{ type: "kv", bindingName: "QUEUE" }],
      true,
      ["QUEUE"],
      1,
    ],
    ["the queue when QUEUE holds another kind", [db, row("QUEUE", "ai", "ai")], [], true, [], 1],
    [
      "an unsupported type and a supported one under one name",
      [],
      [
        { type: "images", bindingName: "DATA" },
        { type: "d1", bindingName: "DATA" },
      ],
      false,
      [],
      1,
    ],
    [
      "an unsupported type named QUEUE beside the queue",
      [],
      [{ type: "images", bindingName: "QUEUE" }],
      true,
      [],
      1,
    ],
    [
      "nothing for an unsupported type named QUEUE without a queue",
      [],
      [{ type: "images", bindingName: "QUEUE" }],
      false,
      [],
      0,
    ],
    [
      "an unsupported type under a name the project has attached",
      [row("IMAGES", "storage", "r2")],
      [{ type: "images", bindingName: "IMAGES" }],
      false,
      [],
      1,
    ],
    [
      "an unsupported type under the alias of a declared DATABASE",
      [],
      [
        { type: "d1", bindingName: "DATABASE" },
        { type: "images", bindingName: "DB" },
      ],
      false,
      ["DATABASE"],
      1,
    ],
    [
      "an unsupported type under the alias of an attached CACHE",
      [row("CACHE", "cache", "kv")],
      [{ type: "images", bindingName: "KV" }],
      false,
      [],
      1,
    ],
    [
      "nothing for an unsupported type under DB when DATABASE is not a D1",
      [],
      [
        { type: "r2", bindingName: "DATABASE" },
        { type: "images", bindingName: "DB" },
      ],
      false,
      ["DATABASE"],
      0,
    ],
    [
      "nothing for an unsupported type under a free name",
      [db],
      [{ type: "worker_loader", bindingName: "LOADER" }],
      false,
      [],
      0,
    ],
  ] as const)("%s", (_label, existing, requirements, wantsQueue, added, conflicts) => {
    const plan = planBindings(existing, requirements, wantsQueue);
    expect(plan.added.sort()).toEqual([...added].sort());
    expect(plan.conflicts).toHaveLength(conflicts);
  });

  it("reports what it skips", () => {
    const plan = planBindings([], [{ type: "images", bindingName: "IMAGES" }], false);
    expect(plan.unsupported).toEqual([{ type: "images", bindingName: "IMAGES" }]);
    expect(plan.requirements).toEqual([]);
  });
});

/** Deterministic PRNG (mulberry32) so a failure reproduces from its seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The upload check (planDeployBindings) and the job (ensureProjectBindings,
 * then ensureQueue) must agree on every project state and bundle, and the
 * worker must get what the bundle declared. Checked against what the job
 * observably does: the rows it writes and the bindings it emits.
 */
describe("upload check and deploy job agree", () => {
  let f: Fixture;
  afterEach(() => f?.cleanup());

  it("on 400 random project states and bundles", async () => {
    f = createFixture();
    const owner = await f.signUp("owner@example.com");
    const rand = rng(0x5eed);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
    const names = ["DB", "DATABASE", "CACHE", "KV", "STORAGE", "MODEL", "AI", "QUEUE"];
    // [kind, stored type, provisioned]. Some pairs disagree or store no
    // type; some D1/R2/KV rows are attached but not provisioned yet. An AI
    // row never has a Cloudflare id.
    const kinds = [
      ["database", "d1", true],
      ["cache", "kv", true],
      ["storage", "r2", true],
      ["database", null, false],
      ["cache", "kv", false],
      ["ai", "ai", false],
      ["ai", null, false],
      ["queue", "queue", true],
      ["cache", "d1", true],
    ] as const;
    const types = ["d1", "kv", "r2", "ai", "images"];

    const seen = {
      conflict: 0,
      refused: 0,
      added: 0,
      nothingAdded: 0,
      customAi: 0,
      queueAdded: 0,
      skipped: 0,
      provisionedAttached: 0,
      skippedName: 0,
    };
    for (let i = 0; i < 400; i++) {
      const projectId = `p${i}`;
      const now = Date.now();
      await f.sql(
        "INSERT INTO project (id, slug, organizationId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)",
        projectId,
        `s${i}`,
        owner.orgId,
        now,
        now,
      );
      for (const name of names) {
        if (rand() < 0.35) {
          const [kind, cf, provisioned] = pick(kinds);
          const id = `${projectId}-${name}`;
          await f.sql(
            `INSERT INTO resource (id, teamId, kind, name, cfResourceId, cfResourceType, status, createdAt, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
            id,
            owner.orgId,
            kind,
            id,
            provisioned ? `cf-${id}` : null,
            cf,
            now,
            now,
          );
          await f.sql(
            "INSERT INTO project_resource_binding (projectId, bindingName, resourceId, createdAt) VALUES (?, ?, ?, ?)",
            projectId,
            name,
            id,
            now,
          );
        }
      }
      const requirements = names
        .filter(() => rand() < 0.3)
        .map((bindingName) => ({ type: pick(types), bindingName }));
      const wantsQueue = rand() < 0.25;

      const label = `#${i} reqs=${JSON.stringify(requirements)} queue=${wantsQueue}`;
      const bindingRows = () =>
        f.sql<{ bindingName: string; resourceId: string }>(
          "SELECT bindingName, resourceId FROM project_resource_binding WHERE projectId = ? ORDER BY bindingName",
          projectId,
        );
      const plan = await planDeployBindings(f.env, projectId, requirements, wantsQueue);
      const resourceRows = () =>
        f.sql<{ id: string; cfResourceId: string | null }>(
          "SELECT id, kind, cfResourceId, cfResourceType FROM resource WHERE id LIKE ? ORDER BY id",
          `${projectId}-%`,
        );
      // Everything a refused job must leave as it was: binding rows, resource
      // rows (any new one would be named by UUID, so count all of them), and
      // the Cloudflare calls that create something.
      const world = async () => ({
        bindings: await bindingRows(),
        resources: await resourceRows(),
        resourceCount: (await f.sql("SELECT id FROM resource")).length,
        cfCreates:
          vi.mocked(provisionCFResource).mock.calls.length +
          vi.mocked(createQueue).mock.calls.length,
      });
      const before = await bindingRows();
      const worldBefore = await world();
      const runJob = async (mayAddBindings: boolean) => {
        const resolved = await ensureProjectBindings(f.env, projectId, owner.orgId, requirements, {
          mayAddBindings,
          wantsQueue,
        });
        const queue = wantsQueue
          ? await ensureQueue(f.env, projectId, owner.orgId, { mayAddBindings })
          : undefined;
        return { resolved, queue };
      };

      // 1. A conflict refuses the job in either mode, before any write.
      if (plan.conflicts.length > 0) {
        seen.conflict++;
        for (const mayAddBindings of [false, true]) {
          await expect(runJob(mayAddBindings), label).rejects.toThrow(BindingConflictError);
        }
        expect(await world(), label).toEqual(worldBefore);
        continue;
      }

      // 2. Restricted, the job refuses exactly when the check predicts an
      //    addition, and then writes nothing.
      let refused = false;
      try {
        await runJob(false);
      } catch (err) {
        if (!(err instanceof BindingNotAllowedError)) throw err;
        refused = true;
      }
      expect(refused, `${label} added=${plan.added}`).toBe(plan.added.length > 0);
      if (refused) {
        expect(await world(), label).toEqual(worldBefore);
        seen.refused++;
      } else {
        // Allowed: no binding and no resource added. Provisioning a resource
        // someone already attached is allowed (it is bound already).
        const after = await world();
        expect(after.bindings, label).toEqual(worldBefore.bindings);
        expect(after.resourceCount, label).toBe(worldBefore.resourceCount);
      }

      // 3. Unrestricted, the names it binds are exactly the predicted ones,
      //    existing bindings keep their resources, and the worker gets every
      //    supported requirement under its declared name and type.
      const { resolved, queue } = await runJob(true);
      const after = await bindingRows();
      const inserted = after
        .map((r) => r.bindingName)
        .filter((n) => !before.some((b) => b.bindingName === n));
      expect(inserted.sort(), label).toEqual([...plan.added].sort());
      for (const b of before) {
        expect(after.find((a) => a.bindingName === b.bindingName)?.resourceId, label).toBe(
          b.resourceId,
        );
      }
      const emitted = buildBindings(resolved, [], {
        projectSlug: "s",
        projectId,
        realtimeUrl: "https://realtime.example",
        queueName: queue?.cfResourceName,
      });
      const wfpType = { d1: "d1", r2: "r2_bucket", kv: "kv_namespace", ai: "ai" } as const;
      for (const req of plan.requirements) {
        expect(
          emitted.some((b) => b.name === req.bindingName && b.type === wfpType[req.type]),
          `${label} missing ${req.bindingName} as ${req.type}`,
        ).toBe(true);
      }
      expect(emitted.filter((b) => b.name === "QUEUE").length, label).toBeLessThanOrEqual(1);
      expect(
        emitted.some((b) => b.type === "queue"),
        label,
      ).toBe(wantsQueue);
      // A requirement of an unsupported type is neither recorded nor bound,
      // and nothing else reaches the worker under its name: no attachment,
      // alias or queue (those are conflicts, refused above).
      for (const skipped of plan.unsupported) {
        expect(inserted, label).not.toContain(skipped.bindingName);
        expect(
          emitted.filter((b) => b.name === skipped.bindingName),
          `${label} ${skipped.bindingName} emitted`,
        ).toEqual([]);
        seen.skippedName++;
      }

      const resourcesAfter = await resourceRows();
      if (
        worldBefore.resources.some(
          (r) => !r.cfResourceId && resourcesAfter.find((a) => a.id === r.id)?.cfResourceId,
        )
      ) {
        seen.provisionedAttached++;
      }
      if (plan.added.length > 0) seen.added++;
      else seen.nothingAdded++;
      if (plan.requirements.some((r) => r.type === "ai" && r.bindingName !== "AI")) seen.customAi++;
      if (plan.added.includes("QUEUE")) seen.queueAdded++;
      if (plan.unsupported.length > 0) seen.skipped++;
    }
    for (const [kind, count] of Object.entries(seen)) expect(count, kind).toBeGreaterThan(0);
  });
});
