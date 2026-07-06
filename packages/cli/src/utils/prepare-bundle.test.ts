/**
 * Integration tests for prepareDeployBundle.
 *
 * Strategy: build temp project fixtures on disk (no mocks) and assert
 * the prepared bundle's shape — render mode, asset list, server file
 * presence, exclusion behavior. This catches the orchestration bugs
 * that pure planDeploy unit tests miss (e.g. forgetting to filter
 * dist/_worker.mjs out of clientAssets, or letting framework
 * detection drift between the two deploy paths).
 *
 * To stay fast, we never invoke the real build script — every fixture
 * runs with `skipBuild: true` and pre-staged build output. esbuild
 * IS run for real on the worker fixture (cheap, ~50ms), so we exercise
 * the actual bundleWorker path.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import consola from "consola";
import type { ResolvedConfig } from "@solcreek/sdk";
import { prepareDeployBundle, packageScriptName } from "./prepare-bundle.js";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "creek-prepare-bundle-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function writeFixture(files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(cwd, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
}

function baseConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    source: "creek.toml",
    projectName: "test-app",
    framework: null,
    buildCommand: "",
    buildOutput: "dist",
    workerEntry: null,
    bindings: [],
    unsupportedBindings: [],
    vars: {},
    compatibilityDate: null,
    compatibilityFlags: [],
    cron: [],
    queue: false,
    ...overrides,
  };
}

describe("prepareDeployBundle", () => {
  test("pure SPA — vite-react with built dist/, no worker", async () => {
    writeFixture({
      "package.json": JSON.stringify({
        name: "spa",
        dependencies: { react: "*", vite: "*" },
      }),
      "dist/index.html": "<!doctype html><html><body>spa</body></html>",
      "dist/assets/app.js": "console.log('app')",
    });

    const result = await prepareDeployBundle({
      cwd,
      resolved: baseConfig({ framework: "vite-react" }),
      skipBuild: true,
    });

    expect(result.effectiveRenderMode).toBe("spa");
    expect(result.serverFiles).toBeUndefined();
    expect(result.fileList.sort()).toEqual(["assets/app.js", "index.html"]);
    expect(result.plan.worker.strategy).toBe("none");
  });

  test("vite-react + prebundled worker — coexist mode, worker file excluded from assets", async () => {
    writeFixture({
      "package.json": JSON.stringify({
        name: "coexist",
        dependencies: { react: "*", vite: "*" },
      }),
      "dist/index.html": "<!doctype html><html><body>spa</body></html>",
      "dist/assets/app.js": "console.log('app')",
      "dist/_worker.mjs":
        "export default { fetch(req, env) { return new Response('hi from worker'); } };",
    });

    const result = await prepareDeployBundle({
      cwd,
      resolved: baseConfig({
        framework: "vite-react",
        workerEntry: "dist/_worker.mjs",
      }),
      skipBuild: true,
    });

    expect(result.effectiveRenderMode).toBe("worker");
    expect(result.plan.worker.strategy).toBe("upload-asis");
    expect(result.serverFiles).toBeDefined();
    expect(Object.keys(result.serverFiles!)).toEqual(["worker.js"]);

    // The critical regression — _worker.mjs MUST NOT show up as a
    // public static asset. If this fails, the worker bundle is
    // double-uploaded and accessible via /_worker.mjs.
    expect(result.fileList.sort()).toEqual(["assets/app.js", "index.html"]);
    expect(result.assets["/_worker.mjs"]).toBeUndefined();
    expect(result.assets["_worker.mjs"]).toBeUndefined();
  });

  test("vanilla worker — TS source outside dist, no static frontend", async () => {
    writeFixture({
      "package.json": JSON.stringify({
        name: "vanilla-worker",
        dependencies: { hono: "*" },
      }),
      "worker/index.ts": `export default { async fetch() { return new Response("ok"); } };`,
      // bundleWorker generates a wrapper that imports `creek` for env
      // injection. In a real user project this comes from npm install;
      // here we stub it so esbuild can resolve the import. The bundled
      // worker won't run (the stubs are no-ops) but the bundling
      // pipeline does, which is what we're testing.
      "node_modules/creek/package.json": JSON.stringify({
        name: "creek",
        type: "module",
        main: "index.js",
      }),
      "node_modules/creek/index.js":
        "export const _runRequest = async (_e, _c, fn) => fn(); export const generateWsToken = async () => '';",
    });

    const result = await prepareDeployBundle({
      cwd,
      resolved: baseConfig({ workerEntry: "worker/index.ts" }),
      skipBuild: true,
    });

    expect(result.effectiveRenderMode).toBe("worker");
    expect(result.plan.worker.strategy).toBe("esbuild-bundle");
    expect(result.serverFiles).toBeDefined();
    expect(Object.keys(result.serverFiles!)).toEqual(["worker.js"]);
    expect(result.fileList).toEqual([]);
    expect(result.assets).toEqual({});
  });

  test("API-only worker with no build script — skips build, bundles worker", async () => {
    // An API-only worker (no frontend) has no "build" script but the
    // command defaults to `npm run build`. The deploy must skip the build
    // instead of failing with npm's cryptic "Missing script: build".
    const infoSpy = vi.spyOn(consola, "info").mockImplementation(() => undefined);
    writeFixture({
      "package.json": JSON.stringify({
        name: "api-only",
        dependencies: { hono: "*" },
        // no "scripts" — the F-03 scenario
      }),
      "worker/index.ts": `export default { async fetch() { return new Response("ok"); } };`,
      "node_modules/creek/package.json": JSON.stringify({
        name: "creek",
        type: "module",
        main: "index.js",
      }),
      "node_modules/creek/index.js":
        "export const _runRequest = async (_e, _c, fn) => fn(); export const generateWsToken = async () => '';",
    });

    const result = await prepareDeployBundle({
      cwd,
      resolved: baseConfig({
        workerEntry: "worker/index.ts",
        buildCommand: "npm run build",
      }),
      skipBuild: false, // exercise the real build gate
    });

    expect(result.effectiveRenderMode).toBe("worker");
    expect(Object.keys(result.serverFiles!)).toEqual(["worker.js"]);
    const info = infoSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(info).toContain('No "build" script');
    infoSpy.mockRestore();
  });

  test("malformed package.json scripts — skips build without crashing", async () => {
    // A non-object "scripts" field would make `name in scripts` throw a
    // TypeError. The build gate must treat it as "no scripts" and skip,
    // not crash the deploy.
    writeFixture({
      "package.json": JSON.stringify({
        name: "bad-scripts",
        dependencies: { hono: "*" },
        scripts: "this should be an object",
      }),
      "worker/index.ts": `export default { async fetch() { return new Response("ok"); } };`,
      "node_modules/creek/package.json": JSON.stringify({
        name: "creek",
        type: "module",
        main: "index.js",
      }),
      "node_modules/creek/index.js":
        "export const _runRequest = async (_e, _c, fn) => fn(); export const generateWsToken = async () => '';",
    });

    const result = await prepareDeployBundle({
      cwd,
      resolved: baseConfig({
        workerEntry: "worker/index.ts",
        buildCommand: "npm run build",
      }),
      skipBuild: false,
    });

    expect(result.effectiveRenderMode).toBe("worker");
  });

  test("worker entry pointing at missing file — exits with explicit reason", async () => {
    writeFixture({
      "package.json": JSON.stringify({ name: "missing-worker" }),
      "dist/index.html": "<html></html>",
    });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    await expect(
      prepareDeployBundle({
        cwd,
        resolved: baseConfig({ workerEntry: "worker/missing.ts" }),
        skipBuild: true,
      }),
    ).rejects.toThrow("process.exit called");

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  test("nothing to deploy — exits with explicit reason", async () => {
    writeFixture({
      "package.json": JSON.stringify({ name: "empty" }),
    });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    await expect(
      prepareDeployBundle({
        cwd,
        resolved: baseConfig(),
        skipBuild: true,
      }),
    ).rejects.toThrow("process.exit called");

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  // B8: a JSON-mode caller (CI / scripts / agents) must get a structured
  // `{ ok: false, error, message }` on stdout, not only a human error line.
  test("jsonMode: a plan failure prints structured JSON and exits 1", async () => {
    writeFixture({ "package.json": JSON.stringify({ name: "empty" }) });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await expect(
      prepareDeployBundle({
        cwd,
        resolved: baseConfig(),
        skipBuild: true,
        jsonMode: true,
      }),
    ).rejects.toThrow("process.exit called");

    expect(exitSpy).toHaveBeenCalledWith(1);
    const payload = JSON.parse(stdout.mock.calls[0]![0] as string);
    expect(payload).toMatchObject({ ok: false, error: "nothing_to_deploy" });
    expect(typeof payload.message).toBe("string");

    stdout.mockRestore();
    exitSpy.mockRestore();
  });

  test("jsonMode: a failing build command prints structured JSON and exits 1", async () => {
    writeFixture({ "package.json": JSON.stringify({ name: "build-fails" }) });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await expect(
      prepareDeployBundle({
        cwd,
        // A direct command (not `npm run …`) runs via execSync as-is — no npm
        // subprocess, matching this file's "avoid real build scripts" strategy.
        resolved: baseConfig({ buildCommand: 'node -e "process.exit(3)"' }),
        skipBuild: false,
        jsonMode: true,
      }),
    ).rejects.toThrow("process.exit called");

    expect(exitSpy).toHaveBeenCalledWith(1);
    const payload = JSON.parse(stdout.mock.calls[0]![0] as string);
    expect(payload).toMatchObject({ ok: false, error: "build_failed" });

    stdout.mockRestore();
    exitSpy.mockRestore();
  });

  // consola's start/success write to stdout in non-TTY; in jsonMode they must
  // be suppressed so they don't precede and corrupt the final JSON payload.
  test("jsonMode: suppresses consola progress so stdout stays JSON-only", async () => {
    writeFixture({
      "package.json": JSON.stringify({
        name: "spa",
        dependencies: { react: "*", vite: "*" },
      }),
      "dist/index.html": "<!doctype html><html><body>spa</body></html>",
      "dist/assets/app.js": "console.log('app')",
    });

    const startSpy = vi.spyOn(consola, "start").mockImplementation(() => undefined);
    const successSpy = vi.spyOn(consola, "success").mockImplementation(() => undefined);
    const infoSpy = vi.spyOn(consola, "info").mockImplementation(() => undefined);

    await prepareDeployBundle({
      cwd,
      resolved: baseConfig({ framework: "vite-react" }),
      skipBuild: true,
      jsonMode: true,
    });

    expect(startSpy).not.toHaveBeenCalled();
    expect(successSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();

    startSpy.mockRestore();
    successSpy.mockRestore();
    infoSpy.mockRestore();
  });

  test("framework auto-detection from package.json — no resolved.framework", async () => {
    writeFixture({
      "package.json": JSON.stringify({
        name: "auto-detect",
        dependencies: { react: "*", vite: "*" },
      }),
      "dist/index.html": "<html></html>",
    });

    const result = await prepareDeployBundle({
      cwd,
      resolved: baseConfig(), // framework: null
      skipBuild: true,
    });

    // detectFramework picked vite-react from deps
    expect(result.framework).toBe("vite-react");
    expect(result.effectiveRenderMode).toBe("spa");
  });

  test("nested prebundled worker — dist/edge/_worker.mjs excluded with full subpath", async () => {
    writeFixture({
      "package.json": JSON.stringify({
        name: "nested",
        dependencies: { react: "*", vite: "*" },
      }),
      "dist/index.html": "<html></html>",
      "dist/edge/_worker.mjs":
        "export default { fetch() { return new Response('w'); } };",
    });

    const result = await prepareDeployBundle({
      cwd,
      resolved: baseConfig({
        framework: "vite-react",
        workerEntry: "dist/edge/_worker.mjs",
      }),
      skipBuild: true,
    });

    expect(result.plan.worker.strategy).toBe("upload-asis");
    expect(result.fileList.sort()).toEqual(["index.html"]);
    expect(result.assets["edge/_worker.mjs"]).toBeUndefined();
  });
});

describe("packageScriptName", () => {
  test("extracts the script name from package-manager run commands", () => {
    expect(packageScriptName("npm run build")).toBe("build");
    expect(packageScriptName("pnpm run build")).toBe("build");
    expect(packageScriptName("yarn run build")).toBe("build");
    expect(packageScriptName("bun run build")).toBe("build");
    expect(packageScriptName("  npm run build:prod  ")).toBe("build:prod");
  });

  test("skips boolean option flags between run and the script name", () => {
    expect(packageScriptName("npm run --silent build")).toBe("build");
    expect(packageScriptName("npm run -s build")).toBe("build");
    expect(packageScriptName("npm run --if-present build")).toBe("build");
  });

  test("returns null for non-script shell commands", () => {
    expect(packageScriptName("vite build")).toBeNull();
    expect(packageScriptName("tsc && vite build")).toBeNull();
    expect(packageScriptName("")).toBeNull();
    // bare `pnpm build` shorthand is intentionally not treated as a known
    // script invocation — only the explicit `run` form is unambiguous.
    expect(packageScriptName("pnpm build")).toBeNull();
  });
});

describe("spa-with-resources warning", () => {
  test("warns when resource bindings are declared but the deploy is a static SPA", async () => {
    const warnSpy = vi.spyOn(consola, "warn").mockImplementation(() => undefined);
    writeFixture({
      "dist/index.html": "<html></html>",
    });

    const result = await prepareDeployBundle({
      cwd,
      resolved: baseConfig({ bindings: [{ type: "d1", name: "DB" }] }),
      skipBuild: true,
    });

    expect(result.effectiveRenderMode).toBe("spa");
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warned).toContain("env.DB");
    expect(warned).toContain("static SPA");
    warnSpy.mockRestore();
  });

  test("silent when a worker entry is present", async () => {
    const warnSpy = vi.spyOn(consola, "warn").mockImplementation(() => undefined);
    writeFixture({
      "dist/index.html": "<html></html>",
      "worker/index.ts":
        "export default { fetch() { return new Response('ok'); } };",
      // Stub the `creek` runtime so bundleWorker's wrapper resolves —
      // same trick as the vanilla-worker fixture above.
      "node_modules/creek/package.json": JSON.stringify({
        name: "creek",
        type: "module",
        main: "index.js",
      }),
      "node_modules/creek/index.js":
        "export const _runRequest = async (_e, _c, fn) => fn(); export const generateWsToken = async () => '';",
    });

    const result = await prepareDeployBundle({
      cwd,
      resolved: baseConfig({
        bindings: [{ type: "d1", name: "DB" }],
        workerEntry: "worker/index.ts",
      }),
      skipBuild: true,
    });

    expect(result.effectiveRenderMode).toBe("worker");
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warned).not.toContain("static SPA");
    warnSpy.mockRestore();
  });

  test("silent for a SPA with no resource bindings", async () => {
    const warnSpy = vi.spyOn(consola, "warn").mockImplementation(() => undefined);
    writeFixture({
      "dist/index.html": "<html></html>",
    });

    await prepareDeployBundle({ cwd, resolved: baseConfig(), skipBuild: true });

    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warned).not.toContain("static SPA");
    warnSpy.mockRestore();
  });
});
