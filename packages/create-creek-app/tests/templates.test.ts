import { describe, it, expect } from "vitest";
import { TEMPLATES } from "../src/templates.js";

/**
 * The catalog is the contract: every listed template must map to a
 * real example in the monorepo. Tests enforce structural invariants
 * (uniqueness, valid shapes) but don't pin specific names —
 * templates are expected to grow over time.
 */
describe("TEMPLATES", () => {
  it("has at least one template", () => {
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(1);
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

  it("names are path-safe (letters, digits, hyphens)", () => {
    // They're appended as a path segment to TEMPLATE_REPO in fetch.ts.
    // Anything URL-unsafe breaks giget downloads.
    for (const t of TEMPLATES) {
      expect(t.name).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    }
  });

  it("capabilities reference known platform primitives", () => {
    const validCaps = [
      "database", "cache", "storage", "ai",
      "realtime", "cron", "queue", "email", "ftp",
    ];
    for (const t of TEMPLATES) {
      for (const cap of t.capabilities) {
        expect(validCaps).toContain(cap);
      }
    }
  });

  it("workflow and connector templates declare a trigger", () => {
    const validTriggers = ["webhook", "email", "cron", "http"];
    for (const t of TEMPLATES) {
      if (t.type === "workflow" || t.type === "connector") {
        expect(t.trigger).toBeDefined();
        expect(validTriggers).toContain(t.trigger);
      }
    }
  });

  it("sites have no trigger (static + no event hook)", () => {
    for (const t of TEMPLATES) {
      if (t.type === "site") {
        expect(t.trigger).toBeUndefined();
      }
    }
  });

  it("vite-react-drizzle is listed (flagship portable full-stack example)", () => {
    // Pin this one specifically — it's the reference template for
    // the dual-driver pattern. If someone removes it, they should
    // think twice.
    const names = TEMPLATES.map((t) => t.name);
    expect(names).toContain("vite-react-drizzle");
  });
});
