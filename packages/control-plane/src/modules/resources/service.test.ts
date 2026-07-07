import { describe, test, expect } from "vitest";
import { buildBindings } from "./service.js";

type Resolved = { bindingName: string; cfResourceId: string; cfType: string };

function resolved(entries: Resolved[]): Map<string, Resolved> {
  return new Map(entries.map((e) => [e.bindingName, e]));
}

const baseOptions = {
  projectSlug: "app",
  projectId: "proj-1",
  realtimeUrl: "https://realtime.example",
  needsAi: false,
};

describe("buildBindings — deprecated aliases", () => {
  test("binds DATABASE under both DATABASE and the deprecated DB alias", () => {
    const bindings = buildBindings(
      resolved([{ bindingName: "DATABASE", cfResourceId: "d1-id", cfType: "d1" }]),
      [],
      baseOptions,
    );
    const d1 = bindings.filter((b) => b.type === "d1");
    expect(d1).toEqual([
      { type: "d1", name: "DATABASE", id: "d1-id" },
      { type: "d1", name: "DB", id: "d1-id" },
    ]);
  });

  test("binds CACHE under both CACHE and the deprecated KV alias, same namespace", () => {
    const bindings = buildBindings(
      resolved([{ bindingName: "CACHE", cfResourceId: "kv-id", cfType: "kv" }]),
      [],
      baseOptions,
    );
    const kv = bindings.filter((b) => b.type === "kv_namespace");
    expect(kv).toEqual([
      { type: "kv_namespace", name: "CACHE", namespace_id: "kv-id" },
      { type: "kv_namespace", name: "KV", namespace_id: "kv-id" },
    ]);
  });

  test("STORAGE has no alias (already aligned)", () => {
    const bindings = buildBindings(
      resolved([{ bindingName: "STORAGE", cfResourceId: "r2-id", cfType: "r2" }]),
      [],
      baseOptions,
    );
    const r2 = bindings.filter((b) => b.type === "r2_bucket");
    expect(r2).toEqual([
      { type: "r2_bucket", name: "STORAGE", bucket_name: "r2-id" },
    ]);
  });

  test("a user-named custom binding gets no alias", () => {
    const bindings = buildBindings(
      resolved([{ bindingName: "SESSIONS", cfResourceId: "kv-id", cfType: "kv" }]),
      [],
      baseOptions,
    );
    const kv = bindings.filter((b) => b.type === "kv_namespace");
    expect(kv).toEqual([
      { type: "kv_namespace", name: "SESSIONS", namespace_id: "kv-id" },
    ]);
  });

  test("an alias yields to a primary binding of the same name (no duplicate env name)", () => {
    // Defensive: buildBindings emits whatever resolvedBindings it's given. A
    // split state (DATABASE + DB bound to different resources) should no longer
    // arise — ensureProjectBindings now adopts an existing DB under DATABASE
    // instead of provisioning a second empty D1 (see service.ensure.test.ts).
    // But if it ever did, buildBindings must still emit DB once without a crash.
    const bindings = buildBindings(
      resolved([
        { bindingName: "DATABASE", cfResourceId: "d1-new", cfType: "d1" },
        { bindingName: "DB", cfResourceId: "d1-legacy", cfType: "d1" },
      ]),
      [],
      baseOptions,
    );
    const d1 = bindings.filter((b) => b.type === "d1");
    expect(d1).toEqual([
      { type: "d1", name: "DATABASE", id: "d1-new" },
      { type: "d1", name: "DB", id: "d1-legacy" },
    ]);
  });
});
