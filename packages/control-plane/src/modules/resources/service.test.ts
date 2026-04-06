import { describe, test, expect } from "vitest";
import { buildBindings, ensureResources, type ProjectResource } from "./service.js";
import { BINDING_NAMES, INTERNAL_VARS, PROVISIONABLE_RESOURCES } from "@solcreek/sdk";
import { createMockD1, createTestEnv, type MockD1 } from "../../test-helpers.js";

const PROJECT_ID = "aaaa-bbbb-cccc";

function makeResource(
  type: "d1" | "r2" | "kv",
  overrides?: Partial<ProjectResource>,
): ProjectResource {
  return {
    projectId: PROJECT_ID,
    resourceType: type,
    cfResourceId: `cf-${type}-id`,
    cfResourceName: `creek-aaaabbbb`,
    status: "active",
    ...overrides,
  };
}

const defaultOptions = {
  projectSlug: "my-app",
  realtimeUrl: "https://realtime.bycreek.com",
  needsAi: false,
};

// --- buildBindings ---

describe("buildBindings", () => {
  test("builds D1 binding with correct name", () => {
    const bindings = buildBindings(
      [makeResource("d1")],
      PROJECT_ID,
      [],
      defaultOptions,
    );
    const d1 = bindings.find((b) => b.name === BINDING_NAMES.d1);
    expect(d1).toBeDefined();
    expect(d1!.type).toBe("d1");
    expect(d1!.id).toBe("cf-d1-id");
  });

  test("builds R2 binding with correct name", () => {
    const bindings = buildBindings(
      [makeResource("r2")],
      PROJECT_ID,
      [],
      defaultOptions,
    );
    const r2 = bindings.find((b) => b.name === BINDING_NAMES.r2);
    expect(r2).toBeDefined();
    expect(r2!.type).toBe("r2_bucket");
    expect(r2!.bucket_name).toBe("creek-aaaabbbb");
  });

  test("builds KV binding with correct name", () => {
    const bindings = buildBindings(
      [makeResource("kv")],
      PROJECT_ID,
      [],
      defaultOptions,
    );
    const kv = bindings.find((b) => b.name === BINDING_NAMES.kv);
    expect(kv).toBeDefined();
    expect(kv!.type).toBe("kv_namespace");
    expect(kv!.namespace_id).toBe("cf-kv-id");
  });

  test("includes AI binding when needsAi is true", () => {
    const bindings = buildBindings([], PROJECT_ID, [], {
      ...defaultOptions,
      needsAi: true,
    });
    const ai = bindings.find((b) => b.name === BINDING_NAMES.ai);
    expect(ai).toBeDefined();
    expect(ai!.type).toBe("ai");
  });

  test("does not include AI binding when needsAi is false", () => {
    const bindings = buildBindings([], PROJECT_ID, [], defaultOptions);
    const ai = bindings.find((b) => b.name === BINDING_NAMES.ai);
    expect(ai).toBeUndefined();
  });

  test("includes internal vars", () => {
    const bindings = buildBindings([], PROJECT_ID, [], defaultOptions);
    const slug = bindings.find((b) => b.name === INTERNAL_VARS.projectSlug);
    const url = bindings.find((b) => b.name === INTERNAL_VARS.realtimeUrl);
    expect(slug).toBeDefined();
    expect(slug!.text).toBe("my-app");
    expect(url).toBeDefined();
    expect(url!.text).toBe("https://realtime.bycreek.com");
  });

  test("includes user env vars as secret_text", () => {
    const bindings = buildBindings(
      [],
      PROJECT_ID,
      [{ key: "DATABASE_URL", value: "postgres://..." }],
      defaultOptions,
    );
    const env = bindings.find((b) => b.name === "DATABASE_URL");
    expect(env).toBeDefined();
    expect(env!.type).toBe("secret_text");
    expect(env!.text).toBe("postgres://...");
  });
});

// --- Safety assertions ---

describe("buildBindings safety", () => {
  test("throws when resource belongs to different project", () => {
    const wrongResource = makeResource("d1", { projectId: "other-project" });
    expect(() =>
      buildBindings([wrongResource], PROJECT_ID, [], defaultOptions),
    ).toThrow(/Binding safety violation/);
  });

  test("throws when resource is not active", () => {
    const failedResource = makeResource("d1", { status: "failed" });
    expect(() =>
      buildBindings([failedResource], PROJECT_ID, [], defaultOptions),
    ).toThrow(/expected 'active'/);
  });

  test("throws when resource is deleting", () => {
    const deletingResource = makeResource("d1", { status: "deleting" });
    expect(() =>
      buildBindings([deletingResource], PROJECT_ID, [], defaultOptions),
    ).toThrow(/expected 'active'/);
  });
});

// --- ensureResources SQL correctness ---

describe("ensureResources", () => {
  let db: MockD1;
  let env: ReturnType<typeof createTestEnv>;

  test("INSERT includes createdAt (prevents NOT NULL violation)", async () => {
    db = createMockD1();
    env = createTestEnv(db);
    // No existing resources
    db.seedAll("SELECT projectId, resourceType", ["proj-1"], { results: [] });

    // ensureResources will try to INSERT then call CF API (which will fail in test)
    // We just want to verify the INSERT SQL includes createdAt
    try {
      await ensureResources(env, "proj-1", { d1: true, r2: false, kv: false, ai: false });
    } catch {
      // CF API call will fail — that's fine, we're testing the SQL
    }

    const executed = db.getExecuted();
    const insertQuery = executed.find(q => q.sql.includes("INSERT INTO project_resource"));
    expect(insertQuery).toBeDefined();
    expect(insertQuery!.sql).toContain("createdAt");
    // createdAt should be a timestamp (number)
    const createdAtArg = insertQuery!.args[insertQuery!.args.length - 1];
    expect(typeof createdAtArg).toBe("number");
    expect(createdAtArg).toBeGreaterThan(0);
  });

  test("skips already active resources", async () => {
    db = createMockD1();
    env = createTestEnv(db);
    // D1 already active
    db.seedAll("SELECT projectId, resourceType", ["proj-1"], {
      results: [{
        projectId: "proj-1",
        resourceType: "d1",
        cfResourceId: "existing-d1-id",
        cfResourceName: "creek-proj1",
        status: "active",
      }],
    });

    const results = await ensureResources(env, "proj-1", { d1: true, r2: false, kv: false, ai: false });
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("active");
    expect(results[0].cfResourceId).toBe("existing-d1-id");

    // Should NOT have any INSERT (resource already exists)
    const executed = db.getExecuted();
    const insertQuery = executed.find(q => q.sql.includes("INSERT INTO project_resource"));
    expect(insertQuery).toBeUndefined();
  });

  test("skips resource types not in requirements", async () => {
    db = createMockD1();
    env = createTestEnv(db);
    db.seedAll("SELECT projectId, resourceType", ["proj-1"], { results: [] });

    // Only request KV, not D1 or R2
    try {
      await ensureResources(env, "proj-1", { d1: false, r2: false, kv: true, ai: false });
    } catch {}

    const executed = db.getExecuted();
    const insertQueries = executed.filter(q => q.sql.includes("INSERT INTO project_resource"));
    // Should only INSERT for KV, not D1 or R2
    expect(insertQueries).toHaveLength(1);
    expect(insertQueries[0].args[1]).toBe("kv"); // resourceType = "kv"
  });
});

// --- buildBindings with name overrides ---

describe("buildBindings with bindingNameOverrides", () => {
  test("uses override names when provided", () => {
    const overrides = new Map([["d1", "MY_DB"], ["kv", "CACHE"]]);
    const bindings = buildBindings(
      [makeResource("d1"), makeResource("kv")],
      PROJECT_ID,
      [],
      { ...defaultOptions, bindingNameOverrides: overrides },
    );
    const d1 = bindings.find(b => b.type === "d1");
    const kv = bindings.find(b => b.type === "kv_namespace");
    expect(d1!.name).toBe("MY_DB");
    expect(kv!.name).toBe("CACHE");
  });

  test("falls back to canonical names without overrides", () => {
    const bindings = buildBindings(
      [makeResource("d1")],
      PROJECT_ID,
      [],
      defaultOptions,
    );
    const d1 = bindings.find(b => b.type === "d1");
    expect(d1!.name).toBe("DB");
  });

  test("AI uses override name when provided", () => {
    const overrides = new Map([["ai", "MY_AI"]]);
    const bindings = buildBindings(
      [],
      PROJECT_ID,
      [],
      { ...defaultOptions, needsAi: true, bindingNameOverrides: overrides },
    );
    const ai = bindings.find(b => b.type === "ai");
    expect(ai!.name).toBe("MY_AI");
  });
});

// --- Invariant: binding names match runtime expectations ---

describe("binding name invariants", () => {
  test("all provisionable resource types have binding names", () => {
    for (const type of PROVISIONABLE_RESOURCES) {
      expect(BINDING_NAMES[type]).toBeDefined();
      expect(typeof BINDING_NAMES[type]).toBe("string");
      expect(BINDING_NAMES[type].length).toBeGreaterThan(0);
    }
  });

  test("binding names match runtime conventions", () => {
    // These must match what packages/runtime/src/index.ts reads from env
    expect(BINDING_NAMES.d1).toBe("DB");
    expect(BINDING_NAMES.r2).toBe("STORAGE");
    expect(BINDING_NAMES.kv).toBe("KV");
    expect(BINDING_NAMES.ai).toBe("AI");
  });

  test("internal var names match runtime conventions", () => {
    // These must match what packages/runtime/src/index.ts reads from env
    expect(INTERNAL_VARS.projectSlug).toBe("CREEK_PROJECT_SLUG");
    expect(INTERNAL_VARS.realtimeUrl).toBe("CREEK_REALTIME_URL");
    expect(INTERNAL_VARS.realtimeSecret).toBe("CREEK_REALTIME_SECRET");
  });
});
