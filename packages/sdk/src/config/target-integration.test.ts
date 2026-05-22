import { describe, test, expect } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveConfig } from "./resolved-config.js";

function makeTestDir(creekToml: string): string {
  const dir = join(tmpdir(), `creek-target-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "creek.toml"), creekToml);
  // Need package.json for framework detection fallback
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test", scripts: { build: "echo ok" } }));
  return dir;
}

function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}

describe("target integration: resolveConfig → target", () => {
  test("v1 creek.toml (boolean resources) → target cf", () => {
    const dir = makeTestDir(`
      [project]
      name = "legacy-app"
      [resources]
      database = true
      cache = true
    `);
    try {
      const config = resolveConfig(dir);
      expect(config.target).toBe("cf");
      expect(config.bindings.some(b => b.type === "d1")).toBe(true);
      expect(config.bindings.some(b => b.type === "kv")).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  test("v2 creek.toml with postgres → target creekd", () => {
    const dir = makeTestDir(`
      [project]
      name = "new-app"
      [database]
      driver = "postgres"
      [cache]
      driver = "redis"
    `);
    try {
      const config = resolveConfig(dir);
      expect(config.target).toBe("creekd");
      expect(config.bindings).toHaveLength(0); // creekd doesn't use CF bindings
    } finally {
      cleanup(dir);
    }
  });

  test("v2 creek.toml with sqlite → target cf", () => {
    const dir = makeTestDir(`
      [project]
      name = "edge-app"
      [database]
      driver = "sqlite"
      [cache]
      driver = "sqlite"
    `);
    try {
      const config = resolveConfig(dir);
      expect(config.target).toBe("cf");
      expect(config.bindings.some(b => b.type === "d1")).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  test("explicit target overrides auto-detection", () => {
    const dir = makeTestDir(`
      [project]
      name = "explicit-app"
      target = "creekd"
      [database]
      driver = "sqlite"
    `);
    try {
      const config = resolveConfig(dir);
      expect(config.target).toBe("creekd");
    } finally {
      cleanup(dir);
    }
  });

  test("incompatible combo throws at resolve time", () => {
    const dir = makeTestDir(`
      [project]
      name = "bad-app"
      target = "cf"
      [database]
      driver = "postgres"
    `);
    try {
      expect(() => resolveConfig(dir)).toThrow(/Incompatible/);
    } finally {
      cleanup(dir);
    }
  });

  test("v2 with s3 storage maps to R2 on cf target", () => {
    const dir = makeTestDir(`
      [project]
      name = "storage-app"
      [database]
      driver = "sqlite"
      [storage]
      driver = "s3"
    `);
    try {
      const config = resolveConfig(dir);
      expect(config.target).toBe("cf");
      expect(config.bindings.some(b => b.type === "r2")).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  test("v2 with mysql → target creekd", () => {
    const dir = makeTestDir(`
      [project]
      name = "mysql-app"
      [database]
      driver = "mysql"
    `);
    try {
      const config = resolveConfig(dir);
      expect(config.target).toBe("creekd");
    } finally {
      cleanup(dir);
    }
  });

  test("wrangler.toml source always → target cf", () => {
    const dir = join(tmpdir(), `creek-wrangler-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "wrangler.toml"), `name = "wrangler-app"\nmain = "src/index.ts"`);
    try {
      const config = resolveConfig(dir);
      expect(config.target).toBe("cf");
      expect(config.source).toBe("wrangler.toml");
    } finally {
      cleanup(dir);
    }
  });

  test("mixed v1 + v2 sections: v2 database takes precedence for target", () => {
    const dir = makeTestDir(`
      [project]
      name = "mixed-app"
      [resources]
      database = true
      [database]
      driver = "postgres"
    `);
    try {
      const config = resolveConfig(dir);
      expect(config.target).toBe("creekd");
    } finally {
      cleanup(dir);
    }
  });
});
