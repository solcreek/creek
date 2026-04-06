import { describe, it, expect } from "vitest";
import { validateData } from "../src/validate.js";

const LANDING_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    title: { type: "string", default: "My Product" },
    tagline: { type: "string", default: "Ship faster with Creek" },
    theme: { type: "string", enum: ["light", "dark"], default: "dark" },
    accentColor: { type: "string", default: "#3b82f6" },
  },
};

describe("validateData", () => {
  it("passes valid data", () => {
    const result = validateData(LANDING_SCHEMA, { title: "Acme", theme: "light" });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("passes empty data (defaults applied)", () => {
    const result = validateData(LANDING_SCHEMA, {});
    expect(result.valid).toBe(true);
  });

  it("fails on invalid enum value", () => {
    const result = validateData(LANDING_SCHEMA, { theme: "invalid" });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].path).toBe("/theme");
  });

  it("fails on wrong type", () => {
    const result = validateData(LANDING_SCHEMA, { title: 123 });
    expect(result.valid).toBe(false);
    expect(result.errors[0].path).toBe("/title");
  });

  it("returns multiple errors with allErrors", () => {
    const result = validateData(LANDING_SCHEMA, {
      title: 123,
      theme: "invalid",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBe(2);
  });
});
