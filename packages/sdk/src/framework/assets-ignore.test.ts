import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyAssetsIgnore, parseAssetsIgnore } from "./assets-ignore.js";

const vinextIgnore = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "__fixtures__/vinext-cf-output/assetsignore.txt"),
  "utf-8",
);

describe("parseAssetsIgnore", () => {
  test("vinext's generated file drops .vite/ and itself, keeps the rest", () => {
    const ignored = parseAssetsIgnore(vinextIgnore);
    expect(ignored(".vite/manifest.json")).toBe(true);
    expect(ignored("/.vite/manifest.json")).toBe(true);
    expect(ignored(".assetsignore")).toBe(true);
    expect(ignored("_headers")).toBe(false);
    expect(ignored("_next/static/chunks/index-CnPdVYHA.js")).toBe(false);
    expect(ignored("vinext-client-entry-manifest.json")).toBe(false);
  });

  test("unanchored names match at any depth", () => {
    const ignored = parseAssetsIgnore("*.map\n");
    expect(ignored("app.js.map")).toBe(true);
    expect(ignored("a/b/app.js.map")).toBe(true);
    expect(ignored("app.js")).toBe(false);
  });

  test("a leading or inner slash anchors to the root", () => {
    const ignored = parseAssetsIgnore("/secret.txt\nprivate/data\n");
    expect(ignored("secret.txt")).toBe(true);
    expect(ignored("nested/secret.txt")).toBe(false);
    expect(ignored("private/data/x.json")).toBe(true);
    expect(ignored("other/private/data/x.json")).toBe(false);
  });

  test("a trailing slash matches directories only", () => {
    const ignored = parseAssetsIgnore("build/\n");
    expect(ignored("build/a.js")).toBe(true);
    expect(ignored("build")).toBe(false);
  });

  test("** spans directories", () => {
    const ignored = parseAssetsIgnore("docs/**/*.md\n");
    expect(ignored("docs/a.md")).toBe(true);
    expect(ignored("docs/x/y/a.md")).toBe(true);
    expect(ignored("docs/a.html")).toBe(false);
  });

  test("negation re-includes, last match wins", () => {
    const ignored = parseAssetsIgnore("*.json\n!keep.json\n");
    expect(ignored("drop.json")).toBe(true);
    expect(ignored("keep.json")).toBe(false);
  });

  test("a file negation can't re-include a file under an ignored directory", () => {
    const ignored = parseAssetsIgnore("private/\n!*.json\n");
    expect(ignored("private/data.json")).toBe(true);
    expect(ignored("private/nested/data.json")).toBe(true);
    expect(ignored("public.json")).toBe(false);
  });

  test("re-including the directory itself re-includes its files", () => {
    const ignored = parseAssetsIgnore("private/\n!private/\n");
    expect(ignored("private/data.json")).toBe(false);
  });

  test("comments and blank lines are ignored; regex metacharacters are literal", () => {
    const ignored = parseAssetsIgnore("# comment\n\nfile(1).txt\n");
    expect(ignored("file(1).txt")).toBe(true);
    expect(ignored("# comment")).toBe(false);
  });
});

describe("applyAssetsIgnore", () => {
  test("filters assets and the file list", () => {
    const result = applyAssetsIgnore(
      vinextIgnore,
      { ".assetsignore": "a", ".vite/manifest.json": "b", _headers: "c" },
      [".assetsignore", ".vite/manifest.json", "_headers"],
    );
    expect(result.assets).toEqual({ _headers: "c" });
    expect(result.fileList).toEqual(["_headers"]);
  });

  test("no .assetsignore → unchanged", () => {
    const assets = { ".vite/manifest.json": "b" };
    const fileList = [".vite/manifest.json"];
    expect(applyAssetsIgnore(null, assets, fileList)).toEqual({ assets, fileList });
  });
});
