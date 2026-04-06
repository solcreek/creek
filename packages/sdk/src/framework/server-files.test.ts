import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getSSRServerDir,
  collectServerFiles,
  isPreBundledFramework,
} from "./server-files.js";

// --- getSSRServerDir ---

describe("getSSRServerDir", () => {
  test("nuxt → .output/server", () => {
    expect(getSSRServerDir("nuxt")).toBe(".output/server");
  });

  test("solidstart → .output/server", () => {
    expect(getSSRServerDir("solidstart")).toBe(".output/server");
  });

  test("nextjs → .open-next/server-functions/default", () => {
    expect(getSSRServerDir("nextjs")).toBe(".open-next/server-functions/default");
  });

  test("sveltekit → .svelte-kit/output/server", () => {
    expect(getSSRServerDir("sveltekit")).toBe(".svelte-kit/output/server");
  });

  test("react-router → build/server", () => {
    expect(getSSRServerDir("react-router")).toBe("build/server");
  });

  test("tanstack-start → dist/server", () => {
    expect(getSSRServerDir("tanstack-start")).toBe("dist/server");
  });

  test("SPA frameworks return null", () => {
    expect(getSSRServerDir("vite-react")).toBeNull();
    expect(getSSRServerDir("vite-vue")).toBeNull();
    expect(getSSRServerDir("vite-svelte")).toBeNull();
    expect(getSSRServerDir("vite-solid")).toBeNull();
  });

  test("null framework returns null", () => {
    expect(getSSRServerDir(null)).toBeNull();
  });
});

// --- isPreBundledFramework ---

describe("isPreBundledFramework", () => {
  test("true for SSR frameworks", () => {
    expect(isPreBundledFramework("nuxt")).toBe(true);
    expect(isPreBundledFramework("sveltekit")).toBe(true);
    expect(isPreBundledFramework("solidstart")).toBe(true);
    expect(isPreBundledFramework("nextjs")).toBe(true);
    expect(isPreBundledFramework("react-router")).toBe(true);
    expect(isPreBundledFramework("tanstack-start")).toBe(true);
  });

  test("false for SPA frameworks", () => {
    expect(isPreBundledFramework("vite-react")).toBe(false);
    expect(isPreBundledFramework("vite-vue")).toBe(false);
  });

  test("false for null", () => {
    expect(isPreBundledFramework(null)).toBe(false);
  });
});

// --- collectServerFiles ---

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "creek-server-files-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("collectServerFiles", () => {
  test("collects .mjs and .js files", () => {
    writeFileSync(join(tmpDir, "index.mjs"), "export default {}");
    writeFileSync(join(tmpDir, "timing.js"), "module.exports = {}");

    const files = collectServerFiles(tmpDir);
    expect(Object.keys(files)).toHaveLength(2);
    expect(files["index.mjs"]).toBeInstanceOf(Buffer);
    expect(files["timing.js"]).toBeInstanceOf(Buffer);
  });

  test("collects files in subdirectories", () => {
    mkdirSync(join(tmpDir, "chunks"), { recursive: true });
    writeFileSync(join(tmpDir, "index.mjs"), "main");
    writeFileSync(join(tmpDir, "chunks", "app.mjs"), "chunk");

    const files = collectServerFiles(tmpDir);
    expect(Object.keys(files)).toContain("index.mjs");
    expect(Object.keys(files)).toContain(join("chunks", "app.mjs"));
  });

  test("skips .map files", () => {
    writeFileSync(join(tmpDir, "index.mjs"), "code");
    writeFileSync(join(tmpDir, "index.mjs.map"), "sourcemap");
    writeFileSync(join(tmpDir, "bundle.js.map"), "sourcemap");

    const files = collectServerFiles(tmpDir);
    expect(Object.keys(files)).toEqual(["index.mjs"]);
  });

  test("skips node_modules directory", () => {
    writeFileSync(join(tmpDir, "index.mjs"), "code");
    mkdirSync(join(tmpDir, "node_modules", "some-pkg"), { recursive: true });
    writeFileSync(join(tmpDir, "node_modules", "some-pkg", "index.js"), "dep");

    const files = collectServerFiles(tmpDir);
    expect(Object.keys(files)).toEqual(["index.mjs"]);
  });

  test("respects maxFiles limit", () => {
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(tmpDir, `file-${i}.mjs`), `content-${i}`);
    }

    const files = collectServerFiles(tmpDir, { maxFiles: 3 });
    expect(Object.keys(files).length).toBeLessThanOrEqual(3);
  });

  test("returns empty object for non-existent directory", () => {
    const files = collectServerFiles("/nonexistent/path");
    expect(files).toEqual({});
  });

  test("returns empty object for empty directory", () => {
    const files = collectServerFiles(tmpDir);
    expect(files).toEqual({});
  });

  test("returns Buffer content that matches file content", () => {
    const content = "export default { handler() {} }";
    writeFileSync(join(tmpDir, "server.mjs"), content);

    const files = collectServerFiles(tmpDir);
    expect(files["server.mjs"].toString("utf-8")).toBe(content);
  });

  test("handles deeply nested directory structure", () => {
    mkdirSync(join(tmpDir, "chunks", "_", "locales"), { recursive: true });
    writeFileSync(join(tmpDir, "index.mjs"), "main");
    writeFileSync(join(tmpDir, "chunks", "_", "locales", "en.mjs"), "locale");
    writeFileSync(join(tmpDir, "chunks", "_", "locales", "en.mjs.map"), "map");

    const files = collectServerFiles(tmpDir);
    expect(Object.keys(files)).toContain("index.mjs");
    expect(Object.keys(files)).toContain(join("chunks", "_", "locales", "en.mjs"));
    // .map file should be skipped
    expect(Object.keys(files)).not.toContain(join("chunks", "_", "locales", "en.mjs.map"));
  });
});
