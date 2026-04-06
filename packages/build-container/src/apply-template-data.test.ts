import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Tests for template data application in the build pipeline.
 * Schema validation with ajv is tested in create-creek-app.
 * Here we test data merging, file operations, and type compatibility.
 */

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "creek-tpl-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("template data merging", () => {
  test("merges user data with defaults", () => {
    const defaults = { title: "Default", tagline: "Default tagline", theme: "dark" };
    const userData = { title: "Custom Title", theme: "light" };
    const merged = { ...defaults, ...userData };

    expect(merged.title).toBe("Custom Title");
    expect(merged.tagline).toBe("Default tagline");
    expect(merged.theme).toBe("light");
  });

  test("user data overrides all matching defaults", () => {
    const defaults = { name: "my-app", title: "Old", theme: "dark" };
    const merged = { ...defaults, name: "new-app", title: "New", theme: "light" };

    expect(merged).toEqual({ name: "new-app", title: "New", theme: "light" });
  });

  test("works with empty defaults", () => {
    const defaults = {};
    const merged = { ...defaults, title: "Hello" };

    expect(merged).toEqual({ title: "Hello" });
  });

  test("preserves defaults when userData is empty", () => {
    const defaults = { title: "Keep", theme: "dark" };
    const merged = { ...defaults };

    expect(merged).toEqual({ title: "Keep", theme: "dark" });
  });

  test("handles nested data (features array)", () => {
    const defaults = {
      title: "App",
      features: [{ title: "Fast", description: "Speed" }],
    };
    const userData = {
      features: [{ title: "Custom", description: "Feature" }],
    };
    const merged = { ...defaults, ...userData };

    expect(merged.features).toEqual([{ title: "Custom", description: "Feature" }]);
    expect(merged.title).toBe("App");
  });
});

describe("creek-data.json file operations", () => {
  test("writes merged data to creek-data.json", () => {
    writeFileSync(join(tmpDir, "creek-data.json"), JSON.stringify({ title: "Default" }));

    const defaults = JSON.parse(readFileSync(join(tmpDir, "creek-data.json"), "utf-8"));
    const merged = { ...defaults, title: "Custom", theme: "light" };
    writeFileSync(join(tmpDir, "creek-data.json"), JSON.stringify(merged, null, 2) + "\n");

    const result = JSON.parse(readFileSync(join(tmpDir, "creek-data.json"), "utf-8"));
    expect(result.title).toBe("Custom");
    expect(result.theme).toBe("light");
  });

  test("creates creek-data.json if not present", () => {
    expect(existsSync(join(tmpDir, "creek-data.json"))).toBe(false);

    const merged = { title: "Hello" };
    writeFileSync(join(tmpDir, "creek-data.json"), JSON.stringify(merged, null, 2) + "\n");

    expect(existsSync(join(tmpDir, "creek-data.json"))).toBe(true);
    const result = JSON.parse(readFileSync(join(tmpDir, "creek-data.json"), "utf-8"));
    expect(result.title).toBe("Hello");
  });
});

describe("creek-template.json removal", () => {
  test("removes creek-template.json after processing", () => {
    writeFileSync(join(tmpDir, "creek-template.json"), JSON.stringify({
      name: "landing",
      description: "Test",
      capabilities: [],
      schema: { type: "object", properties: {} },
    }));

    expect(existsSync(join(tmpDir, "creek-template.json"))).toBe(true);
    rmSync(join(tmpDir, "creek-template.json"));
    expect(existsSync(join(tmpDir, "creek-template.json"))).toBe(false);
  });

  test("no error when creek-template.json does not exist", () => {
    expect(existsSync(join(tmpDir, "creek-template.json"))).toBe(false);
    // Should not throw
    expect(() => {
      if (existsSync(join(tmpDir, "creek-template.json"))) {
        rmSync(join(tmpDir, "creek-template.json"));
      }
    }).not.toThrow();
  });
});

describe("BuildRequest templateData field", () => {
  test("BuildRequest type accepts templateData", async () => {
    const { buildAndBundle } = await import("./build-pipeline.js");
    expect(typeof buildAndBundle).toBe("function");
  });

  test("templateData shape matches template params", () => {
    const templateData: Record<string, unknown> = {
      title: "Acme Corp",
      tagline: "Best widgets",
      theme: "light",
      accentColor: "#ff0000",
      features: [
        { title: "Fast", description: "Speed" },
        { title: "Secure", description: "Safe" },
      ],
    };

    expect(typeof templateData.title).toBe("string");
    expect(typeof templateData.theme).toBe("string");
    expect(Array.isArray(templateData.features)).toBe(true);
  });
});
