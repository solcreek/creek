import { describe, test, expect, vi, afterEach } from "vitest";
import {
  createD1Database,
  getD1DatabaseByName,
  deleteD1Database,
  createR2Bucket,
  r2BucketExists,
  deleteR2Bucket,
  createKVNamespace,
  getKVNamespaceByTitle,
  deleteKVNamespace,
} from "./resources.js";
import type { DeployEnv } from "./types.js";

const env: DeployEnv = {
  CLOUDFLARE_API_TOKEN: "tok",
  CLOUDFLARE_ACCOUNT_ID: "acct-123",
  DISPATCH_NAMESPACE: "ns",
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockCfSuccess(result: unknown) {
  globalThis.fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ success: true, result })),
  );
}

function mockCfError() {
  globalThis.fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ success: false, errors: [{ message: "fail" }] })),
  );
}

// --- D1 ---

describe("D1 database operations", () => {
  test("createD1Database returns UUID", async () => {
    mockCfSuccess({ uuid: "d1-uuid-123" });
    const id = await createD1Database(env, "my-db");
    expect(id).toBe("d1-uuid-123");

    const call = (globalThis.fetch as any).mock.calls[0];
    expect(call[0]).toContain("/acct-123/d1/database");
    expect(JSON.parse(call[1].body).name).toBe("my-db");
  });

  test("getD1DatabaseByName returns UUID when found", async () => {
    mockCfSuccess([{ name: "my-db", uuid: "d1-found" }]);
    const id = await getD1DatabaseByName(env, "my-db");
    expect(id).toBe("d1-found");
  });

  test("getD1DatabaseByName returns null when not found", async () => {
    mockCfSuccess([]);
    const id = await getD1DatabaseByName(env, "nope");
    expect(id).toBeNull();
  });

  test("getD1DatabaseByName returns null on API error", async () => {
    mockCfError();
    const id = await getD1DatabaseByName(env, "nope");
    expect(id).toBeNull();
  });

  test("deleteD1Database calls correct endpoint", async () => {
    mockCfSuccess(null);
    await deleteD1Database(env, "d1-uuid");
    const call = (globalThis.fetch as any).mock.calls[0];
    expect(call[0]).toContain("/d1/database/d1-uuid");
    expect(call[1].method).toBe("DELETE");
  });
});

// --- R2 ---

describe("R2 bucket operations", () => {
  test("createR2Bucket sends name + locationHint", async () => {
    mockCfSuccess(null);
    await createR2Bucket(env, "my-bucket");
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.name).toBe("my-bucket");
    expect(body.locationHint).toBe("apac");
  });

  test("createR2Bucket accepts custom locationHint", async () => {
    mockCfSuccess(null);
    await createR2Bucket(env, "eu-bucket", "weur");
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.locationHint).toBe("weur");
  });

  test("r2BucketExists returns true when exists", async () => {
    mockCfSuccess({ name: "my-bucket" });
    expect(await r2BucketExists(env, "my-bucket")).toBe(true);
  });

  test("r2BucketExists returns false on error", async () => {
    mockCfError();
    expect(await r2BucketExists(env, "nope")).toBe(false);
  });

  test("deleteR2Bucket calls correct endpoint", async () => {
    mockCfSuccess(null);
    await deleteR2Bucket(env, "my-bucket");
    const call = (globalThis.fetch as any).mock.calls[0];
    expect(call[0]).toContain("/r2/buckets/my-bucket");
  });
});

// --- KV ---

describe("KV namespace operations", () => {
  test("createKVNamespace returns namespace ID", async () => {
    mockCfSuccess({ id: "kv-ns-123" });
    const id = await createKVNamespace(env, "my-kv");
    expect(id).toBe("kv-ns-123");

    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.title).toBe("my-kv");
  });

  test("getKVNamespaceByTitle returns ID when found", async () => {
    mockCfSuccess([{ title: "my-kv", id: "kv-found" }]);
    const id = await getKVNamespaceByTitle(env, "my-kv");
    expect(id).toBe("kv-found");
  });

  test("getKVNamespaceByTitle returns null when not found", async () => {
    mockCfSuccess([]);
    const id = await getKVNamespaceByTitle(env, "nope");
    expect(id).toBeNull();
  });

  test("deleteKVNamespace calls correct endpoint", async () => {
    mockCfSuccess(null);
    await deleteKVNamespace(env, "kv-ns-123");
    const call = (globalThis.fetch as any).mock.calls[0];
    expect(call[0]).toContain("/kv/namespaces/kv-ns-123");
    expect(call[1].method).toBe("DELETE");
  });
});
