import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { createLocalTestEnv, type LocalTestEnv } from "./test-env.js";

describe("createLocalTestEnv", () => {
  let testEnv: LocalTestEnv;

  beforeEach(() => {
    testEnv = createLocalTestEnv();
  });

  afterEach(() => {
    testEnv.cleanup();
  });

  it("applies migrations and creates tables", async () => {
    const result = await testEnv.env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).all();
    const tables = (result as any).results.map((r: any) => r.name) as string[];
    expect(tables).toContain("project");
    expect(tables).toContain("deployment");
    expect(tables).toContain("user");
    expect(tables).toContain("session");
  });

  it("D1 adapter: insert + query round-trip", async () => {
    await testEnv.env.DB.prepare(
      "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))",
    ).bind("u1", "Alice", "alice@test.com", 0).run();

    const row = await testEnv.env.DB.prepare(
      "SELECT * FROM user WHERE id = ?",
    ).bind("u1").first();

    expect(row).not.toBeNull();
    expect((row as any).name).toBe("Alice");
    expect((row as any).email).toBe("alice@test.com");
  });

  it("D1 adapter: batch executes atomically", async () => {
    const db = testEnv.env.DB;
    await db.batch([
      db.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))").bind("u1", "Alice", "a@t.com", 0),
      db.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))").bind("u2", "Bob", "b@t.com", 0),
    ] as any);

    const result = await db.prepare("SELECT COUNT(*) as cnt FROM user").first();
    expect((result as any).cnt).toBe(2);
  });

  it("R2 adapter: put + get", async () => {
    const r2 = testEnv.env.ASSETS;
    await r2.put("test/hello.txt", "world");
    const obj = await r2.get("test/hello.txt");
    expect(obj).not.toBeNull();
    expect(await (obj as any).text()).toBe("world");
  });

  it("KV adapter: put + get with TTL", async () => {
    const kv = testEnv.env.BUILD_STATUS;
    await kv.put("key1", "value1");
    expect(await kv.get("key1")).toBe("value1");

    await kv.put("temp", "gone", { expirationTtl: 0 });
    await new Promise((r) => setTimeout(r, 5));
    expect(await kv.get("temp")).toBeNull();
  });

  it("KV adapter: list with prefix", async () => {
    const kv = testEnv.env.BUILD_STATUS;
    await kv.put("build:a", "1");
    await kv.put("build:b", "2");
    await kv.put("rate:x", "3");
    const result = await kv.list({ prefix: "build:" });
    expect(result.keys).toHaveLength(2);
  });

  it("env has all required string fields", () => {
    const env = testEnv.env;
    expect(env.CREEK_DOMAIN).toBe("bycreek.com");
    expect(env.BETTER_AUTH_SECRET).toBeTruthy();
    expect(env.BETTER_AUTH_URL).toBeTruthy();
    expect(env.INTERNAL_SECRET).toBeTruthy();
  });
});

describe("createLocalTestEnv with Hono app", () => {
  let testEnv: LocalTestEnv;

  beforeEach(() => {
    testEnv = createLocalTestEnv();
  });

  afterEach(() => {
    testEnv.cleanup();
  });

  it("serves a Hono route with real D1 queries", async () => {
    const app = new Hono<{ Bindings: any }>();

    app.get("/users", async (c) => {
      const result = await c.env.DB.prepare("SELECT COUNT(*) as cnt FROM user").first();
      return c.json({ count: result.cnt });
    });

    app.post("/users", async (c) => {
      const body = await c.req.json();
      await c.env.DB.prepare(
        "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))",
      ).bind(body.id, body.name, body.email, 0).run();
      return c.json({ ok: true }, 201);
    });

    // Create a user
    const createRes = await app.request("/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "u1", name: "Test", email: "test@t.com" }),
    }, testEnv.env);
    expect(createRes.status).toBe(201);

    // Query it back
    const listRes = await app.request("/users", {}, testEnv.env);
    expect(listRes.status).toBe(200);
    const data = await listRes.json();
    expect(data.count).toBe(1);
  });
});
