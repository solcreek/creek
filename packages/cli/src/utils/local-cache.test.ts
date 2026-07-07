import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  localCachePath,
  readLocalCache,
  writeLocalCache,
  recordLastDeploy,
  cachedResourceVersion,
  LOCAL_SCHEMA_VERSION,
  type LastDeploy,
} from "./local-cache.js";

function makeProject(): string {
  const dir = join(tmpdir(), "creek-local-test-" + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  return dir;
}

let project: string;
beforeEach(() => {
  project = makeProject();
});
afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

describe("localCachePath", () => {
  it("resolves to <project>/.creek/local.json", () => {
    expect(localCachePath("/x/y")).toBe("/x/y/.creek/local.json");
  });
});

describe("readLocalCache", () => {
  it("returns empty file when missing", () => {
    expect(readLocalCache(project)).toEqual({ schemaVersion: LOCAL_SCHEMA_VERSION });
  });

  it("reads back the canonical shape", () => {
    mkdirSync(join(project, ".creek"));
    const want = {
      schemaVersion: 1,
      lastDeploy: {
        appId: "x",
        host: "h",
        resourceVersion: "42",
        generation: 7,
        at: "2026-05-24T00:00:00Z",
      },
    };
    writeFileSync(join(project, ".creek", "local.json"), JSON.stringify(want));
    expect(readLocalCache(project)).toEqual(want);
  });

  it("rejects unknown schemaVersion", () => {
    mkdirSync(join(project, ".creek"));
    writeFileSync(join(project, ".creek", "local.json"), JSON.stringify({ schemaVersion: 99 }));
    expect(() => readLocalCache(project)).toThrow(/unsupported schemaVersion 99/);
  });

  it("rejects missing schemaVersion", () => {
    mkdirSync(join(project, ".creek"));
    writeFileSync(join(project, ".creek", "local.json"), JSON.stringify({}));
    expect(() => readLocalCache(project)).toThrow(/missing schemaVersion/);
  });
});

describe("writeLocalCache", () => {
  it("writes atomically — no tmp leftover on success", () => {
    writeLocalCache(project, { schemaVersion: LOCAL_SCHEMA_VERSION });
    const path = localCachePath(project);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(path + ".tmp")).toBe(false);
  });

  it("creates the .creek/ parent dir", () => {
    expect(existsSync(join(project, ".creek"))).toBe(false);
    writeLocalCache(project, { schemaVersion: LOCAL_SCHEMA_VERSION });
    expect(existsSync(join(project, ".creek"))).toBe(true);
  });

  it("rejects schemaVersion mismatch in input", () => {
    expect(() => writeLocalCache(project, { schemaVersion: 99 })).toThrow(/schemaVersion/);
  });
});

describe("recordLastDeploy", () => {
  const sample: LastDeploy = {
    appId: "a",
    host: "h",
    resourceVersion: "1",
    generation: 1,
    at: "2026-05-24T00:00:00Z",
  };

  it("creates the file when absent", () => {
    recordLastDeploy(project, sample);
    expect(readLocalCache(project).lastDeploy).toEqual(sample);
  });

  it("overwrites prior lastDeploy", () => {
    recordLastDeploy(project, sample);
    const next: LastDeploy = { ...sample, resourceVersion: "2", generation: 2 };
    recordLastDeploy(project, next);
    expect(readLocalCache(project).lastDeploy).toEqual(next);
  });

  it("preserves other top-level fields on update", () => {
    // Future-proofing: when the schema grows new top-level fields,
    // recording lastDeploy must not clobber them.
    writeLocalCache(project, { schemaVersion: LOCAL_SCHEMA_VERSION });
    const raw = JSON.parse(readFileSync(localCachePath(project), "utf-8"));
    raw.future = "preserved-please";
    writeFileSync(localCachePath(project), JSON.stringify(raw));

    recordLastDeploy(project, sample);
    const after = JSON.parse(readFileSync(localCachePath(project), "utf-8"));
    expect(after.future).toBe("preserved-please");
    expect(after.lastDeploy).toEqual(sample);
  });
});

describe("cachedResourceVersion", () => {
  const last: LastDeploy = {
    appId: "myapp",
    host: "prod",
    resourceVersion: "42",
    generation: 1,
    at: "t",
  };

  it("returns rv when appId + host match", () => {
    recordLastDeploy(project, last);
    expect(cachedResourceVersion(project, "myapp", "prod")).toBe("42");
  });

  it("returns undefined when appId differs", () => {
    recordLastDeploy(project, last);
    expect(cachedResourceVersion(project, "otherapp", "prod")).toBeUndefined();
  });

  it("returns undefined when host differs (multi-host switch invalidates cache)", () => {
    recordLastDeploy(project, last);
    expect(cachedResourceVersion(project, "myapp", "staging")).toBeUndefined();
  });

  it("returns undefined when cache empty", () => {
    expect(cachedResourceVersion(project, "myapp", "prod")).toBeUndefined();
  });

  it("returns undefined when cache file is corrupt (does not throw)", () => {
    mkdirSync(join(project, ".creek"));
    writeFileSync(join(project, ".creek", "local.json"), "not-json-at-all");
    expect(cachedResourceVersion(project, "myapp", "prod")).toBeUndefined();
  });
});
