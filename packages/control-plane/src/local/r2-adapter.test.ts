import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { LocalR2Bucket } from "./r2-adapter";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("LocalR2Bucket", () => {
  let root: string;
  let bucket: LocalR2Bucket;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "r2-test-"));
    bucket = new LocalR2Bucket(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("put/get", () => {
    it("stores and retrieves a string", async () => {
      await bucket.put("hello.txt", "world");
      const obj = await bucket.get("hello.txt");
      expect(obj).not.toBeNull();
      expect(await obj!.text()).toBe("world");
    });

    it("stores and retrieves binary data", async () => {
      const data = new Uint8Array([0, 1, 2, 255]);
      await bucket.put("bin", data);
      const obj = await bucket.get("bin");
      const buf = new Uint8Array(await obj!.arrayBuffer());
      expect(buf).toEqual(data);
    });

    it("stores JSON and retrieves via json()", async () => {
      await bucket.put("data.json", JSON.stringify({ a: 1 }));
      const obj = await bucket.get("data.json");
      const data = await obj!.json();
      expect(data).toEqual({ a: 1 });
    });

    it("returns null for missing key", async () => {
      expect(await bucket.get("nonexistent")).toBeNull();
    });

    it("overwrites existing key", async () => {
      await bucket.put("key", "old");
      await bucket.put("key", "new");
      const obj = await bucket.get("key");
      expect(await obj!.text()).toBe("new");
    });

    it("sets size and key on returned object", async () => {
      await bucket.put("sized", "12345");
      const obj = await bucket.get("sized");
      expect(obj!.key).toBe("sized");
      expect(obj!.size).toBe(5);
    });
  });

  describe("nested keys", () => {
    it("creates subdirectories for nested keys", async () => {
      await bucket.put("logs/team-a/project-1/log.json", '{"line":1}');
      const obj = await bucket.get("logs/team-a/project-1/log.json");
      expect(obj).not.toBeNull();
      expect(await obj!.text()).toBe('{"line":1}');
    });

    it("handles deeply nested paths", async () => {
      await bucket.put("a/b/c/d/e/f.txt", "deep");
      expect(await (await bucket.get("a/b/c/d/e/f.txt"))!.text()).toBe("deep");
    });
  });

  describe("delete", () => {
    it("removes a key", async () => {
      await bucket.put("rm-me", "gone");
      await bucket.delete("rm-me");
      expect(await bucket.get("rm-me")).toBeNull();
    });

    it("no-ops for missing key", async () => {
      await bucket.delete("ghost");
    });

    it("deletes multiple keys at once", async () => {
      await bucket.put("a", "1");
      await bucket.put("b", "2");
      await bucket.put("c", "3");
      await bucket.delete(["a", "b"]);
      expect(await bucket.get("a")).toBeNull();
      expect(await bucket.get("b")).toBeNull();
      expect(await bucket.get("c")).not.toBeNull();
    });
  });

  describe("list", () => {
    it("lists all objects", async () => {
      await bucket.put("a.txt", "1");
      await bucket.put("b.txt", "2");
      const result = await bucket.list();
      expect(result.objects).toHaveLength(2);
      expect(result.truncated).toBe(false);
    });

    it("filters by prefix", async () => {
      await bucket.put("logs/a.json", "1");
      await bucket.put("logs/b.json", "2");
      await bucket.put("builds/c.json", "3");
      const result = await bucket.list({ prefix: "logs/" });
      expect(result.objects).toHaveLength(2);
      expect(result.objects.every((o) => o.key.startsWith("logs/"))).toBe(true);
    });

    it("respects limit", async () => {
      await bucket.put("a", "1");
      await bucket.put("b", "2");
      await bucket.put("c", "3");
      const result = await bucket.list({ limit: 2 });
      expect(result.objects).toHaveLength(2);
      expect(result.truncated).toBe(true);
    });

    it("returns empty for no matches", async () => {
      const result = await bucket.list({ prefix: "nonexistent/" });
      expect(result.objects).toHaveLength(0);
    });

    it("includes size in listed objects", async () => {
      await bucket.put("sized", "hello");
      const result = await bucket.list();
      expect(result.objects[0].size).toBe(5);
    });
  });

  describe("head", () => {
    it("returns metadata without body", async () => {
      await bucket.put("meta", "content");
      const obj = await bucket.head("meta");
      expect(obj).not.toBeNull();
      expect(obj!.key).toBe("meta");
      expect(obj!.size).toBe(7);
    });

    it("returns null for missing key", async () => {
      expect(await bucket.head("ghost")).toBeNull();
    });
  });

  describe("body as ReadableStream", () => {
    it("provides a readable stream", async () => {
      await bucket.put("stream", "stream-data");
      const obj = await bucket.get("stream");
      const reader = obj!.body.getReader();
      const { value, done } = await reader.read();
      expect(done).toBe(false);
      expect(new TextDecoder().decode(value)).toBe("stream-data");
      const next = await reader.read();
      expect(next.done).toBe(true);
    });
  });

  describe("control-plane usage patterns", () => {
    it("asset upload + fetch workflow", async () => {
      const manifest = JSON.stringify({ routes: ["/"], assets: ["index.html"] });
      await bucket.put("deployments/proj-1/v3/manifest.json", manifest);
      await bucket.put("deployments/proj-1/v3/index.html", "<h1>Hello</h1>");

      const m = await bucket.get("deployments/proj-1/v3/manifest.json");
      expect(await m!.json()).toEqual({ routes: ["/"], assets: ["index.html"] });

      const html = await bucket.get("deployments/proj-1/v3/index.html");
      expect(await html!.text()).toBe("<h1>Hello</h1>");
    });

    it("build log archive", async () => {
      await bucket.put("builds/team-a/proj-1/build-abc.log", "step 1\nstep 2\ndone");
      const log = await bucket.get("builds/team-a/proj-1/build-abc.log");
      expect((await log!.text()).split("\n")).toHaveLength(3);
    });

    it("list deployments by prefix", async () => {
      await bucket.put("deployments/proj-1/v1/manifest.json", "{}");
      await bucket.put("deployments/proj-1/v2/manifest.json", "{}");
      await bucket.put("deployments/proj-2/v1/manifest.json", "{}");

      const result = await bucket.list({ prefix: "deployments/proj-1/" });
      expect(result.objects).toHaveLength(2);
    });
  });
});
