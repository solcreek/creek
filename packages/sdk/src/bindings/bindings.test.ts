import { describe, test, expect } from "vitest";
import {
  BINDING_NAMES,
  DEPRECATED_BINDING_ALIASES,
  INTERNAL_VARS,
  PROVISIONABLE_RESOURCES,
  deprecatedAliasBindings,
} from "./index.js";

describe("BINDING_NAMES", () => {
  // The rule: the env-var name is the semantic config key uppercased.
  test("maps d1 -> DATABASE", () => {
    expect(BINDING_NAMES.d1).toBe("DATABASE");
  });

  test("maps r2 -> STORAGE", () => {
    expect(BINDING_NAMES.r2).toBe("STORAGE");
  });

  test("maps kv -> CACHE", () => {
    expect(BINDING_NAMES.kv).toBe("CACHE");
  });

  test("maps ai -> AI", () => {
    expect(BINDING_NAMES.ai).toBe("AI");
  });

  test("maps queue -> QUEUE", () => {
    expect(BINDING_NAMES.queue).toBe("QUEUE");
  });

  test("every name equals the semantic config key uppercased", () => {
    // This is the v2 invariant that makes binding names predictable.
    const expected: Record<string, string> = {
      d1: "DATABASE",
      kv: "CACHE",
      r2: "STORAGE",
      ai: "AI",
      queue: "QUEUE",
    };
    for (const [cfType, name] of Object.entries(expected)) {
      expect(BINDING_NAMES[cfType as keyof typeof BINDING_NAMES]).toBe(name);
    }
  });

  test("all provisionable resources have a binding name", () => {
    for (const type of PROVISIONABLE_RESOURCES) {
      expect(BINDING_NAMES[type]).toBeDefined();
      expect(typeof BINDING_NAMES[type]).toBe("string");
    }
  });
});

describe("DEPRECATED_BINDING_ALIASES", () => {
  test("aliases the two renamed bindings to their old CF-primitive names", () => {
    expect(DEPRECATED_BINDING_ALIASES.DATABASE).toBe("DB");
    expect(DEPRECATED_BINDING_ALIASES.CACHE).toBe("KV");
  });

  test("does not alias the already-aligned names", () => {
    expect(DEPRECATED_BINDING_ALIASES.STORAGE).toBeUndefined();
    expect(DEPRECATED_BINDING_ALIASES.AI).toBeUndefined();
    expect(DEPRECATED_BINDING_ALIASES.QUEUE).toBeUndefined();
  });
});

describe("INTERNAL_VARS", () => {
  test("has projectSlug", () => {
    expect(INTERNAL_VARS.projectSlug).toBe("CREEK_PROJECT_SLUG");
  });

  test("has realtimeUrl", () => {
    expect(INTERNAL_VARS.realtimeUrl).toBe("CREEK_REALTIME_URL");
  });

  test("has realtimeSecret", () => {
    expect(INTERNAL_VARS.realtimeSecret).toBe("CREEK_REALTIME_SECRET");
  });
});

describe("PROVISIONABLE_RESOURCES", () => {
  test("includes d1, r2, kv", () => {
    expect(PROVISIONABLE_RESOURCES).toContain("d1");
    expect(PROVISIONABLE_RESOURCES).toContain("r2");
    expect(PROVISIONABLE_RESOURCES).toContain("kv");
  });

  test("does not include ai (ai is account-level)", () => {
    expect(PROVISIONABLE_RESOURCES).not.toContain("ai");
  });
});

describe("deprecatedAliasBindings", () => {
  test("adds DB for DATABASE and KV for CACHE, pointing at the same resource", () => {
    expect(
      deprecatedAliasBindings([
        { type: "d1", name: "DATABASE", id: "db-1" },
        { type: "kv_namespace", name: "CACHE", namespace_id: "kv-1" },
        { type: "r2_bucket", name: "STORAGE", bucket_name: "b" },
      ]),
    ).toEqual([
      { type: "d1", name: "DB", id: "db-1" },
      { type: "kv_namespace", name: "KV", namespace_id: "kv-1" },
    ]);
  });

  test("skips an alias whose name is already bound, so a user's own DB wins", () => {
    expect(
      deprecatedAliasBindings([
        { type: "d1", name: "DATABASE", id: "db-1" },
        { type: "r2_bucket", name: "DB", bucket_name: "mine" },
      ]),
    ).toEqual([]);
  });

  test("adds nothing for names without an alias", () => {
    expect(deprecatedAliasBindings([{ type: "r2_bucket", name: "STORAGE" }])).toEqual([]);
  });
});
