import { describe, test, expect } from "vitest";
import { parseWranglerConfig } from "./wrangler.js";

describe("parseWranglerConfig — TOML", () => {
  test("parses basic worker config", () => {
    const config = parseWranglerConfig(
      `
name = "my-api"
main = "src/index.ts"
compatibility_date = "2025-03-14"
compatibility_flags = ["nodejs_compat"]
`,
      "toml",
    );
    expect(config.name).toBe("my-api");
    expect(config.main).toBe("src/index.ts");
    expect(config.compatibility_date).toBe("2025-03-14");
    expect(config.compatibility_flags).toEqual(["nodejs_compat"]);
  });

  test("parses D1 bindings", () => {
    const config = parseWranglerConfig(
      `
name = "app"
main = "src/index.ts"

[[d1_databases]]
binding = "DB"
database_name = "my-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
`,
      "toml",
    );
    expect(config.d1_databases).toHaveLength(1);
    expect(config.d1_databases![0].binding).toBe("DB");
    expect(config.d1_databases![0].database_id).toBe("xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx");
  });

  test("parses multiple D1 bindings", () => {
    const config = parseWranglerConfig(
      `
name = "app"
main = "src/index.ts"

[[d1_databases]]
binding = "DB"
database_name = "main"
database_id = "aaa"

[[d1_databases]]
binding = "ANALYTICS_DB"
database_name = "analytics"
database_id = "bbb"
`,
      "toml",
    );
    expect(config.d1_databases).toHaveLength(2);
    expect(config.d1_databases![0].binding).toBe("DB");
    expect(config.d1_databases![1].binding).toBe("ANALYTICS_DB");
  });

  test("parses KV + R2 bindings", () => {
    const config = parseWranglerConfig(
      `
name = "app"
main = "src/index.ts"

[[kv_namespaces]]
binding = "CACHE"
id = "xxx"

[[r2_buckets]]
binding = "UPLOADS"
bucket_name = "my-uploads"
`,
      "toml",
    );
    expect(config.kv_namespaces![0].binding).toBe("CACHE");
    expect(config.r2_buckets![0].binding).toBe("UPLOADS");
  });

  test("parses AI binding", () => {
    const config = parseWranglerConfig(
      `
name = "ai-app"
main = "src/index.ts"

[ai]
binding = "AI"
`,
      "toml",
    );
    expect(config.ai).toBeDefined();
  });

  test("parses vars", () => {
    const config = parseWranglerConfig(
      `
name = "app"
main = "src/index.ts"

[vars]
API_URL = "https://api.example.com"
DEBUG = "false"
`,
      "toml",
    );
    expect(config.vars).toEqual({
      API_URL: "https://api.example.com",
      DEBUG: "false",
    });
  });

  test("parses durable objects", () => {
    const config = parseWranglerConfig(
      `
name = "app"
main = "src/index.ts"

[durable_objects]
bindings = [
  { name = "COUNTER", class_name = "CounterDO" }
]
`,
      "toml",
    );
    expect(config.durable_objects?.bindings).toHaveLength(1);
    expect(config.durable_objects!.bindings![0].name).toBe("COUNTER");
    expect(config.durable_objects!.bindings![0].class_name).toBe("CounterDO");
  });

  test("handles missing optional fields gracefully", () => {
    const config = parseWranglerConfig(`name = "bare"`, "toml");
    expect(config.name).toBe("bare");
    expect(config.main).toBeUndefined();
    expect(config.d1_databases).toBeUndefined();
    expect(config.kv_namespaces).toBeUndefined();
    expect(config.r2_buckets).toBeUndefined();
    expect(config.ai).toBeUndefined();
    expect(config.vars).toBeUndefined();
  });

  test("detects unsupported features", () => {
    const config = parseWranglerConfig(
      `
name = "app"
main = "src/index.ts"

[[queues.producers]]
queue = "my-queue"
binding = "QUEUE"
`,
      "toml",
    );
    expect(config.queues).toBeDefined();
  });
});

describe("parseWranglerConfig — JSONC", () => {
  test("parses JSONC with comments", () => {
    const config = parseWranglerConfig(
      `{
  // Project name
  "name": "my-api",
  "main": "src/index.ts",
  /* Bindings */
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "mydb",
      "database_id": "xxx",
    }
  ]
}`,
      "jsonc",
    );
    expect(config.name).toBe("my-api");
    expect(config.d1_databases).toHaveLength(1);
    expect(config.d1_databases![0].binding).toBe("DB");
  });
});

describe("parseWranglerConfig — JSON", () => {
  test("parses plain JSON", () => {
    const config = parseWranglerConfig(
      JSON.stringify({
        name: "my-api",
        main: "src/index.ts",
        kv_namespaces: [{ binding: "KV", id: "abc123" }],
      }),
      "json",
    );
    expect(config.name).toBe("my-api");
    expect(config.kv_namespaces![0].binding).toBe("KV");
  });
});
