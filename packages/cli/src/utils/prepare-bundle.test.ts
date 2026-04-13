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

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedConfig } from "@solcreek/sdk";
import { prepareDeployBundle } from "./prepare-bundle.js";

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

import { vi } from "vitest";
