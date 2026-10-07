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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import consola from "consola";
import type { ResolvedConfig } from "@solcreek/sdk";
import {
  prepareDeployBundle,
  packageScriptName,
  collectWorkerModules,
  mergeFrameworkBindings,
} from "./prepare-bundle.js";
import { materializeVinextFixture } from "../../../sdk/src/framework/__fixtures__/vinext-cf-output/materialize.js";
import { buildNextjs } from "./nextjs.js";

// A real `next build` can't run here; tests that reach the Next.js build
// assert that it was called.
vi.mock("./nextjs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./nextjs.js")>()),
  buildNextjs: vi.fn(() => "next build --webpack"),
}));

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
    expect(result.mainModule).toBeNull();
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
    // The uploaded entry name, sent as manifest.mainModule.
    expect(result.mainModule).toBe("worker.js");

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
    // The uploaded entry name, sent as manifest.mainModule.
    expect(result.mainModule).toBe("worker.js");
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
    // The uploaded entry name, sent as manifest.mainModule.
    expect(result.mainModule).toBe("worker.js");
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

  test("Astro CF adapter — entry.mjs is sent as the main module", async () => {
    writeFixture({
      "package.json": JSON.stringify({ name: "astro-app", dependencies: { astro: "*" } }),
      "dist/server/entry.mjs": "export default { fetch() {} };",
      "dist/server/wrangler.json": "{}",
      "dist/server/_@astrojs-ssr-adapter.mjs": "export {};",
      "dist/client/favicon.svg": "<svg/>",
    });

    const result = await prepareDeployBundle({
      cwd,
      resolved: baseConfig({ framework: "astro" }),
      skipBuild: true,
    });

    expect(result.effectiveRenderMode).toBe("ssr");
    expect(Object.keys(result.serverFiles!).sort()).toEqual([
      "_@astrojs-ssr-adapter.mjs",
      "entry.mjs",
    ]);
    expect(result.mainModule).toBe("entry.mjs");
  });

  test("SSR framework output — no main module is declared, the servers keep guessing", async () => {
    writeFixture({
      "package.json": JSON.stringify({ name: "nuxt-app", dependencies: { nuxt: "*" } }),
      ".output/server/index.mjs": "export default {};",
      ".output/server/chunks/a.mjs": "export {};",
      ".output/public/index.html": "<html></html>",
    });

    const result = await prepareDeployBundle({
      cwd,
      resolved: baseConfig({ framework: "nuxt", buildOutput: ".output/public" }),
      skipBuild: true,
    });

    expect(result.serverFiles).toBeDefined();
    expect(result.mainModule).toBeNull();
  });

  test("Next.js adapter output — declares the entry the adapter recorded", async () => {
    writeFixture({
      "package.json": JSON.stringify({ name: "next-app", dependencies: { next: "16.2.3" } }),
      ".creek/adapter-output/manifest.json": JSON.stringify({
        entrypoint: "worker.js",
        serverFiles: ["worker.js"],
      }),
      ".creek/adapter-output/server/worker.js": "export default { fetch() {} };",
      ".creek/adapter-output/assets/favicon.ico": "x",
    });

    const result = await prepareDeployBundle({
      cwd,
      resolved: baseConfig({ framework: "nextjs", buildOutput: ".creek/adapter-output" }),
      skipBuild: true,
    });

    expect(Object.keys(result.serverFiles!)).toEqual(["worker.js"]);
    expect(result.mainModule).toBe("worker.js");
  });

  test("an empty [build] command does not skip the Next.js build", async () => {
    // The Next.js build ignores [build] command; skipping it would deploy
    // whatever adapter output a previous build left behind.
    writeFixture({
      "package.json": JSON.stringify({ name: "next-app", dependencies: { next: "16.2.3" } }),
      ".creek/adapter-output/manifest.json": JSON.stringify({ entrypoint: "worker.js" }),
      ".creek/adapter-output/server/worker.js": "export default { fetch() {} };",
      ".creek/adapter-output/assets/favicon.ico": "x",
    });
    vi.mocked(buildNextjs).mockClear();

    await prepareDeployBundle({
      cwd,
      resolved: baseConfig({
        framework: "nextjs",
        buildCommand: "",
        buildOutput: ".creek/adapter-output",
      }),
      skipBuild: false,
    });

    expect(buildNextjs).toHaveBeenCalledTimes(1);
  });

  test("buildRan names the build that ran, not [build] command", async () => {
    writeFixture({
      "package.json": JSON.stringify({ name: "next-app", dependencies: { next: "16.2.3" } }),
      ".creek/adapter-output/manifest.json": JSON.stringify({ entrypoint: "worker.js" }),
      ".creek/adapter-output/server/worker.js": "export default { fetch() {} };",
      ".creek/adapter-output/assets/favicon.ico": "x",
    });
    const next = await prepareDeployBundle({
      cwd,
      resolved: baseConfig({
        framework: "nextjs",
        buildCommand: "npm run build",
        buildOutput: ".creek/adapter-output",
      }),
      skipBuild: false,
    });
    expect(next.buildRan).toBe("next build --webpack");

    const skipped = await prepareDeployBundle({
      cwd,
      resolved: baseConfig({
        framework: "nextjs",
        buildCommand: "npm run build",
        buildOutput: ".creek/adapter-output",
      }),
      skipBuild: true,
    });
    expect(skipped.buildRan).toBeNull();
  });

  test("buildRan is the configured command when it runs, and null without a build script", async () => {
    writeFixture({
      "package.json": JSON.stringify({ name: "spa", dependencies: { vite: "*" } }),
      "dist/index.html": "<!doctype html>",
    });
    const ran = await prepareDeployBundle({
      cwd,
      resolved: baseConfig({ framework: "vite-react", buildCommand: "true" }),
      skipBuild: false,
    });
    expect(ran.buildRan).toBe("true");

    const missing = await prepareDeployBundle({
      cwd,
      resolved: baseConfig({ framework: "vite-react", buildCommand: "npm run build" }),
      skipBuild: false,
    });
    expect(missing.buildRan).toBeNull();
  });

  test("--skip-build says when the Next.js adapter output it deploys was built", async () => {
    writeFixture({
      "package.json": JSON.stringify({ name: "next-app", dependencies: { next: "16.2.3" } }),
      ".creek/adapter-output/manifest.json": JSON.stringify({ entrypoint: "worker.js" }),
      ".creek/adapter-output/server/worker.js": "export default { fetch() {} };",
      ".creek/adapter-output/assets/favicon.ico": "x",
    });
    const builtAt = new Date(Date.now() - 3 * 60 * 60 * 1000 - 5 * 60 * 1000);
    utimesSync(join(cwd, ".creek/adapter-output/manifest.json"), builtAt, builtAt);
    const infoSpy = vi.spyOn(consola, "info").mockImplementation(() => undefined);
    try {
      await prepareDeployBundle({
        cwd,
        resolved: baseConfig({ framework: "nextjs", buildOutput: ".creek/adapter-output" }),
        skipBuild: true,
      });
      const lines = infoSpy.mock.calls.map((c) => String(c[0]));
      expect(lines).toContain(
        `  --skip-build: deploying .creek/adapter-output, built 3 hours ago (${builtAt.toISOString().slice(0, 16)}Z)`,
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  test("Next.js adapter entry named like an inherited property is not declared", async () => {
    writeFixture({
      "package.json": JSON.stringify({ name: "next-app", dependencies: { next: "16.2.3" } }),
      ".creek/adapter-output/manifest.json": JSON.stringify({ entrypoint: "constructor" }),
      ".creek/adapter-output/server/worker.js": "export default { fetch() {} };",
      ".creek/adapter-output/assets/favicon.ico": "x",
    });

    const result = await prepareDeployBundle({
      cwd,
      resolved: baseConfig({ framework: "nextjs", buildOutput: ".creek/adapter-output" }),
      skipBuild: true,
    });

    expect(result.mainModule).toBeNull();
  });

  test("Next.js adapter output naming a file it didn't emit — leaves the servers to guess", async () => {
    writeFixture({
      "package.json": JSON.stringify({ name: "next-app", dependencies: { next: "16.2.3" } }),
      ".creek/adapter-output/manifest.json": JSON.stringify({ entrypoint: "server.js" }),
      ".creek/adapter-output/server/worker.js": "export default { fetch() {} };",
      ".creek/adapter-output/assets/favicon.ico": "x",
    });

    const result = await prepareDeployBundle({
      cwd,
      resolved: baseConfig({ framework: "nextjs", buildOutput: ".creek/adapter-output" }),
      skipBuild: true,
    });

    expect(result.serverFiles).toBeDefined();
    expect(result.mainModule).toBeNull();
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
      "dist/edge/_worker.mjs": "export default { fetch() { return new Response('w'); } };",
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

describe("prepareDeployBundle: code-split pre-bundled worker", () => {
  test("worker beside its assets uploads every chunk it imports, not only the entry", async () => {
    // Shape of `june build`: dist/worker.js + sibling chunks, assets in dist/assets.
    writeFixture({
      "package.json": JSON.stringify({ name: "split" }),
      "dist/worker.js":
        'import { a } from "./shared-1.js";\n' +
        'export default { async fetch() { const { b } = await import("./lazy-2.js"); return new Response(a + b); } };',
      "dist/shared-1.js": "export const a = 'a';",
      "dist/lazy-2.js": 'export { c as b } from "./nested/deep-3.js";',
      "dist/nested/deep-3.js": "export const c = 'c';",
      "dist/unreferenced-4.js": "export const unused = 1;",
      "dist/assets/index.html": "<!doctype html>",
      "dist/assets/_app/client.js": "console.log('client')",
    });

    const result = await prepareDeployBundle({
      cwd,
      resolved: baseConfig({ workerEntry: "dist/worker.js", buildOutput: "dist/assets" }),
      skipBuild: true,
    });

    expect(result.plan.worker.strategy).toBe("upload-asis");
    expect(Object.keys(result.serverFiles!).sort()).toEqual([
      "lazy-2.js",
      "nested/deep-3.js",
      "shared-1.js",
      "worker.js",
    ]);
    expect(result.fileList.sort()).toEqual(["_app/client.js", "index.html"]);
  });

  test("chunks of a worker inside the asset dir are modules, not public files", async () => {
    writeFixture({
      "package.json": JSON.stringify({ name: "inside", dependencies: { vite: "*" } }),
      "dist/index.html": "<!doctype html>",
      "dist/_worker.mjs":
        'import { x } from "./_chunks/x.mjs"; export default { fetch() { return new Response(x); } };',
      "dist/_chunks/x.mjs": "export const x = 'x';",
    });

    const result = await prepareDeployBundle({
      cwd,
      resolved: baseConfig({ framework: "vite-react", workerEntry: "dist/_worker.mjs" }),
      skipBuild: true,
    });

    expect(Object.keys(result.serverFiles!).sort()).toEqual(["_chunks/x.mjs", "worker.js"]);
    expect(result.fileList).toEqual(["index.html"]);
    expect(result.assets["_chunks/x.mjs"]).toBeUndefined();
  });
});

describe("collectWorkerModules", () => {
  test("collects non-JS modules the worker imports and does not scan them for imports", async () => {
    writeFixture({
      "dist/worker.js":
        'import config from "./config.json"; import wasm from "./lib/engine.wasm"; export default { fetch() { return new Response(config.name); } };',
      "dist/config.json": '{ "name": "import from \\"./not-a-module.js\\"" }',
      "dist/lib/engine.wasm": "\0asm",
    });

    const { files } = await collectWorkerModules(join(cwd, "dist/worker.js"));

    expect(Object.keys(files).sort()).toEqual(["config.json", "lib/engine.wasm", "worker.js"]);
  });

  test("fails on an import that leaves the worker's directory, even when the target is missing", async () => {
    writeFixture({
      "dist/worker.js":
        'import { x } from "../shared.js"; export default { fetch() { return new Response(x); } };',
    });

    await expect(collectWorkerModules(join(cwd, "dist/worker.js"))).rejects.toThrow(
      /imports "\.\.\/shared\.js", which is outside the worker's directory/,
    );
  });

  test("fails on a dynamic import whose chunk is missing instead of shipping it dangling", async () => {
    writeFixture({
      "dist/worker.js":
        'export default { async fetch() { const m = await import("./gone-1.js"); return new Response(m.x); } };',
    });

    await expect(collectWorkerModules(join(cwd, "dist/worker.js"))).rejects.toThrow(
      /imports "\.\/gone-1\.js", but .* does not exist/,
    );
  });
});

describe("collectWorkerModules: parsing and naming", () => {
  test("ignores import-looking text in comments and strings, and template-literal imports", async () => {
    writeFixture({
      "dist/worker.js": [
        '// import("./in-comment.js")',
        'const help = \'use import("./in-string.js") or import x from "./also-string.js"\';',
        'import { a } from "./real.js";',
        "export default { async fetch() { const m = await import(`./tpl-${a}.js`); return new Response(help + m); } };",
      ].join("\n"),
      "dist/real.js": "export const a = 'a';",
    });

    const { files } = await collectWorkerModules(join(cwd, "dist/worker.js"));

    expect(Object.keys(files).sort()).toEqual(["real.js", "worker.js"]);
  });

  test("rejects a chunk that would share the entry's upload name worker.js", async () => {
    writeFixture({
      "dist/_worker.mjs":
        'import { x } from "./worker.js"; export default { fetch() { return new Response(x); } };',
      "dist/worker.js": "export const x = 'chunk';",
    });

    await expect(collectWorkerModules(join(cwd, "dist/_worker.mjs"))).rejects.toThrow(
      /_worker\.mjs imports a module also named worker\.js/,
    );
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
      "worker/index.ts": "export default { fetch() { return new Response('ok'); } };",
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

// vinext — the fixture is the Build Output of a real create-vinext-app
// project (see packages/sdk/src/framework/__fixtures__/vinext-cf-output).
describe("prepareDeployBundle — vinext Build Output", () => {
  const VINEXT_CONFIG = {
    framework: "vinext" as const,
    buildOutput: ".cloudflare/output/v0/workers/default/assets",
  };
  const vinextPkg = JSON.stringify({
    name: "demo",
    dependencies: { vinext: "^1.0.1", "@vinext/cloudflare": "^1.0.1" },
    scripts: { build: "vite build" },
  });

  function exitSpy() {
    return vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
  }

  test("deploys bundle/ as the worker in worker mode, assets/ as Static Assets", async () => {
    writeFixture({ "package.json": vinextPkg });
    materializeVinextFixture(cwd);

    const result = await prepareDeployBundle({
      cwd,
      resolved: baseConfig(VINEXT_CONFIG),
      skipBuild: true,
    });

    // worker mode is what attaches env.ASSETS, which vinext reads.
    expect(result.effectiveRenderMode).toBe("worker");
    expect(result.effectiveEntrypoint).toBe("index.js");
    expect(result.mainModule).toBe("index.js");
    expect(result.vinext?.compatibilityDate).toBe("2026-10-07");
    expect(result.vinext?.compatibilityFlags).toEqual(["nodejs_compat"]);

    const modules = Object.keys(result.serverFiles!);
    expect(modules).toContain("index.js");
    expect(modules).toContain("ssr/index.js");
    expect(modules).toContain("_next/static/page-DTzNL5qX.js");
    expect(modules.some((m) => m.endsWith(".css"))).toBe(false);
    // Build metadata JSON is not a module (and the upload API rejects it).
    expect(modules.some((m) => m.endsWith(".json"))).toBe(false);
    // Nothing from the assets dir leaks into the worker, and vice versa.
    expect(modules.some((m) => m.startsWith("assets/"))).toBe(false);

    expect(result.fileList).toContain("_next/static/chunks/index-CnPdVYHA.js");
    expect(result.fileList).toContain("_headers");
    expect(result.fileList).toContain("vinext-client-entry-manifest.json");
  });

  test("honours vinext's .assetsignore: .vite/manifest.json is not published", async () => {
    writeFixture({ "package.json": vinextPkg });
    materializeVinextFixture(cwd);

    const result = await prepareDeployBundle({
      cwd,
      resolved: baseConfig(VINEXT_CONFIG),
      skipBuild: true,
    });

    expect(result.fileList).not.toContain(".vite/manifest.json");
    expect(result.fileList).not.toContain(".assetsignore");
    expect(result.assets[".vite/manifest.json"]).toBeUndefined();
  });

  test("a module named like a guessed entry beside index.js deploys: the entry is declared", async () => {
    writeFixture({ "package.json": vinextPkg });
    materializeVinextFixture(cwd);
    writeFixture({
      ".cloudflare/output/v0/workers/default/bundle/worker.js": "export default {};",
    });

    const result = await prepareDeployBundle({
      cwd,
      resolved: baseConfig(VINEXT_CONFIG),
      skipBuild: true,
    });

    expect(Object.keys(result.serverFiles!)).toContain("worker.js");
    expect(result.mainModule).toBe("index.js");
  });

  test("a leftover wrangler main (legacy setup) does not override the Build Output", async () => {
    writeFixture({ "package.json": vinextPkg });
    materializeVinextFixture(cwd);

    const result = await prepareDeployBundle({
      cwd,
      resolved: baseConfig({ ...VINEXT_CONFIG, workerEntry: "vinext/server/fetch-handler" }),
      skipBuild: true,
    });

    expect(result.effectiveRenderMode).toBe("worker");
    expect(result.effectiveEntrypoint).toBe("index.js");
  });

  test("carries the static-assets cache's runWorkerFirst paths", async () => {
    writeFixture({ "package.json": vinextPkg });
    materializeVinextFixture(cwd, { workerConfig: "run-worker-first" });

    const result = await prepareDeployBundle({
      cwd,
      resolved: baseConfig(VINEXT_CONFIG),
      skipBuild: true,
    });

    expect(result.vinext?.runWorkerFirst).toEqual(["/_vinext/static-cache/*"]);
  });

  test("no Build Output → exits with the vinext init hint", async () => {
    const errSpy = vi.spyOn(consola, "error").mockImplementation(() => undefined);
    const spy = exitSpy();
    writeFixture({ "package.json": vinextPkg, "dist/server/BUILD_ID": "x" });

    await expect(
      prepareDeployBundle({ cwd, resolved: baseConfig(VINEXT_CONFIG), skipBuild: true }),
    ).rejects.toThrow("process.exit called");
    expect(spy).toHaveBeenCalledWith(1);
    expect(String(errSpy.mock.calls[0]?.[0])).toMatch(/vinext init --platform=cloudflare/);
    spy.mockRestore();
    errSpy.mockRestore();
  });

  test("a binding Creek can't provide (images) stops the deploy", async () => {
    const errSpy = vi.spyOn(consola, "error").mockImplementation(() => undefined);
    const spy = exitSpy();
    writeFixture({ "package.json": vinextPkg });
    materializeVinextFixture(cwd, { workerConfig: "bindings" });

    await expect(
      prepareDeployBundle({ cwd, resolved: baseConfig(VINEXT_CONFIG), skipBuild: true }),
    ).rejects.toThrow("process.exit called");
    expect(String(errSpy.mock.calls[0]?.[0])).toMatch(/IMAGES \(images\)/);
    spy.mockRestore();
    errSpy.mockRestore();
  });
});

describe("mergeFrameworkBindings", () => {
  const vinext = {
    bindings: [
      { type: "kv" as const, name: "VINEXT_KV_CACHE" },
      { type: "d1" as const, name: "DB" },
    ],
  } as unknown as Parameters<typeof mergeFrameworkBindings>[1];

  test("adds the Build Output's bindings under their own names", () => {
    expect(mergeFrameworkBindings([{ type: "kv", bindingName: "CACHE" }], vinext)).toEqual([
      { type: "kv", bindingName: "CACHE" },
      { type: "kv", bindingName: "VINEXT_KV_CACHE" },
      { type: "d1", bindingName: "DB" },
    ]);
  });

  test("config wins on a name conflict", () => {
    expect(mergeFrameworkBindings([{ type: "r2", bindingName: "DB" }], vinext)).toEqual([
      { type: "r2", bindingName: "DB" },
      { type: "kv", bindingName: "VINEXT_KV_CACHE" },
    ]);
  });

  test("no framework output → unchanged", () => {
    const base = [{ type: "kv" as const, bindingName: "CACHE" }];
    expect(mergeFrameworkBindings(base, null)).toBe(base);
  });
});
