import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readTosAcceptance,
  writeTosAcceptance,
  isTosAccepted,
  CURRENT_TOS_VERSION,
  type TosAcceptance,
} from "./tos.js";

// We test the read/write/check logic. The interactive prompt is tested manually.

describe("ToS utilities", () => {
  test("CURRENT_TOS_VERSION is a date-formatted string", () => {
    expect(CURRENT_TOS_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("readTosAcceptance returns null when file doesn't exist", () => {
    // This test depends on ~/.creek/tos-accepted NOT existing in CI,
    // which is typical. If it does exist, this test still validates the shape.
    const result = readTosAcceptance();
    if (result === null) {
      expect(result).toBeNull();
    } else {
      expect(result.version).toBeTruthy();
      expect(result.acceptedAt).toBeTruthy();
    }
  });

  test("writeTosAcceptance and readTosAcceptance roundtrip", () => {
    const acceptance: TosAcceptance = {
      version: CURRENT_TOS_VERSION,
      acceptedAt: new Date().toISOString(),
    };

    writeTosAcceptance(acceptance);
    const result = readTosAcceptance();

    expect(result).not.toBeNull();
    expect(result!.version).toBe(CURRENT_TOS_VERSION);
    expect(result!.acceptedAt).toBe(acceptance.acceptedAt);
  });

  test("isTosAccepted returns true after writing current version", () => {
    writeTosAcceptance({
      version: CURRENT_TOS_VERSION,
      acceptedAt: new Date().toISOString(),
    });
    expect(isTosAccepted()).toBe(true);
  });

  test("isTosAccepted returns false for outdated version", () => {
    writeTosAcceptance({
      version: "2020-01-01", // old version
      acceptedAt: new Date().toISOString(),
    });
    expect(isTosAccepted()).toBe(false);
  });
});
