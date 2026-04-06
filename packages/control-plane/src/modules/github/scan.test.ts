import { describe, test, expect, vi, beforeEach } from "vitest";
import { scanRepo, type RepoScanResult } from "./scan.js";

// Mock the GitHub API module
vi.mock("./api.js", () => ({
  getRepoContents: vi.fn(),
}));

import { getRepoContents } from "./api.js";

const mockGetContents = vi.mocked(getRepoContents);

beforeEach(() => {
  vi.clearAllMocks();
});

function setupMockFiles(files: Record<string, string | null>) {
  mockGetContents.mockImplementation(async (_token, _owner, _repo, path) => {
    return files[path] ?? null;
  });
}

describe("scanRepo", () => {
  test("detects Nuxt framework from package.json", async () => {
    setupMockFiles({
      "wrangler.jsonc": null,
      "wrangler.json": null,
      "wrangler.toml": null,
      "package.json": JSON.stringify({ dependencies: { nuxt: "^4.0.0" } }),
      ".env.example": null,
    });

    const result = await scanRepo("token", "owner", "repo");
    expect(result.framework).toBe("nuxt");
    expect(result.deployable).toBe(true);
  });

  test("detects D1 + KV bindings from wrangler.toml", async () => {
    setupMockFiles({
      "wrangler.jsonc": null,
      "wrangler.json": null,
      "wrangler.toml": `
name = "my-api"
main = "src/index.ts"

[[d1_databases]]
binding = "DB"
database_id = "xxx"

[[kv_namespaces]]
binding = "CACHE"
id = "yyy"
`,
      "package.json": JSON.stringify({ dependencies: { hono: "^4.0.0" } }),
      ".env.example": null,
    });

    const result = await scanRepo("token", "owner", "repo");
    expect(result.configType).toBe("wrangler.toml");
    expect(result.bindings).toContainEqual({ type: "d1", name: "DB" });
    expect(result.bindings).toContainEqual({ type: "kv", name: "CACHE" });
  });

  test("parses JSONC wrangler config", async () => {
    setupMockFiles({
      "wrangler.jsonc": `{
  // comment
  "name": "app",
  "d1_databases": [{ "binding": "DB", "database_id": "x" }],
}`,
      "wrangler.json": null,
      "wrangler.toml": null,
      "package.json": null,
      ".env.example": null,
    });

    const result = await scanRepo("token", "owner", "repo");
    expect(result.configType).toBe("wrangler.jsonc");
    expect(result.bindings).toContainEqual({ type: "d1", name: "DB" });
  });

  test("extracts env hints from .env.example", async () => {
    setupMockFiles({
      "wrangler.jsonc": null,
      "wrangler.json": null,
      "wrangler.toml": null,
      "package.json": JSON.stringify({ dependencies: { next: "14.0.0" } }),
      ".env.example": "# Database\nDATABASE_URL=postgres://...\nSECRET_KEY=\n# Optional\nDEBUG=false",
    });

    const result = await scanRepo("token", "owner", "repo");
    expect(result.envHints).toContain("DATABASE_URL");
    expect(result.envHints).toContain("SECRET_KEY");
    expect(result.envHints).toContain("DEBUG");
    expect(result.envHints).not.toContain("# Database");
  });

  test("returns deployable=false when no config found", async () => {
    setupMockFiles({
      "wrangler.jsonc": null,
      "wrangler.json": null,
      "wrangler.toml": null,
      "package.json": null,
      ".env.example": null,
    });

    const result = await scanRepo("token", "owner", "repo");
    expect(result.framework).toBeNull();
    expect(result.configType).toBeNull();
    expect(result.deployable).toBe(false);
  });

  test("handles invalid package.json gracefully", async () => {
    setupMockFiles({
      "wrangler.jsonc": null,
      "wrangler.json": null,
      "wrangler.toml": null,
      "package.json": "not valid json {{{",
      ".env.example": null,
    });

    const result = await scanRepo("token", "owner", "repo");
    expect(result.framework).toBeNull();
    // Still deployable because package.json exists (could be fixed)
    expect(result.deployable).toBe(true);
  });

  test("prefers wrangler.jsonc over wrangler.toml", async () => {
    setupMockFiles({
      "wrangler.jsonc": '{ "name": "app", "d1_databases": [{"binding": "DB", "database_id": "x"}] }',
      "wrangler.json": null,
      "wrangler.toml": 'name = "app"',
      "package.json": null,
      ".env.example": null,
    });

    const result = await scanRepo("token", "owner", "repo");
    expect(result.configType).toBe("wrangler.jsonc");
  });

  test("detects AI + R2 + analytics engine", async () => {
    setupMockFiles({
      "wrangler.jsonc": JSON.stringify({
        name: "app",
        ai: { binding: "AI" },
        r2_buckets: [{ binding: "UPLOADS", bucket_name: "b" }],
        analytics_engine_datasets: [{ binding: "AE", dataset: "d" }],
      }),
      "wrangler.json": null,
      "wrangler.toml": null,
      "package.json": null,
      ".env.example": null,
    });

    const result = await scanRepo("token", "owner", "repo");
    expect(result.bindings).toContainEqual({ type: "ai", name: "AI" });
    expect(result.bindings).toContainEqual({ type: "r2", name: "UPLOADS" });
    expect(result.bindings).toContainEqual({ type: "analytics_engine", name: "AE" });
  });
});
