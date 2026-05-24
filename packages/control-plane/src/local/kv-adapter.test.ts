import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { LocalKVNamespace } from "./kv-adapter";

describe("LocalKVNamespace", () => {
  let db: Database;
  let kv: LocalKVNamespace;

  beforeEach(() => {
    db = new Database(":memory:");
    kv = new LocalKVNamespace(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("get/put", () => {
    it("returns null for missing key", async () => {
      expect(await kv.get("missing")).toBeNull();
    });

    it("stores and retrieves a value", async () => {
      await kv.put("key1", "value1");
      expect(await kv.get("key1")).toBe("value1");
    });

    it("overwrites existing value", async () => {
      await kv.put("key1", "old");
      await kv.put("key1", "new");
      expect(await kv.get("key1")).toBe("new");
    });

    it("stores JSON values", async () => {
      const data = { buildId: "abc", status: "building" };
      await kv.put("build:abc", JSON.stringify(data));
      const result = JSON.parse((await kv.get("build:abc"))!);
      expect(result.buildId).toBe("abc");
      expect(result.status).toBe("building");
    });
  });

  describe("TTL expiration", () => {
    it("returns value before expiration", async () => {
      await kv.put("temp", "alive", { expirationTtl: 3600 });
      expect(await kv.get("temp")).toBe("alive");
    });

    it("returns null after expiration", async () => {
      // Set TTL to 0 seconds (already expired)
      await kv.put("expired", "gone", { expirationTtl: 0 });
      // Wait 1ms to ensure Date.now() > expires_at
      await new Promise((r) => setTimeout(r, 5));
      expect(await kv.get("expired")).toBeNull();
    });

    it("lazily deletes expired entries on get", async () => {
      await kv.put("expired", "gone", { expirationTtl: 0 });
      await new Promise((r) => setTimeout(r, 5));
      await kv.get("expired");
      // Verify row is actually deleted from DB
      const row = db.query("SELECT * FROM kv_store WHERE key = ?").get("expired");
      expect(row).toBeNull();
    });

    it("value without TTL never expires", async () => {
      await kv.put("permanent", "forever");
      const row = db.query("SELECT expires_at FROM kv_store WHERE key = ?").get("permanent") as any;
      expect(row.expires_at).toBeNull();
      expect(await kv.get("permanent")).toBe("forever");
    });
  });

  describe("delete", () => {
    it("removes an existing key", async () => {
      await kv.put("key1", "val");
      await kv.delete("key1");
      expect(await kv.get("key1")).toBeNull();
    });

    it("no-ops for missing key", async () => {
      await kv.delete("ghost");
      // Should not throw
    });
  });

  describe("list", () => {
    it("returns empty list when no keys", async () => {
      const result = await kv.list();
      expect(result.keys).toHaveLength(0);
      expect(result.list_complete).toBe(true);
    });

    it("lists all keys", async () => {
      await kv.put("a", "1");
      await kv.put("b", "2");
      await kv.put("c", "3");
      const result = await kv.list();
      expect(result.keys).toHaveLength(3);
      expect(result.keys.map((k) => k.name)).toEqual(["a", "b", "c"]);
    });

    it("filters by prefix", async () => {
      await kv.put("build:abc", "1");
      await kv.put("build:def", "2");
      await kv.put("rate:xyz", "3");
      const result = await kv.list({ prefix: "build:" });
      expect(result.keys).toHaveLength(2);
      expect(result.keys.map((k) => k.name)).toEqual(["build:abc", "build:def"]);
    });

    it("respects limit", async () => {
      await kv.put("a", "1");
      await kv.put("b", "2");
      await kv.put("c", "3");
      const result = await kv.list({ limit: 2 });
      expect(result.keys).toHaveLength(2);
      expect(result.list_complete).toBe(false);
    });

    it("excludes expired entries", async () => {
      await kv.put("alive", "yes");
      await kv.put("dead", "no", { expirationTtl: 0 });
      await new Promise((r) => setTimeout(r, 5));
      const result = await kv.list();
      expect(result.keys).toHaveLength(1);
      expect(result.keys[0].name).toBe("alive");
    });

    it("includes expiration in key metadata", async () => {
      await kv.put("temp", "val", { expirationTtl: 3600 });
      const result = await kv.list();
      expect(result.keys[0].expiration).toBeDefined();
      expect(result.keys[0].expiration).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });
  });

  describe("getWithMetadata", () => {
    it("returns value with null metadata", async () => {
      await kv.put("key1", "val1");
      const result = await kv.getWithMetadata("key1");
      expect(result.value).toBe("val1");
      expect(result.metadata).toBeNull();
    });

    it("returns null for missing key", async () => {
      const result = await kv.getWithMetadata("ghost");
      expect(result.value).toBeNull();
      expect(result.metadata).toBeNull();
    });
  });

  describe("control-plane usage patterns", () => {
    it("build status workflow: put → get → list", async () => {
      // Simulate web-deploy build tracking
      await kv.put("build:test-123", JSON.stringify({
        buildId: "test-123",
        status: "building",
        startedAt: Date.now(),
      }));
      await kv.put("build:test-456", JSON.stringify({
        buildId: "test-456",
        status: "complete",
      }));

      // Get single build
      const build = JSON.parse((await kv.get("build:test-123"))!);
      expect(build.status).toBe("building");

      // List all builds
      const list = await kv.list({ prefix: "build:" });
      expect(list.keys).toHaveLength(2);
    });

    it("rate limiting with TTL", async () => {
      const rateLimitKey = "rate:ip:127.0.0.1";
      const current = parseInt((await kv.get(rateLimitKey)) || "0");
      expect(current).toBe(0);

      await kv.put(rateLimitKey, String(current + 1), { expirationTtl: 3600 });
      expect(await kv.get(rateLimitKey)).toBe("1");

      // Increment
      const next = parseInt((await kv.get(rateLimitKey)) || "0");
      await kv.put(rateLimitKey, String(next + 1), { expirationTtl: 3600 });
      expect(await kv.get(rateLimitKey)).toBe("2");
    });
  });
});
