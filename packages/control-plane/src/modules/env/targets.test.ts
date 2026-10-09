import { describe, it, expect, afterEach } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createLocalTestEnv,
  seedTestData,
  seedProject,
  type LocalTestEnv,
} from "../../local/test-env.js";
import { deployTargetFor, isEnvTarget, selectForTarget } from "./targets.js";

describe("deployTargetFor", () => {
  it("treats no branch and the production branch as production", () => {
    expect(deployTargetFor(undefined, "main")).toBe("production");
    expect(deployTargetFor(null, "main")).toBe("production");
    expect(deployTargetFor("", "main")).toBe("production");
    expect(deployTargetFor("main", "main")).toBe("production");
    expect(deployTargetFor("feature", "main")).toBe("preview");
    expect(deployTargetFor("main", "release")).toBe("preview");
  });
});

describe("isEnvTarget", () => {
  it("accepts exactly all, production and preview", () => {
    for (const t of ["all", "production", "preview"]) expect(isEnvTarget(t)).toBe(true);
    for (const t of ["", "Production", "development", "*", "constructor", 1, null, undefined]) {
      expect(isEnvTarget(t)).toBe(false);
    }
  });
});

describe("selectForTarget", () => {
  const rows = [
    { key: "STRIPE_KEY", target: "all", v: "default" },
    { key: "STRIPE_KEY", target: "production", v: "live" },
    { key: "STRIPE_KEY", target: "preview", v: "test" },
    { key: "ONLY_PROD", target: "production", v: "p" },
    { key: "ONLY_PREVIEW", target: "preview", v: "q" },
    { key: "SHARED", target: "all", v: "s" },
  ];
  const pick = (target: "production" | "preview", input = rows) =>
    Object.fromEntries(selectForTarget(input, target).map((r) => [r.key, r.v]));

  it("gives each deploy its own target's value, else the all value, and never the other target's", () => {
    expect(pick("production")).toEqual({ STRIPE_KEY: "live", ONLY_PROD: "p", SHARED: "s" });
    expect(pick("preview")).toEqual({ STRIPE_KEY: "test", ONLY_PREVIEW: "q", SHARED: "s" });
  });

  it("does not depend on row order", () => {
    expect(pick("production", [...rows].reverse())).toEqual(pick("production"));
    expect(pick("preview", [...rows].reverse())).toEqual(pick("preview"));
  });

  it("falls back to all when a key has no value for the deploy's target", () => {
    const onlyAll = [{ key: "K", target: "all", v: "a" }];
    expect(pick("production", onlyAll)).toEqual({ K: "a" });
    expect(pick("preview", onlyAll)).toEqual({ K: "a" });
  });
});

describe("migration 0013: environment_variable targets", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../../../drizzle");
  let t: LocalTestEnv;
  afterEach(() => t.cleanup());

  it("keeps every existing variable as 'all' and allows one value per target afterwards", () => {
    t = createLocalTestEnv({ applyMigrations: false });
    const db = t.db.db;
    const files = readdirSync(dir)
      .filter((f) => /^\d{4}.*\.sql$/.test(f))
      .sort();
    const at = files.indexOf("0013_env_var_targets.sql");
    expect(at).toBeGreaterThan(0);
    for (const f of files.slice(0, at)) db.exec(readFileSync(join(dir, f), "utf-8"));

    seedTestData(t);
    seedProject(t, "site", { id: "p" });
    db.exec(
      "INSERT INTO environment_variable (projectId, key, encryptedValue) VALUES ('p','A','enc-a'), ('p','B','enc-b')",
    );

    db.exec(readFileSync(join(dir, "0013_env_var_targets.sql"), "utf-8"));
    for (const f of files.slice(at + 1)) db.exec(readFileSync(join(dir, f), "utf-8"));

    expect(
      db.prepare("SELECT key, target, encryptedValue FROM environment_variable ORDER BY key").all(),
    ).toEqual([
      { key: "A", target: "all", encryptedValue: "enc-a" },
      { key: "B", target: "all", encryptedValue: "enc-b" },
    ]);
    db.exec(
      "INSERT INTO environment_variable (projectId, key, target, encryptedValue) VALUES ('p','A','production','enc-live')",
    );
    expect(() =>
      db.exec(
        "INSERT INTO environment_variable (projectId, key, target, encryptedValue) VALUES ('p','A','staging','x')",
      ),
    ).toThrow(/CHECK/);
    expect(() =>
      db.exec(
        "INSERT INTO environment_variable (projectId, key, target, encryptedValue) VALUES ('p','A','production','dup')",
      ),
    ).toThrow(/UNIQUE|PRIMARY/);
  });
});
