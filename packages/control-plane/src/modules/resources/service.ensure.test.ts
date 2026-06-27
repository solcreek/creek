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
