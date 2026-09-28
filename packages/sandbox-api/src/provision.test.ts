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
