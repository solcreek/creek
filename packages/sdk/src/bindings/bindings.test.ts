import { describe, test, expect } from "vitest";
import {
  BINDING_NAMES,
  INTERNAL_VARS,
  PROVISIONABLE_RESOURCES,
} from "./index.js";

describe("BINDING_NAMES", () => {
  test("maps d1 -> DB", () => {
    expect(BINDING_NAMES.d1).toBe("DB");
  });

  test("maps r2 -> STORAGE", () => {
    expect(BINDING_NAMES.r2).toBe("STORAGE");
  });

  test("maps kv -> KV", () => {
    expect(BINDING_NAMES.kv).toBe("KV");
  });

  test("maps ai -> AI", () => {
    expect(BINDING_NAMES.ai).toBe("AI");
  });

  test("all provisionable resources have a binding name", () => {
    for (const type of PROVISIONABLE_RESOURCES) {
      expect(BINDING_NAMES[type]).toBeDefined();
      expect(typeof BINDING_NAMES[type]).toBe("string");
    }
  });
});

describe("INTERNAL_VARS", () => {
  test("has projectSlug", () => {
    expect(INTERNAL_VARS.projectSlug).toBe("CREEK_PROJECT_SLUG");
  });

  test("has realtimeUrl", () => {
    expect(INTERNAL_VARS.realtimeUrl).toBe("CREEK_REALTIME_URL");
  });

  test("has realtimeSecret", () => {
    expect(INTERNAL_VARS.realtimeSecret).toBe("CREEK_REALTIME_SECRET");
  });
});

describe("PROVISIONABLE_RESOURCES", () => {
  test("includes d1, r2, kv", () => {
    expect(PROVISIONABLE_RESOURCES).toContain("d1");
    expect(PROVISIONABLE_RESOURCES).toContain("r2");
    expect(PROVISIONABLE_RESOURCES).toContain("kv");
  });

  test("does not include ai (ai is account-level)", () => {
    expect(PROVISIONABLE_RESOURCES).not.toContain("ai");
  });
});
