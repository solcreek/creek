import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePrismaD1, hasAdapterOutput, readAdapterCompat } from "./nextjs";

describe("ensurePrismaD1", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "creek-prisma-d1-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("is a no-op for a project that doesn't use the better-sqlite3 Prisma adapter", () => {
    // No node_modules at all → @prisma/adapter-better-sqlite3 is unresolvable,
    // so it must NOT attempt an install (no .creek created). This is the
    // safety guard: non-Prisma projects never pay for the on-demand dep.
    expect(() => ensurePrismaD1(cwd)).not.toThrow();
    expect(existsSync(join(cwd, ".creek", "package.json"))).toBe(false);
  });
});

describe("readAdapterCompat", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "creek-adapter-compat-"));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  function writeManifest(obj: unknown): void {
    mkdirSync(join(cwd, ".creek/adapter-output"), { recursive: true });
    writeFileSync(join(cwd, ".creek/adapter-output/manifest.json"), JSON.stringify(obj));
  }

  it("returns null when no adapter output exists", () => {
    expect(readAdapterCompat(cwd)).toBeNull();
    expect(hasAdapterOutput(cwd)).toBe(false);
  });

  it("reads the compat date and flags the adapter recorded", () => {
    writeManifest({ compatibilityDate: "2026-03-28", compatibilityFlags: ["nodejs_compat"] });
    expect(readAdapterCompat(cwd)).toEqual({
      compatibilityDate: "2026-03-28",
      compatibilityFlags: ["nodejs_compat"],
    });
  });

  it("returns null on unparseable manifest (caller falls back)", () => {
    mkdirSync(join(cwd, ".creek/adapter-output"), { recursive: true });
    writeFileSync(join(cwd, ".creek/adapter-output/manifest.json"), "not-json");
    expect(readAdapterCompat(cwd)).toBeNull();
  });

  it("omits fields that are missing or the wrong type", () => {
    writeManifest({ compatibilityFlags: "nodejs_compat" }); // wrong type
    expect(readAdapterCompat(cwd)).toEqual({});
  });
});
