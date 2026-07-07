import { describe, test, expect } from "vitest";
import { ensureProjectBindings } from "./service.js";

type Row = {
  bindingName: string;
  resourceId: string;
  kind: string;
  cfResourceId: string | null;
  cfResourceType: string | null;
};

/**
 * Minimal D1 stub: the seed/merge path under test only issues the SELECT of
 * existing bindings (`.all()`). Tests are constructed so the requirements loop
 * never provisions (no `.run()` writes, no CF API), so those are inert no-ops.
 */
function envWithBindings(rows: Row[]): any {
  return {
    DB: {
      prepare() {
        return {
          bind() {
            return {
              all: async () => ({ results: rows }),
              first: async () => rows[0] ?? null,
              run: async () => ({}),
            };
          },
        };
      },
    },
  };
}

describe("ensureProjectBindings — server attachment merge", () => {
  test("a provisioned server attachment reaches the deploy even with empty requirements", async () => {
    // Emulates `creek cache attach --as=SESSIONS` then a deploy whose config
    // declares no bindings.
    const env = envWithBindings([
      { bindingName: "SESSIONS", resourceId: "res-1", kind: "cache", cfResourceId: "kv-123", cfResourceType: "kv" },
    ]);

    const result = await ensureProjectBindings(env, "proj-1", "team-1", []);

    expect(result.get("SESSIONS")).toEqual({
      bindingName: "SESSIONS",
      cfResourceId: "kv-123",
      cfType: "kv",
    });
  });

  test("an unprovisioned attachment (no cfResourceId) is not seeded", async () => {
    const env = envWithBindings([
      { bindingName: "DATA", resourceId: "res-2", kind: "cache", cfResourceId: null, cfResourceType: null },
    ]);

    const result = await ensureProjectBindings(env, "proj-1", "team-1", []);

    expect(result.has("DATA")).toBe(false);
  });

  test("skips a provisioned attachment whose CF type can't be determined", async () => {
    const env = envWithBindings([
      { bindingName: "WAT", resourceId: "res-w", kind: "mystery", cfResourceId: "x-1", cfResourceType: null },
    ]);

    const result = await ensureProjectBindings(env, "proj-1", "team-1", []);

    expect(result.has("WAT")).toBe(false);
  });

  test("derives cfType from kind when cfResourceType is missing", async () => {
    const env = envWithBindings([
      { bindingName: "SESSIONS", resourceId: "res-3", kind: "cache", cfResourceId: "kv-9", cfResourceType: null },
    ]);

    const result = await ensureProjectBindings(env, "proj-1", "team-1", []);

    // KIND_TO_CF maps "cache" -> "kv"
    expect(result.get("SESSIONS")?.cfType).toBe("kv");
  });

  test("does not seed a queue attachment (buildBindings emits only d1/r2/kv)", async () => {
    const env = envWithBindings([
      { bindingName: "QUEUE", resourceId: "res-q", kind: "queue", cfResourceId: "q-1", cfResourceType: "queue" },
    ]);

    const result = await ensureProjectBindings(env, "proj-1", "team-1", []);

    expect(result.has("QUEUE")).toBe(false);
  });

  test("an existing provisioned binding trusts its kind over a divergent requirement type", async () => {
    const env = envWithBindings([
      { bindingName: "CACHE", resourceId: "res-c", kind: "cache", cfResourceId: "kv-x", cfResourceType: null },
    ]);

    // The bundle wrongly claims CACHE is a d1 — the resource's kind (cache -> kv) wins.
    const result = await ensureProjectBindings(env, "proj-1", "team-1", [
      { type: "d1", bindingName: "CACHE" },
    ]);

    expect(result.get("CACHE")?.cfType).toBe("kv");
  });

  test("adopts a legacy DB alias's resource under the DATABASE primary (no new empty D1)", async () => {
    // The project was first deployed under the old name: only DB is bound, and
    // it holds the data. A deploy now requires the new primary DATABASE. The
    // primary must adopt the existing DB resource, NOT provision a fresh empty
    // one (which would split the app across two databases). If the fix didn't
    // fire, the auto-create path would call the CF API and this test would fail.
    const env = envWithBindings([
      { bindingName: "DB", resourceId: "res-db", kind: "database", cfResourceId: "d1-full", cfResourceType: "d1" },
    ]);

    const result = await ensureProjectBindings(env, "proj-1", "team-1", [
      { type: "d1", bindingName: "DATABASE" },
    ]);

    expect(result.get("DATABASE")).toEqual({
      bindingName: "DATABASE",
      cfResourceId: "d1-full",
      cfType: "d1",
    });
  });

  test("adopts a legacy KV alias's resource under the CACHE primary", async () => {
    const env = envWithBindings([
      { bindingName: "KV", resourceId: "res-kv", kind: "cache", cfResourceId: "kv-full", cfResourceType: "kv" },
    ]);

    const result = await ensureProjectBindings(env, "proj-1", "team-1", [
      { type: "kv", bindingName: "CACHE" },
    ]);

    expect(result.get("CACHE")).toEqual({
      bindingName: "CACHE",
      cfResourceId: "kv-full",
      cfType: "kv",
    });
  });

  test("a config requirement and a separate attachment both resolve", async () => {
    const env = envWithBindings([
      { bindingName: "SESSIONS", resourceId: "res-a", kind: "cache", cfResourceId: "kv-aaa", cfResourceType: "kv" },
      { bindingName: "CACHE", resourceId: "res-b", kind: "cache", cfResourceId: "kv-bbb", cfResourceType: "kv" },
    ]);

    const result = await ensureProjectBindings(env, "proj-1", "team-1", [
      { type: "kv", bindingName: "CACHE" },
    ]);

    expect(result.get("SESSIONS")?.cfResourceId).toBe("kv-aaa");
    expect(result.get("CACHE")?.cfResourceId).toBe("kv-bbb");
  });
});
