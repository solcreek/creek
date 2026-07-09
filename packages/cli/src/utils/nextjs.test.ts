import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ADAPTER_MIN_VERSION,
  ADAPTER_PKG,
  ADAPTER_VERSION,
  adapterVersionAt,
  ensurePrismaD1,
  hasAdapterOutput,
  readAdapterCompat,
  resolveAdapterPath,
  semverGte,
} from "./nextjs";

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

describe("semverGte", () => {
  it("compares major, then minor, then patch", () => {
    expect(semverGte("0.2.17", "0.2.17")).toBe(true); // equal
    expect(semverGte("0.2.18", "0.2.17")).toBe(true); // patch newer
    expect(semverGte("0.2.16", "0.2.17")).toBe(false); // patch older
    expect(semverGte("0.3.0", "0.2.17")).toBe(true); // minor newer
    expect(semverGte("0.2.0", "0.2.17")).toBe(false); // minor older
    expect(semverGte("1.0.0", "0.2.17")).toBe(true); // major newer
    expect(semverGte("0.2.14", "0.2.17")).toBe(false); // the customer's pinned devDep
  });

  it("compares on the release core, ignoring prerelease/build metadata", () => {
    // A Next canary of a qualifying release must not fall to the legacy path:
    // without stripping, Number("4-canary") is NaN and NaN >= 3 is false.
    expect(semverGte("16.2.4-canary.1", "16.2.3")).toBe(true); // canary of a newer patch
    expect(semverGte("16.2.3-rc.0", "16.2.3")).toBe(true); // prerelease of the threshold counts
    expect(semverGte("16.1.0-canary.2", "16.2.3")).toBe(false); // older minor, suffix or not
    expect(semverGte("0.2.17+build.5", "0.2.17")).toBe(true); // build metadata ignored
    expect(semverGte("16", "16.2.3")).toBe(false); // missing components default to 0 → 16.0.0
  });
});

/**
 * Build a minimal but resolvable @solcreek/adapter-creek install under a given
 * node_modules dir, at a given version. `createRequire(...).resolve()` needs a
 * package.json with a `main` that points at an existing file; `adapterVersionAt`
 * then reads the version from that same package.json.
 */
function fakeAdapter(nodeModulesDir: string, version: string): string {
  const dir = join(nodeModulesDir, "@solcreek", "adapter-creek");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: ADAPTER_PKG, version, main: "index.js" }),
  );
  writeFileSync(join(dir, "index.js"), "module.exports = {};");
  return join(dir, "index.js");
}

describe("adapterVersionAt", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "creek-adapter-ver-"));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("reads the version from the package.json above the entry", () => {
    const entry = fakeAdapter(join(cwd, "node_modules"), "0.2.16");
    expect(adapterVersionAt(entry)).toBe("0.2.16");
  });

  it("returns null when the enclosing package is not the adapter", () => {
    const dir = join(cwd, "node_modules", "other-pkg");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "other-pkg", version: "1.0.0" }),
    );
    writeFileSync(join(dir, "index.js"), "");
    expect(adapterVersionAt(join(dir, "index.js"))).toBeNull();
  });
});

describe("resolveAdapterPath (adapter cache floor)", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "creek-adapter-resolve-"));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("reuses a cached copy at or above the floor", () => {
    fakeAdapter(join(cwd, ".creek", "node_modules"), "0.2.17");
    const resolved = resolveAdapterPath(cwd, ADAPTER_MIN_VERSION);
    expect(resolved).not.toBeNull();
    expect(resolved).toContain(join(".creek", "node_modules", "@solcreek", "adapter-creek"));
  });

  it("rejects a cached .creek copy below the floor so the deploy reinstalls", () => {
    // 0.2.16 has the "PrismaD1 is not a constructor" externalization bug.
    fakeAdapter(join(cwd, ".creek", "node_modules"), "0.2.16");
    // Below the floor → not reused (caller then force-reinstalls the fixed build).
    expect(resolveAdapterPath(cwd, ADAPTER_MIN_VERSION)).toBeNull();
    // Without a floor the same stale copy IS found (proves the floor is doing the work).
    expect(resolveAdapterPath(cwd)).not.toBeNull();
  });

  it("rejects a pinned project devDep below the floor (the customer's exact case)", () => {
    // Customer pinned @solcreek/adapter-creek: 0.2.14 as a direct devDep, which
    // resolveAdapterPath tries BEFORE .creek. Under the old 0.2.14 floor this
    // resolved and shadowed the fix; the 0.2.17 floor must reject it.
    fakeAdapter(join(cwd, "node_modules"), "0.2.14");
    expect(resolveAdapterPath(cwd, ADAPTER_MIN_VERSION)).toBeNull();
    // The old floor would have (wrongly) reused it — regression guard.
    expect(resolveAdapterPath(cwd, "0.2.14")).not.toBeNull();
  });

  it("prefers the project node_modules copy over .creek when both pass the floor", () => {
    fakeAdapter(join(cwd, "node_modules"), "0.2.17");
    fakeAdapter(join(cwd, ".creek", "node_modules"), "0.2.18");
    const resolved = resolveAdapterPath(cwd, ADAPTER_MIN_VERSION);
    // node_modules is tried before .creek in the base order.
    expect(resolved).toContain(join("node_modules", "@solcreek", "adapter-creek"));
    expect(resolved).not.toContain(".creek");
  });

  it("returns null when nothing is installed", () => {
    expect(resolveAdapterPath(cwd, ADAPTER_MIN_VERSION)).toBeNull();
  });
});

describe("adapter version constants stay in lockstep", () => {
  it("the install range's floor equals ADAPTER_MIN_VERSION", () => {
    // The reject-then-reinstall only upgrades if the install range EXCLUDES the
    // rejected copy. If ADAPTER_VERSION's floor drifts below ADAPTER_MIN_VERSION,
    // a rejected cache could be reinstalled at the SAME stale version, looping
    // into the legacy fallback. Keep them pinned to the same version.
    expect(ADAPTER_VERSION).toBe(`^${ADAPTER_MIN_VERSION}`);
  });

  it("a fresh install of ADAPTER_VERSION would satisfy the floor", () => {
    // The lowest version ADAPTER_VERSION can resolve to is its own floor.
    const rangeFloor = ADAPTER_VERSION.replace(/^[\^~]/, "");
    expect(semverGte(rangeFloor, ADAPTER_MIN_VERSION)).toBe(true);
  });
});
