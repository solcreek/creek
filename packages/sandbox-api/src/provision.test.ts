import { describe, test, expect, vi, beforeEach } from "vitest";

// Provisioning calls the Cloudflare API; stand in for it so the test is about
// which bindings a sandbox gets.
vi.mock("@solcreek/deploy-core", () => ({
  createD1Database: vi.fn(async (_env: unknown, name: string) => `d1:${name}`),
  createR2Bucket: vi.fn(async () => undefined),
  createKVNamespace: vi.fn(async (_env: unknown, name: string) => `kv:${name}`),
}));

import { createD1Database } from "@solcreek/deploy-core";
import { provisionSandboxResources } from "./provision.js";
import type { Env } from "./types.js";

const env = {} as Env;

beforeEach(() => vi.clearAllMocks());

describe("provisionSandboxResources: binding names match production (#61)", () => {
  test("a database is bound as DATABASE and as the DB alias, one database", async () => {
    const { bindings, provisioned } = await provisionSandboxResources(env, "abc123", [
      { type: "d1", bindingName: "DATABASE" },
    ]);

    expect(bindings).toEqual([
      { type: "d1", name: "DATABASE", id: "d1:sbox-abc123-database" },
      { type: "d1", name: "DB", id: "d1:sbox-abc123-database" },
    ]);
    // The alias is a second name for the same database, not a second database:
    // one resource created, one recorded for cleanup.
    expect(createD1Database).toHaveBeenCalledTimes(1);
    expect(provisioned.d1).toEqual([
      { binding: "DATABASE", name: "sbox-abc123-database", id: "d1:sbox-abc123-database" },
    ]);
  });

  test("a cache is bound as CACHE and as the KV alias", async () => {
    const { bindings } = await provisionSandboxResources(env, "abc123", [
      { type: "kv", bindingName: "CACHE" },
    ]);
    expect(bindings.map((b) => b.name)).toEqual(["CACHE", "KV"]);
    expect(bindings[1]).toMatchObject({
      type: "kv_namespace",
      namespace_id: "kv:sbox-abc123-cache",
    });
  });

  test("a binding the project already calls DB is not shadowed by the alias", async () => {
    const { bindings } = await provisionSandboxResources(env, "abc123", [
      { type: "d1", bindingName: "DATABASE" },
      { type: "r2", bindingName: "DB" },
    ]);
    expect(bindings.filter((b) => b.name === "DB")).toEqual([
      { type: "r2_bucket", name: "DB", bucket_name: "sbox-abc123-db" },
    ]);
  });
});

describe("provisionSandboxResources: DATABASE and DB declared together", () => {
  test("share one database, in either order", async () => {
    for (const names of [
      ["DATABASE", "DB"],
      ["DB", "DATABASE"],
    ]) {
      vi.clearAllMocks();
      const { bindings, provisioned } = await provisionSandboxResources(
        env,
        "abc123",
        names.map((bindingName) => ({ type: "d1", bindingName })),
      );
      const id = `d1:sbox-abc123-${names[0].toLowerCase()}`;
      expect(bindings).toEqual([
        { type: "d1", name: names[0], id },
        { type: "d1", name: names[1], id },
      ]);
      expect(createD1Database).toHaveBeenCalledTimes(1);
      expect(provisioned.d1).toHaveLength(1);
    }
  });

  test("does not share a partner's resource of another type", async () => {
    const { bindings } = await provisionSandboxResources(env, "abc123", [
      { type: "kv", bindingName: "DB" },
      { type: "d1", bindingName: "DATABASE" },
    ]);
    expect(createD1Database).toHaveBeenCalledTimes(1);
    expect(bindings).toEqual([
      { type: "kv_namespace", name: "DB", namespace_id: "kv:sbox-abc123-db" },
      { type: "d1", name: "DATABASE", id: "d1:sbox-abc123-database" },
    ]);
  });

  test("CACHE and KV share one namespace", async () => {
    const { bindings, provisioned } = await provisionSandboxResources(env, "abc123", [
      { type: "kv", bindingName: "CACHE" },
      { type: "kv", bindingName: "KV" },
    ]);
    expect(bindings).toEqual([
      { type: "kv_namespace", name: "CACHE", namespace_id: "kv:sbox-abc123-cache" },
      { type: "kv_namespace", name: "KV", namespace_id: "kv:sbox-abc123-cache" },
    ]);
    expect(provisioned.kv).toHaveLength(1);
  });
});

describe("provisionSandboxResources: one name, one binding", () => {
  test("refuses a name declared with two types, before creating anything", async () => {
    await expect(
      provisionSandboxResources(env, "abc123", [
        { type: "d1", bindingName: "DATABASE" },
        { type: "r2", bindingName: "IMAGES" },
        { type: "images", bindingName: "IMAGES" },
      ]),
    ).rejects.toThrow("IMAGES is declared as both r2 and images");
    expect(createD1Database).not.toHaveBeenCalled();
  });

  test("binds a requirement declared twice with one type once", async () => {
    const { bindings } = await provisionSandboxResources(env, "abc123", [
      { type: "images", bindingName: "IMAGES" },
      { type: "images", bindingName: "IMAGES" },
    ]);
    expect(bindings).toEqual([{ type: "images", name: "IMAGES" }]);
  });
});
