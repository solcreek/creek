import { describe, it, expect, vi, afterEach } from "vitest";
import { createFixture, type Fixture } from "../tenant/scoped-key-fixture.js";
import {
  BindingNotAllowedError,
  bindingsADeployWouldAdd,
  bindingsAdded,
  ensureProjectBindings,
} from "./service.js";

vi.mock("./cloudflare.js", async (orig) => ({
  ...(await orig<object>()),
  findExistingCFResource: vi.fn(async () => null),
  provisionCFResource: vi.fn(
    async (_e: unknown, type: string, name: string) => `cf-${type}-${name}`,
  ),
}));

const row = (bindingName: string, kind: string, cfResourceType: string | null = null) => ({
  bindingName,
  kind,
  cfResourceType,
});

describe("bindingsAdded", () => {
  const db = row("DB", "database", "d1");

  it.each([
    ["nothing declared", [db], [], false, []],
    ["an existing name", [db], [{ type: "d1", bindingName: "DB" }], false, []],
    ["a new name", [db], [{ type: "kv", bindingName: "CACHE" }], false, ["CACHE"]],
    ["the queue when unbound", [db], [], true, ["QUEUE"]],
    ["not the queue when bound", [db, row("QUEUE", "queue", "queue")], [], true, []],
    ["AI under a borrowed bound name", [db], [{ type: "ai", bindingName: "DB" }], false, ["AI"]],
    ["AI under its own new name, once", [db], [{ type: "ai", bindingName: "AI" }], false, ["AI"]],
    ["AI under a custom new name", [db], [{ type: "ai", bindingName: "MODEL" }], false, ["MODEL"]],
    [
      "nothing for AI the project has under a custom name",
      [db, row("MODEL", "ai", "ai")],
      [{ type: "ai", bindingName: "MODEL" }],
      false,
      [],
    ],
    [
      "nothing for a borrowed name when the project has AI",
      [db, row("MODEL", "ai", "ai")],
      [{ type: "ai", bindingName: "DB" }],
      false,
      [],
    ],
    [
      "an unknown type under a new name",
      [db],
      [{ type: "images", bindingName: "IMAGES" }],
      false,
      ["IMAGES"],
    ],
  ] as const)("%s", (_label, existing, requirements, wantsQueue, expected) => {
    expect(bindingsAdded(existing, requirements, wantsQueue).sort()).toEqual([...expected].sort());
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
 * The upload check (bindingsADeployWouldAdd) and the job
 * (ensureProjectBindings with mayAddBindings=false) must agree on every
 * project state and bundle: the check says "adds" exactly when the job
 * refuses, and when it says "adds nothing" the job writes nothing.
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
    const kinds = [
      ["database", "d1"],
      ["cache", "kv"],
      ["storage", "r2"],
      ["ai", "ai"],
    ] as const;
    const types = ["d1", "kv", "r2", "ai"];

    // Each class of case the decision has to get right, counted so a seed
    // that stops producing one fails loudly instead of passing vacuously.
    const seen = { borrowedAi: 0, newAiName: 0, existingAi: 0, newName: 0, nothingAdded: 0 };
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
      const boundAi = new Set<string>();
      for (const name of names) {
        if (rand() < 0.35) {
          const [kind, cf] = pick(kinds);
          const id = `${projectId}-${name}`;
          // An AI row has no Cloudflare id; d1/r2/kv rows are provisioned.
          await f.sql(
            `INSERT INTO resource (id, teamId, kind, name, cfResourceId, cfResourceType, status, createdAt, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
            id,
            owner.orgId,
            kind,
            id,
            kind === "ai" ? null : `cf-${id}`,
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
          if (kind === "ai") boundAi.add(name);
        }
      }
      const requirements = names
        .filter(() => rand() < 0.3)
        // Skip a requirement naming a bound AI row: ensureProjectBindings
        // tries to provision it and fails on its own (a separate bug), which
        // would read as a refusal here.
        .filter((n) => !boundAi.has(n))
        .map((bindingName) => ({ type: pick(types), bindingName })) as {
        type: "d1" | "kv" | "r2" | "ai";
        bindingName: string;
      }[];

      const label = `#${i} reqs=${JSON.stringify(requirements)}`;
      const bindingNames = async () =>
        (
          await f.sql<{ bindingName: string }>(
            "SELECT bindingName FROM project_resource_binding WHERE projectId = ?",
            projectId,
          )
        ).map((r) => r.bindingName);
      const predicted = await bindingsADeployWouldAdd(f.env, projectId, requirements, false);

      // 1. The job under mayAddBindings=false refuses exactly when the check
      //    predicts an addition, and then writes nothing.
      const before = await bindingNames();
      let refused = false;
      try {
        await ensureProjectBindings(f.env, projectId, owner.orgId, requirements, {
          mayAddBindings: false,
        });
      } catch (err) {
        if (!(err instanceof BindingNotAllowedError)) throw err;
        refused = true;
      }
      expect(refused, `${label} predicted=${predicted}`).toBe(predicted.length > 0);
      expect((await bindingNames()).sort(), label).toEqual([...before].sort());

      // 2. Independent oracle: what the unrestricted job actually does. The
      //    prediction must equal the binding names it inserts, plus AI when it
      //    turns Workers AI on (an ai requirement) without binding any AI
      //    resource and none was bound before.
      await ensureProjectBindings(f.env, projectId, owner.orgId, requirements);
      const inserted = (await bindingNames()).filter((n) => !before.includes(n));
      const hadAi = boundAi.size > 0;
      const aiTurnedOnUnbound =
        requirements.some((r) => r.type === "ai") &&
        !hadAi &&
        !requirements.some((r) => r.type === "ai" && inserted.includes(r.bindingName));
      const actual = [...inserted, ...(aiTurnedOnUnbound ? ["AI"] : [])];
      expect([...predicted].sort(), `${label} inserted=${inserted}`).toEqual(
        [...new Set(actual)].sort(),
      );

      if (aiTurnedOnUnbound) seen.borrowedAi++;
      if (requirements.some((r) => r.type === "ai" && inserted.includes(r.bindingName))) {
        seen.newAiName++;
      }
      if (hadAi && requirements.some((r) => r.type === "ai")) seen.existingAi++;
      if (inserted.length > 0) seen.newName++;
      if (predicted.length === 0) seen.nothingAdded++;
    }
    for (const [kind, count] of Object.entries(seen)) expect(count, kind).toBeGreaterThan(0);
  });
});
