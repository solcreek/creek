import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { applyData } from "../src/apply-data.js";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";

describe("applyData", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "creek-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes merged creek-data.json", () => {
    writeFileSync(join(dir, "creek-data.json"), "{}");

    applyData(dir, { title: "Hello" }, { title: "Default", tagline: "World" });

    const result = JSON.parse(readFileSync(join(dir, "creek-data.json"), "utf-8"));
    expect(result.title).toBe("Hello");
    expect(result.tagline).toBe("World");
  });

  it("user data overrides defaults", () => {
    writeFileSync(join(dir, "creek-data.json"), "{}");

    applyData(dir, { theme: "light" }, { theme: "dark", title: "App" });

    const result = JSON.parse(readFileSync(join(dir, "creek-data.json"), "utf-8"));
    expect(result.theme).toBe("light");
    expect(result.title).toBe("App");
  });

  it("updates creek.toml name", () => {
    writeFileSync(join(dir, "creek-data.json"), "{}");
    writeFileSync(join(dir, "creek.toml"), '[project]\nname = "old-name"\n');

    applyData(dir, { name: "new-name" }, {});

    const toml = readFileSync(join(dir, "creek.toml"), "utf-8");
    expect(toml).toContain('name = "new-name"');
    expect(toml).not.toContain("old-name");
  });

  it("updates package.json name", () => {
    writeFileSync(join(dir, "creek-data.json"), "{}");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "old" }));

    applyData(dir, { name: "new-name" }, {});

    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    expect(pkg.name).toBe("new-name");
  });

  it("handles missing creek.toml gracefully", () => {
    writeFileSync(join(dir, "creek-data.json"), "{}");

    expect(() => applyData(dir, { name: "test" }, {})).not.toThrow();
  });

  it("handles missing package.json gracefully", () => {
    writeFileSync(join(dir, "creek-data.json"), "{}");

    expect(() => applyData(dir, { name: "test" }, {})).not.toThrow();
  });
});
