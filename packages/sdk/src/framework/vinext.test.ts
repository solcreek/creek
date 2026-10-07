import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectVinextServerFiles,
  detectVinextBuild,
  parseVinextWorkerConfig,
  vinextBuildScript,
} from "./vinext.js";
import { materializeVinextFixture } from "./__fixtures__/vinext-cf-output/materialize.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__/vinext-cf-output");
const fixtureConfig = (name: string) =>
  JSON.parse(readFileSync(join(fixtureDir, name), "utf-8")) as unknown;

describe("parseVinextWorkerConfig — captured create-vinext-app output", () => {
  test("default project: entry, compat, KV cache binding; ASSETS left to worker mode", () => {
    expect(parseVinextWorkerConfig(fixtureConfig("worker.config.json"))).toEqual({
      serverDir: ".cloudflare/output/v0/workers/default/bundle",
      assetsDir: ".cloudflare/output/v0/workers/default/assets",
      mainModule: "index.js",
      runWorkerFirst: null,
      compatibilityDate: "2026-10-07",
      compatibilityFlags: ["nodejs_compat"],
      bindings: [{ type: "kv", name: "VINEXT_KV_CACHE" }],
      vars: {},
      secrets: [],
      unsupportedBindings: [],
    });
  });

  test("with d1 / r2 / ai / text / images: keeps names, text → vars, images unsupported", () => {
    const build = parseVinextWorkerConfig(fixtureConfig("worker.config.bindings.json"));
    expect(build.bindings).toEqual([
      { type: "kv", name: "VINEXT_KV_CACHE" },
      { type: "d1", name: "DB" },
      { type: "r2", name: "FILES" },
      { type: "ai", name: "AI" },
    ]);
    expect(build.vars).toEqual({ GREETING: "hello" });
    expect(build.unsupportedBindings).toEqual([{ type: "images", name: "IMAGES" }]);
  });
});

describe("parseVinextWorkerConfig — runWorkerFirst", () => {
  test("static-assets cache: keeps the private cache path worker-first", () => {
    const build = parseVinextWorkerConfig(fixtureConfig("worker.config.run-worker-first.json"));
    expect(build.runWorkerFirst).toEqual(["/_vinext/static-cache/*"]);
  });

  test("boolean is kept; anything else is ignored", () => {
    const base = { manifest: { mainModule: "index.js" } };
    expect(
      parseVinextWorkerConfig({ ...base, assets: { runWorkerFirst: true } }).runWorkerFirst,
    ).toBe(true);
    expect(
      parseVinextWorkerConfig({ ...base, assets: { runWorkerFirst: [1] } }).runWorkerFirst,
    ).toBeNull();
  });
});

describe("parseVinextWorkerConfig — edge cases", () => {
  const base = { manifest: { mainModule: "index.js" } };

  test("secrets are listed, not provisioned", () => {
    const build = parseVinextWorkerConfig({ ...base, env: { API_KEY: { type: "secret" } } });
    expect(build.secrets).toEqual(["API_KEY"]);
    expect(build.bindings).toEqual([]);
  });

  test("Workers AI under a name other than AI is unsupported", () => {
    const build = parseVinextWorkerConfig({ ...base, env: { MODEL: { type: "ai" } } });
    expect(build.bindings).toEqual([]);
    expect(build.unsupportedBindings).toEqual([{ type: "ai", name: "MODEL" }]);
  });

  test("an assets binding not named ASSETS is unsupported", () => {
    const build = parseVinextWorkerConfig({ ...base, env: { STATIC: { type: "assets" } } });
    expect(build.unsupportedBindings).toEqual([{ type: "assets", name: "STATIC" }]);
  });

  test("service bindings and Durable Objects are unsupported", () => {
    const build = parseVinextWorkerConfig({
      ...base,
      env: {
        RESPONSE_STORE: { type: "worker", worker: "cache" },
        ROOM: { type: "durableObject" },
      },
    });
    expect(build.unsupportedBindings).toEqual([
      { type: "worker", name: "RESPONSE_STORE" },
      { type: "durableObject", name: "ROOM" },
    ]);
  });

  test("missing compat → null date, no flags", () => {
    const build = parseVinextWorkerConfig(base);
    expect(build.compatibilityDate).toBeNull();
    expect(build.compatibilityFlags).toEqual([]);
  });

  test("no manifest.mainModule → throws", () => {
    expect(() => parseVinextWorkerConfig({ manifest: {} })).toThrow(/manifest.mainModule/);
  });

  test("not an object → throws", () => {
    expect(() => parseVinextWorkerConfig([])).toThrow(/not a JSON object/);
  });
});

describe("detectVinextBuild", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "creek-vinext-"));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test("reads the materialized Build Output", () => {
    materializeVinextFixture(cwd);
    expect(detectVinextBuild(cwd)?.mainModule).toBe("index.js");
  });

  test("returns null when not built (or built with the legacy Wrangler setup)", () => {
    mkdirSync(join(cwd, "dist/server"), { recursive: true });
    writeFileSync(join(cwd, "dist/server/BUILD_ID"), "x");
    expect(detectVinextBuild(cwd)).toBeNull();
  });

  test("throws on malformed worker.config.json", () => {
    const dir = join(cwd, ".cloudflare/output/v0/workers/default");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "worker.config.json"), "{nope");
    expect(() => detectVinextBuild(cwd)).toThrow(/not valid JSON/);
  });
});

describe("collectVinextServerFiles", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "creek-vinext-modules-"));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });
  const bundle = (files: string[]) => {
    const dir = join(cwd, ".cloudflare/output/v0/workers/default/bundle");
    for (const f of files) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), "export {};");
    }
  };
  const build = (mainModule: string) => parseVinextWorkerConfig({ manifest: { mainModule } });

  test("captured build: every JS module, no JSON metadata, entry index.js", () => {
    materializeVinextFixture(cwd);
    const modules = Object.keys(collectVinextServerFiles(cwd, build("index.js")));
    expect(modules).toContain("index.js");
    expect(modules).toContain("ssr/index.js");
    expect(modules.some((m) => m.endsWith(".json"))).toBe(false);
  });

  test("JSON metadata doesn't count toward the module limit", () => {
    bundle([
      "index.js",
      ...Array.from({ length: 499 }, (_, i) => `chunk-${i}.js`),
      ".vite/manifest.json",
      "vinext-server.json",
    ]);
    expect(Object.keys(collectVinextServerFiles(cwd, build("index.js")))).toHaveLength(500);
  });

  test("more than 500 actual modules still throws", () => {
    bundle(["index.js", ...Array.from({ length: 500 }, (_, i) => `chunk-${i}.js`)]);
    expect(() => collectVinextServerFiles(cwd, build("index.js"))).toThrow(/more than 500/);
  });

  test("throws when the entry is missing", () => {
    bundle(["ssr/index.js", "chunk.js"]);
    expect(() => collectVinextServerFiles(cwd, build("index.js"))).toThrow(/entry index.js/);
  });

  test("a module with a guessable name beside the entry is fine: the entry is declared", () => {
    bundle(["custom.js", "index.js", "worker.js"]);
    expect(Object.keys(collectVinextServerFiles(cwd, build("custom.js"))).sort()).toEqual([
      "custom.js",
      "index.js",
      "worker.js",
    ]);
  });
});

describe("vinextBuildScript", () => {
  test("create-vinext-app project → build", () => {
    expect(vinextBuildScript({ scripts: { build: "vite build" } })).toBe("build");
  });

  test("migrated with vinext init → build:vinext (build is still next build)", () => {
    expect(
      vinextBuildScript({ scripts: { build: "next build", "build:vinext": "vite build" } }),
    ).toBe("build:vinext");
  });

  test("no scripts → build", () => {
    expect(vinextBuildScript({})).toBe("build");
  });
});
