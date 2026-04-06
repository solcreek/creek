import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectPackageManager } from "./git-clone.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "creek-pm-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("detectPackageManager", () => {
  test("returns pnpm when pnpm-lock.yaml exists", () => {
    writeFileSync(join(tmpDir, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    writeFileSync(join(tmpDir, "package.json"), "{}");
    expect(detectPackageManager(tmpDir)).toBe("pnpm");
  });

  test("returns yarn when yarn.lock exists", () => {
    writeFileSync(join(tmpDir, "yarn.lock"), "# yarn lockfile\n");
    expect(detectPackageManager(tmpDir)).toBe("yarn");
  });

  test("returns bun when bun.lockb exists", () => {
    writeFileSync(join(tmpDir, "bun.lockb"), "");
    expect(detectPackageManager(tmpDir)).toBe("bun");
  });

  test("returns bun when bun.lock exists", () => {
    writeFileSync(join(tmpDir, "bun.lock"), "");
    expect(detectPackageManager(tmpDir)).toBe("bun");
  });

  test("returns npm when package-lock.json exists", () => {
    writeFileSync(join(tmpDir, "package-lock.json"), "{}");
    expect(detectPackageManager(tmpDir)).toBe("npm");
  });

  test("returns npm as fallback when no lock file", () => {
    expect(detectPackageManager(tmpDir)).toBe("npm");
  });

  test("prefers pnpm over npm when both lock files exist", () => {
    writeFileSync(join(tmpDir, "pnpm-lock.yaml"), "");
    writeFileSync(join(tmpDir, "package-lock.json"), "{}");
    expect(detectPackageManager(tmpDir)).toBe("pnpm");
  });
});
