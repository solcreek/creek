import { describe, it, expect } from "vitest";
import { TEMPLATES } from "../src/templates.js";

describe("TEMPLATES", () => {
  it("has at least 20 templates", () => {
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(20);
  });

  it("every template has name, description, type, capabilities", () => {
    const validTypes = ["site", "app", "workflow", "connector", "developer"];
    for (const t of TEMPLATES) {
      expect(typeof t.name).toBe("string");
      expect(t.name.length).toBeGreaterThan(0);
      expect(typeof t.description).toBe("string");
      expect(validTypes).toContain(t.type);
      expect(Array.isArray(t.capabilities)).toBe(true);
    }
  });

  it("names are unique", () => {
    const names = TEMPLATES.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("includes blank and landing", () => {
    const names = TEMPLATES.map((t) => t.name);
    expect(names).toContain("blank");
    expect(names).toContain("landing");
  });

  it("capabilities are valid strings", () => {
    const validCaps = ["database", "cache", "storage", "ai", "realtime", "cron", "queue", "email", "ftp"];
    for (const t of TEMPLATES) {
      for (const cap of t.capabilities) {
        expect(validCaps).toContain(cap);
      }
    }
  });

  it("has templates in every type", () => {
    const types = new Set(TEMPLATES.map((t) => t.type));
    expect(types).toContain("site");
    expect(types).toContain("app");
    expect(types).toContain("workflow");
    expect(types).toContain("connector");
    expect(types).toContain("developer");
  });

  it("workflow and connector templates have trigger field", () => {
    const validTriggers = ["webhook", "email", "cron", "http"];
    for (const t of TEMPLATES) {
      if (t.type === "workflow" || t.type === "connector") {
        expect(t.trigger).toBeDefined();
        expect(validTriggers).toContain(t.trigger);
      }
    }
  });

  it("sites have no trigger", () => {
    for (const t of TEMPLATES) {
      if (t.type === "site") {
        expect(t.trigger).toBeUndefined();
      }
    }
  });

  it("wave 1 templates exist", () => {
    const names = TEMPLATES.map((t) => t.name);
    expect(names).toContain("form");
    expect(names).toContain("chatbot");
    expect(names).toContain("dashboard");
    expect(names).toContain("invoice-processor");
  });
});
