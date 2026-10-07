import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import {
  buildAndBundle,
  buildSteps,
  detectPM,
  detectWorkspaceCascade,
  workerFirst,
} from "./build-pipeline.js";
import { materializeVinextFixture } from "../../sdk/src/framework/__fixtures__/vinext-cf-output/materialize.js";

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

    writeFileSync(
      join(tmpDir, "wrangler.toml"),
      `
name = "test-worker"
main = "src/index.ts"
compatibility_date = "2025-01-01"

[[d1_databases]]
binding = "DB"
database_name = "test"
database_id = "xxx"
`,
    );

    const config = resolveConfig(tmpDir);
    expect(config.source).toBe("wrangler.toml");
    expect(config.workerEntry).toBe("src/index.ts");
    expect(config.bindings.find((b) => b.type === "d1")).toBeDefined();
    expect(formatDetectionSummary(config)).toContain("D1");
  });

  test("detects nuxt framework with SSR server dir", async () => {
    const { resolveConfig, isPreBundledFramework, getSSRServerDir } = await import("@solcreek/sdk");

    writeFileSync(
      join(tmpDir, "wrangler.jsonc"),
      JSON.stringify({
        name: "nuxt-app",
        main: ".output/server/index.mjs",
      }),
    );
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({
        dependencies: { nuxt: "^4.0.0" },
        scripts: { build: "nuxt build" },
      }),
    );

    const config = resolveConfig(tmpDir);
    expect(config.framework).toBe("nuxt");
    expect(isPreBundledFramework(config.framework)).toBe(true);
    expect(getSSRServerDir(config.framework)).toBe(".output/server");
  });

  test("detects pure Worker (no framework + has entry)", async () => {
    const { resolveConfig } = await import("@solcreek/sdk");

    writeFileSync(
      join(tmpDir, "wrangler.toml"),
      `
name = "my-api"
main = "src/index.ts"

[[kv_namespaces]]
binding = "CACHE"
id = "xxx"
`,
    );
    // package.json with hono but no framework
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({
        dependencies: { hono: "^4.0.0" },
      }),
    );

    const config = resolveConfig(tmpDir);
    expect(config.framework).toBeNull();
    expect(config.workerEntry).toBe("src/index.ts");
    expect(config.bindings.find((b) => b.type === "kv")?.name).toBe("CACHE");
  });
});

describe("bundle format compatibility", () => {
  test("resolvedConfigToResources produces correct boolean flags", async () => {
    const { resolveConfig, resolvedConfigToResources } = await import("@solcreek/sdk");

    writeFileSync(
      join(tmpDir, "wrangler.toml"),
      `
name = "app"
main = "src/index.ts"

[[d1_databases]]
binding = "DB"
database_id = "x"

[[r2_buckets]]
binding = "UPLOADS"
bucket_name = "b"
`,
    );

    const config = resolveConfig(tmpDir);
    const resources = resolvedConfigToResources(config);
    expect(resources).toEqual({ d1: true, r2: true, kv: false, ai: false });
  });

  test("resolvedConfigToBindingRequirements preserves user names", async () => {
    const { resolveConfig, resolvedConfigToBindingRequirements } = await import("@solcreek/sdk");

    writeFileSync(
      join(tmpDir, "wrangler.toml"),
      `
name = "app"
main = "src/index.ts"

[[kv_namespaces]]
binding = "MY_CACHE"
id = "x"
`,
    );

    const config = resolveConfig(tmpDir);
    const reqs = resolvedConfigToBindingRequirements(config);
    expect(reqs).toEqual([{ type: "kv", bindingName: "MY_CACHE" }]);
  });
});

describe("buildAndBundle — [release] migrations (#57)", () => {
  // A dependency-free static project in a local git repo, so clone, install
  // and build all run without network.
  function makeRepo(creekToml: string, migrations: Record<string, string>) {
    writeFileSync(join(tmpDir, "creek.toml"), creekToml);
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({
        name: "app",
        private: true,
        scripts: {
          build:
            "node -e \"require('fs').mkdirSync('dist');require('fs').writeFileSync('dist/index.html','hi')\"",
        },
      }),
    );
    mkdirSync(join(tmpDir, "db/migrations"), { recursive: true });
    for (const [name, sql] of Object.entries(migrations)) {
      writeFileSync(join(tmpDir, "db/migrations", name), sql);
    }
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: tmpDir,
        stdio: "pipe",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.com",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.com",
        },
      });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-qm", "init");
  }

  test("ships the migrations when the switch is on", async () => {
    makeRepo('[project]\nname = "app"\n[release]\nmigrations = true\n', {
      "0001_init.sql": "CREATE TABLE a (id INTEGER);",
      "0002_more.sql": "CREATE TABLE b (id INTEGER);",
    });

    const result = await buildAndBundle({ repoUrl: tmpDir });

    expect("error" in result ? result : null).toBeNull();
    if ("error" in result) return;
    expect(result.bundle.releaseMigrations).toBe(true);
    expect(result.bundle.migrations).toEqual([
      { name: "0001_init.sql", statements: ["CREATE TABLE a (id INTEGER);"] },
      { name: "0002_more.sql", statements: ["CREATE TABLE b (id INTEGER);"] },
    ]);
  });

  test("ships none when the switch is off", async () => {
    makeRepo('[project]\nname = "app"\n', { "0001_init.sql": "CREATE TABLE a (id INTEGER);" });

    const result = await buildAndBundle({ repoUrl: tmpDir });

    if ("error" in result) throw new Error(result.message);
    expect(result.bundle.releaseMigrations).toBeUndefined();
    expect(result.bundle.migrations).toBeUndefined();
  });
});

describe("buildSteps", () => {
  test("standalone project runs the selected script in the project dir", () => {
    expect(buildSteps("npm", null, "build:vinext")).toEqual([
      { cmd: "npm", args: ["run", "build:vinext"], at: "project", timeoutMs: 180_000 },
    ]);
  });

  test("workspace cascade with `build`: one filter run over the target and its deps", () => {
    expect(buildSteps("pnpm", "web", "build")).toEqual([
      { cmd: "pnpm", args: ["--filter", "web...", "build"], at: "repo", timeoutMs: 300_000 },
    ]);
  });

  test("workspace cascade with build:vinext: deps build first, then the target's own script", () => {
    // The target's `build` is still `next build` after `vinext init`; running
    // it would produce no vinext Build Output.
    expect(buildSteps("pnpm", "web", "build:vinext")).toEqual([
      { cmd: "pnpm", args: ["--filter", "web^...", "build"], at: "repo", timeoutMs: 300_000 },
      { cmd: "pnpm", args: ["run", "build:vinext"], at: "project", timeoutMs: 180_000 },
    ]);
  });
});

describe("workerFirst", () => {
  const vinextPaths = ["/_vinext/static-cache/*"];

  test("the build output's paths apply when config sets nothing", () => {
    expect(workerFirst("worker", null, vinextPaths)).toEqual({ runWorkerFirst: vinextPaths });
  });

  test("config wins, including an explicit false", () => {
    expect(workerFirst("worker", true, vinextPaths)).toEqual({ runWorkerFirst: true });
    expect(workerFirst("worker", false, vinextPaths)).toEqual({});
  });

  test("config applies on its own for a non-vinext worker", () => {
    expect(workerFirst("worker", ["/api/*"], null)).toEqual({ runWorkerFirst: ["/api/*"] });
  });

  test("only worker mode runs a worker first", () => {
    expect(workerFirst("ssr", true, vinextPaths)).toEqual({});
  });
});

describe("buildAndBundle — vinext Build Output", () => {
  // A dependency-free project in a local git repo, so clone, install and build
  // run without network. creek.toml pins the framework (no vinext dependency to
  // install); the committed Build Output is the captured create-vinext-app
  // build, and the build script leaves it as is.
  function makeVinextRepo(
    output: "plain" | "bindings" | "run-worker-first" | null,
    workerConfig?: object,
  ) {
    writeFileSync(join(tmpDir, "creek.toml"), '[project]\nname = "app"\nframework = "vinext"\n');
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "app", private: true, scripts: { build: 'node -e "0"' } }),
    );
    if (output) materializeVinextFixture(tmpDir, { workerConfig: output });
    if (workerConfig) {
      writeFileSync(
        join(tmpDir, ".cloudflare/output/v0/workers/default/worker.config.json"),
        JSON.stringify(workerConfig),
      );
    }
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: tmpDir,
        stdio: "pipe",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.com",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.com",
        },
      });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-qm", "init");
  }

  async function bundled() {
    const result = await buildAndBundle({ repoUrl: tmpDir });
    if ("error" in result) throw new Error(`${result.error}: ${result.message}`);
    return result;
  }

  test("deploys bundle/ in worker mode and assets/ as static assets", async () => {
    makeVinextRepo("plain");
    const { bundle, config } = await bundled();

    expect(config.renderMode).toBe("worker");
    expect(bundle.manifest).toMatchObject({
      hasWorker: true,
      entrypoint: "index.js",
      mainModule: "index.js",
      renderMode: "worker",
    });
    expect(bundle.manifest.runWorkerFirst).toBeUndefined();

    const modules = Object.keys(bundle.serverFiles ?? {});
    expect(modules).toContain("index.js");
    expect(modules).toContain("ssr/index.js");
    expect(modules.some((m) => m.endsWith(".json") || m.endsWith(".css"))).toBe(false);

    expect(bundle.manifest.assets).toContain("_headers");
    expect(bundle.manifest.assets).toContain("_next/static/chunks/index-CnPdVYHA.js");
    expect(bundle.manifest.assets).not.toContain(".assetsignore");
    expect(bundle.manifest.assets).not.toContain(".vite/manifest.json");
    expect(bundle.assets[".vite/manifest.json"]).toBeUndefined();

    expect(bundle.bindings).toEqual([{ type: "kv", bindingName: "VINEXT_KV_CACHE" }]);
    expect(bundle.compatibilityDate).toBe("2026-10-07");
    expect(bundle.compatibilityFlags).toEqual(["nodejs_compat"]);
  });

  test("text bindings deploy as vars; D1 / R2 / AI keep their names", async () => {
    makeVinextRepo("plain", {
      compatibilityDate: "2026-10-07",
      compatibilityFlags: ["nodejs_compat"],
      env: {
        ASSETS: { type: "assets" },
        DB: { type: "d1", name: "my-db" },
        FILES: { type: "r2", name: "my-bucket" },
        AI: { type: "ai" },
        GREETING: { type: "text", value: "hello" },
      },
      manifest: { type: "partial", mainModule: "index.js", modules: {} },
    });
    const { bundle } = await bundled();

    expect(bundle.bindings).toEqual([
      { type: "d1", bindingName: "DB" },
      { type: "r2", bindingName: "FILES" },
      { type: "ai", bindingName: "AI" },
    ]);
    expect(bundle.vars).toEqual({ GREETING: "hello" });
  });

  test("carries the static-assets cache's runWorkerFirst paths", async () => {
    makeVinextRepo("run-worker-first");
    const { bundle } = await bundled();
    expect(bundle.manifest.runWorkerFirst).toEqual(["/_vinext/static-cache/*"]);
  });

  test("a binding Creek can't provide stops the build", async () => {
    makeVinextRepo("bindings");
    const result = await buildAndBundle({ repoUrl: tmpDir });
    expect(result).toMatchObject({ error: "unsupported_bindings" });
    if ("error" in result) expect(result.message).toContain("IMAGES (images)");
  });

  test("no Build Output stops the build with the init command", async () => {
    makeVinextRepo(null);
    const result = await buildAndBundle({ repoUrl: tmpDir });
    expect(result).toMatchObject({ error: "build_output_missing" });
    if ("error" in result) expect(result.message).toContain("vinext init --platform=cloudflare");
  });
});
