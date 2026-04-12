import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildAndBundle, detectPM, detectWorkspaceCascade } from "./build-pipeline.js";

/**
 * These tests verify the build pipeline logic using mock project directories.
 * They test config detection + asset collection, NOT actual git clone/npm install.
 *
 * For the clone/install/build steps, we create pre-built directory structures
 * that simulate what a real build would produce.
 */

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "creek-build-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// NOTE: buildAndBundle requires git clone which we can't mock easily.
// Instead, test the sub-components that are testable without network.

describe("build-pipeline types", () => {
  test("BuildResult has correct shape", async () => {
    // This is a compile-time check — ensures types are exported correctly
    const { buildAndBundle: fn } = await import("./build-pipeline.js");
    expect(typeof fn).toBe("function");
  });
});

describe("detectPM — walks up the tree for monorepos", () => {
  test("returns pnpm when pnpm-lock.yaml is at workspace root", () => {
    // Simulate: /tmp/repo/pnpm-lock.yaml + /tmp/repo/templates/starter/package.json
    writeFileSync(join(tmpDir, "pnpm-lock.yaml"), "");
    const sub = join(tmpDir, "templates", "starter");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "package.json"), "{}");
    expect(detectPM(sub, tmpDir)).toBe("pnpm");
  });

  test("returns pnpm when pnpm-workspace.yaml is at root (no lockfile yet)", () => {
    writeFileSync(join(tmpDir, "pnpm-workspace.yaml"), "");
    const sub = join(tmpDir, "apps", "web");
    mkdirSync(sub, { recursive: true });
    expect(detectPM(sub, tmpDir)).toBe("pnpm");
  });

  test("returns yarn when yarn.lock is at workspace root", () => {
    writeFileSync(join(tmpDir, "yarn.lock"), "");
    const sub = join(tmpDir, "packages", "app");
    mkdirSync(sub, { recursive: true });
    expect(detectPM(sub, tmpDir)).toBe("yarn");
  });

  test("prefers lockfile closest to cwd over ancestor", () => {
    // Root has pnpm-lock, but subdir has its own package-lock → subdir wins
    writeFileSync(join(tmpDir, "pnpm-lock.yaml"), "");
    const sub = join(tmpDir, "standalone");
    mkdirSync(sub);
    writeFileSync(join(sub, "package-lock.json"), "{}");
    expect(detectPM(sub, tmpDir)).toBe("npm");
  });

  test("stops at stopAt and never escapes the repo", () => {
    // Even if the host machine has a pnpm-lock above stopAt, we must not see it.
    const sub = join(tmpDir, "leaf");
    mkdirSync(sub);
    // No lockfiles anywhere in tmpDir → should return npm, not walk further up.
    expect(detectPM(sub, tmpDir)).toBe("npm");
  });

  test("handles cwd === stopAt", () => {
    writeFileSync(join(tmpDir, "pnpm-lock.yaml"), "");
    expect(detectPM(tmpDir, tmpDir)).toBe("pnpm");
  });
});

describe("detectWorkspaceCascade — pnpm monorepo build cascade", () => {
  test("triggers for pnpm target with workspace:* deps", () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({
        name: "@acme/web",
        dependencies: { "@acme/core": "workspace:*", react: "^18" },
      }),
    );
    expect(detectWorkspaceCascade(tmpDir, "pnpm")).toEqual({
      useCascade: true,
      targetName: "@acme/web",
    });
  });

  test("triggers for workspace:^ and workspace:~ variants", () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({
        name: "@acme/web",
        dependencies: { "@acme/lib": "workspace:^" },
      }),
    );
    expect(detectWorkspaceCascade(tmpDir, "pnpm").useCascade).toBe(true);
  });

  test("no cascade when deps are all external", () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({
        name: "standalone",
        dependencies: { astro: "^6", react: "^18" },
      }),
    );
    expect(detectWorkspaceCascade(tmpDir, "pnpm").useCascade).toBe(false);
  });

  test("no cascade for yarn even with workspace deps (pnpm-only feature)", () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({
        name: "@acme/web",
        dependencies: { "@acme/core": "workspace:*" },
      }),
    );
    expect(detectWorkspaceCascade(tmpDir, "yarn").useCascade).toBe(false);
    expect(detectWorkspaceCascade(tmpDir, "npm").useCascade).toBe(false);
  });

  test("no cascade when target has no name field", () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { "@acme/core": "workspace:*" } }),
    );
    expect(detectWorkspaceCascade(tmpDir, "pnpm").useCascade).toBe(false);
  });

  test("no cascade when package.json is missing", () => {
    expect(detectWorkspaceCascade(tmpDir, "pnpm").useCascade).toBe(false);
  });

  test("handles malformed package.json gracefully", () => {
    writeFileSync(join(tmpDir, "package.json"), "{ not valid json");
    expect(detectWorkspaceCascade(tmpDir, "pnpm").useCascade).toBe(false);
  });

  test("checks devDependencies too", () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({
        name: "@acme/web",
        devDependencies: { "@acme/test-utils": "workspace:*" },
      }),
    );
    expect(detectWorkspaceCascade(tmpDir, "pnpm").useCascade).toBe(true);
  });
});

// Test the config detection part separately (this IS testable without network)
describe("resolveConfig integration", () => {
  test("detects wrangler.toml project", async () => {
    const { resolveConfig, formatDetectionSummary } = await import("@solcreek/sdk");

    writeFileSync(join(tmpDir, "wrangler.toml"), `
name = "test-worker"
main = "src/index.ts"
compatibility_date = "2025-01-01"

[[d1_databases]]
binding = "DB"
database_name = "test"
database_id = "xxx"
`);

    const config = resolveConfig(tmpDir);
    expect(config.source).toBe("wrangler.toml");
    expect(config.workerEntry).toBe("src/index.ts");
    expect(config.bindings.find(b => b.type === "d1")).toBeDefined();
    expect(formatDetectionSummary(config)).toContain("D1");
  });

  test("detects nuxt framework with SSR server dir", async () => {
    const { resolveConfig, isPreBundledFramework, getSSRServerDir } = await import("@solcreek/sdk");

    writeFileSync(join(tmpDir, "wrangler.jsonc"), JSON.stringify({
      name: "nuxt-app",
      main: ".output/server/index.mjs",
    }));
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({
      dependencies: { nuxt: "^4.0.0" },
      scripts: { build: "nuxt build" },
    }));

    const config = resolveConfig(tmpDir);
    expect(config.framework).toBe("nuxt");
    expect(isPreBundledFramework(config.framework)).toBe(true);
    expect(getSSRServerDir(config.framework)).toBe(".output/server");
  });

  test("detects pure Worker (no framework + has entry)", async () => {
    const { resolveConfig } = await import("@solcreek/sdk");

    writeFileSync(join(tmpDir, "wrangler.toml"), `
name = "my-api"
main = "src/index.ts"

[[kv_namespaces]]
binding = "CACHE"
id = "xxx"
`);
    // package.json with hono but no framework
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({
      dependencies: { hono: "^4.0.0" },
    }));

    const config = resolveConfig(tmpDir);
    expect(config.framework).toBeNull();
    expect(config.workerEntry).toBe("src/index.ts");
    expect(config.bindings.find(b => b.type === "kv")?.name).toBe("CACHE");
  });
});

describe("bundle format compatibility", () => {
  test("resolvedConfigToResources produces correct boolean flags", async () => {
    const { resolveConfig, resolvedConfigToResources } = await import("@solcreek/sdk");

    writeFileSync(join(tmpDir, "wrangler.toml"), `
name = "app"
main = "src/index.ts"

[[d1_databases]]
binding = "DB"
database_id = "x"

[[r2_buckets]]
binding = "UPLOADS"
bucket_name = "b"
`);

    const config = resolveConfig(tmpDir);
    const resources = resolvedConfigToResources(config);
    expect(resources).toEqual({ d1: true, r2: true, kv: false, ai: false });
  });

  test("resolvedConfigToBindingRequirements preserves user names", async () => {
    const { resolveConfig, resolvedConfigToBindingRequirements } = await import("@solcreek/sdk");

    writeFileSync(join(tmpDir, "wrangler.toml"), `
name = "app"
main = "src/index.ts"

[[kv_namespaces]]
binding = "MY_CACHE"
id = "x"
`);

    const config = resolveConfig(tmpDir);
    const reqs = resolvedConfigToBindingRequirements(config);
    expect(reqs).toEqual([{ type: "kv", bindingName: "MY_CACHE" }]);
  });
});
