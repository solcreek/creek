import { describe, it, expect } from "vitest";
import { extractAssetMetafiles } from "./asset-metafiles";

const enc = (s: string): ArrayBuffer => {
  const bytes = new TextEncoder().encode(s);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

const HEADERS_RULE = `/_next/static/*\n  Cache-Control: public, max-age=31536000, immutable\n`;

describe("extractAssetMetafiles", () => {
  it("returns an empty config when the project ships neither file", () => {
    const m = extractAssetMetafiles({ "/index.html": enc("<html>") });
    expect(m.config).toEqual({});
    expect(m.isMetafile("/index.html")).toBe(false);
  });

  it("lifts a root _headers into the config", () => {
    const m = extractAssetMetafiles({ "/_headers": enc(HEADERS_RULE) });
    expect(m.config._headers).toBe(HEADERS_RULE);
  });

  it("lifts _redirects too", () => {
    const m = extractAssetMetafiles({ "/_redirects": enc("/old /new 301\n") });
    expect(m.config._redirects).toBe("/old /new 301\n");
  });

  it("accepts keys with or without a leading slash", () => {
    // The two deploy paths build this map differently; both must work.
    const withSlash = extractAssetMetafiles({ "/_headers": enc("a") });
    const without = extractAssetMetafiles({ _headers: enc("a") });
    expect(withSlash.config._headers).toBe("a");
    expect(without.config._headers).toBe("a");
    expect(without.isMetafile("_headers")).toBe(true);
    expect(without.isMetafile("/_headers")).toBe(true);
  });

  it("marks metafiles so they stay out of the upload manifest", () => {
    // Only lifting the content would leave the file publicly fetchable —
    // which is exactly what production did: GET /_headers returned 200.
    const m = extractAssetMetafiles({
      "/_headers": enc(HEADERS_RULE),
      "/_redirects": enc("/a /b 301"),
      "/index.html": enc("<html>"),
    });
    expect(m.isMetafile("/_headers")).toBe(true);
    expect(m.isMetafile("/_redirects")).toBe(true);
    expect(m.isMetafile("/index.html")).toBe(false);
  });

  it("treats a nested _headers as an ordinary asset", () => {
    // Wrangler's ignore patterns are `/_headers` — root-anchored. A file
    // at docs/_headers is content, not configuration.
    const m = extractAssetMetafiles({ "/docs/_headers": enc("x") });
    expect(m.config).toEqual({});
    expect(m.isMetafile("/docs/_headers")).toBe(false);
  });

  it("decodes as UTF-8", () => {
    // The reporting tenant's _headers is commented in Traditional Chinese;
    // a latin-1 decode would corrupt the rules we send to the API.
    const body = "# 靜態資源快取設定\n/_next/static/*\n  Cache-Control: immutable\n";
    const m = extractAssetMetafiles({ "/_headers": enc(body) });
    expect(m.config._headers).toBe(body);
  });

  it("handles both metafiles at once", () => {
    const m = extractAssetMetafiles({
      "/_headers": enc("h"),
      "/_redirects": enc("r"),
    });
    expect(m.config).toEqual({ _headers: "h", _redirects: "r" });
  });
});
