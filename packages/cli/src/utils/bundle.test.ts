import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectAssets } from "./bundle.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "creek-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("collectAssets", () => {
  // The collector behind both framework builds and `creek deploy <dir>`
  // (deployDirectory), so exclusions apply to every upload.
  test("honours .assetsignore at the root, and never uploads the file itself", () => {
    mkdirSync(join(tmpDir, "private", "nested"), { recursive: true });
    writeFileSync(join(tmpDir, ".assetsignore"), "private/\n!*.json\n");
    writeFileSync(join(tmpDir, "index.html"), "root");
    writeFileSync(join(tmpDir, "public.json"), "{}");
    writeFileSync(join(tmpDir, "private", "data.json"), "{}");
    writeFileSync(join(tmpDir, "private", "nested", "data.json"), "{}");

    const result = collectAssets(tmpDir);
    expect(result.fileList.sort()).toEqual(["index.html", "public.json"]);
    expect(Object.keys(result.assets).sort()).toEqual(["index.html", "public.json"]);
  });

  test("an .assetsignore below the root is an ordinary file", () => {
    mkdirSync(join(tmpDir, "sub"), { recursive: true });
    writeFileSync(join(tmpDir, "sub", ".assetsignore"), "*\n");
    writeFileSync(join(tmpDir, "sub", "a.js"), "x");

    expect(collectAssets(tmpDir).fileList).toContain(join("sub", "a.js"));
  });

  test("collects flat files", () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>hi</h1>");
    writeFileSync(join(tmpDir, "style.css"), "body {}");

    const result = collectAssets(tmpDir);
    expect(result.fileList).toHaveLength(2);
    expect(result.fileList).toContain("index.html");
    expect(result.fileList).toContain("style.css");
    expect(result.assets["index.html"]).toBe(Buffer.from("<h1>hi</h1>").toString("base64"));
  });

  test("collects nested directories", () => {
    mkdirSync(join(tmpDir, "assets"), { recursive: true });
    writeFileSync(join(tmpDir, "index.html"), "root");
    writeFileSync(join(tmpDir, "assets", "app.js"), "console.log()");

    const result = collectAssets(tmpDir);
    expect(result.fileList).toContain("index.html");
    expect(result.fileList).toContain(join("assets", "app.js"));
  });

  test("returns empty for empty directory", () => {
    const result = collectAssets(tmpDir);
    expect(result.fileList).toHaveLength(0);
    expect(Object.keys(result.assets)).toHaveLength(0);
  });

  test("encodes binary files as base64", () => {
    const binary = Buffer.from([0x00, 0xff, 0x80, 0x42]);
    writeFileSync(join(tmpDir, "image.bin"), binary);

    const result = collectAssets(tmpDir);
    expect(result.assets["image.bin"]).toBe(binary.toString("base64"));
  });

  test("excludes creek.toml and wrangler.* from deployed assets", () => {
    writeFileSync(join(tmpDir, "index.html"), "<h1>hi</h1>");
    writeFileSync(join(tmpDir, "creek.toml"), "[project]");
    writeFileSync(join(tmpDir, "wrangler.toml"), "name = 'x'");
    writeFileSync(join(tmpDir, "wrangler.json"), "{}");
    writeFileSync(join(tmpDir, "wrangler.jsonc"), "{}");

    const result = collectAssets(tmpDir);
    expect(result.fileList).toContain("index.html");
    expect(result.fileList).not.toContain("creek.toml");
    expect(result.fileList).not.toContain("wrangler.toml");
    expect(result.fileList).not.toContain("wrangler.json");
    expect(result.fileList).not.toContain("wrangler.jsonc");
  });
});
