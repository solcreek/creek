/**
 * Table-driven tests per rule. Each test builds a minimal
 * DoctorContext, runs one rule, asserts the finding(s).
 *
 * Guidance: when adding a new rule, add a test ROW here first that
 * fails, then make the rule pass. This is the place to document
 * intended false-negative cases (scenarios the rule should NOT
 * flag).
 */

import { describe, test, expect } from "vitest";
import { rules, collectFindings } from "./rules.js";
import { runDoctor } from "./runner.js";
import type { DoctorContext, PackageJson } from "./types.js";
import type { ResolvedConfig } from "../config/resolved-config.js";

function buildCtx(overrides: Partial<DoctorContext> = {}): DoctorContext {
  return {
    cwd: "/fake/project",
    resolved: null,
    packageJson: null,
    creekTomlRaw: null,
    fileExists: () => false,
    allDeps: {},
    ...overrides,
  };
}

function resolvedConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    source: "creek.toml",
    projectName: "test-app",
    framework: null,
    buildCommand: "",
    buildOutput: "dist",
    workerEntry: null,
    bindings: [],
    unsupportedBindings: [],
    vars: {},
    compatibilityDate: null,
    compatibilityFlags: [],
    cron: [],
    queue: false,
    ...overrides,
  };
}

function pkg(deps: Record<string, string> = {}, devDeps: Record<string, string> = {}): PackageJson {
  return { dependencies: deps, devDependencies: devDeps };
}

// ─── CK-NO-CONFIG ────────────────────────────────────────────────────────

describe("CK-NO-CONFIG", () => {
  test("fires when resolved is null", () => {
    const findings = rules.CK_NO_CONFIG(buildCtx());
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: "CK-NO-CONFIG",
      severity: "error",
    });
  });

  test("silent when resolved is present", () => {
    const ctx = buildCtx({ resolved: resolvedConfig() });
    expect(rules.CK_NO_CONFIG(ctx)).toEqual([]);
  });
});

// ─── CK-RESOURCES-KEYS ───────────────────────────────────────────────────

describe("CK-RESOURCES-KEYS", () => {
  test("fires on d1 = true", () => {
    const ctx = buildCtx({
      creekTomlRaw: `[project]\nname = "x"\n\n[resources]\nd1 = true\n`,
    });
    const findings = rules.CK_RESOURCES_KEYS(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("CK-RESOURCES-KEYS");
    expect(findings[0].fix).toContain("d1 → database");
  });

  test("fires on all three CF keys at once", () => {
    const ctx = buildCtx({
      creekTomlRaw: `[resources]\nd1 = true\nkv = false\nr2 = true\n`,
    });
    const findings = rules.CK_RESOURCES_KEYS(ctx);
    expect(findings).toHaveLength(1);
    const fix = findings[0].fix;
    expect(fix).toContain("d1 → database");
    expect(fix).toContain("kv → cache");
    expect(fix).toContain("r2 → storage");
  });

  test("silent on correct semantic keys", () => {
    const ctx = buildCtx({
      creekTomlRaw: `[resources]\ndatabase = true\ncache = false\n`,
    });
    expect(rules.CK_RESOURCES_KEYS(ctx)).toEqual([]);
  });

  test("silent when there's no [resources] section at all", () => {
    const ctx = buildCtx({
      creekTomlRaw: `[project]\nname = "x"\n`,
    });
    expect(rules.CK_RESOURCES_KEYS(ctx)).toEqual([]);
  });

  test("silent when the token 'd1' appears in project name but NOT under [resources]", () => {
    // False-positive guard: the rule scopes to the [resources] block.
    const ctx = buildCtx({
      creekTomlRaw: `[project]\nname = "my-d1-app"\n\n[resources]\ndatabase = true\n`,
    });
    expect(rules.CK_RESOURCES_KEYS(ctx)).toEqual([]);
  });
});

// ─── CK-WORKER-MISSING ──────────────────────────────────────────────────

describe("CK-WORKER-MISSING", () => {
  test("fires when workerEntry set but file absent", () => {
    const ctx = buildCtx({
      resolved: resolvedConfig({ workerEntry: "worker/index.ts" }),
      fileExists: () => false,
    });
    const findings = rules.CK_WORKER_MISSING(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("CK-WORKER-MISSING");
    expect(findings[0].title).toContain("worker/index.ts");
  });

  test("silent when workerEntry exists", () => {
    const ctx = buildCtx({
      resolved: resolvedConfig({ workerEntry: "worker/index.ts" }),
      fileExists: (p) => p === "worker/index.ts",
    });
    expect(rules.CK_WORKER_MISSING(ctx)).toEqual([]);
  });

  test("silent when no workerEntry declared at all", () => {
    const ctx = buildCtx({ resolved: resolvedConfig() });
    expect(rules.CK_WORKER_MISSING(ctx)).toEqual([]);
  });
});

// ─── CK-SYNC-SQLITE ──────────────────────────────────────────────────────

describe("CK-SYNC-SQLITE", () => {
  test("fires as WARN when better-sqlite3 is in production deps without an ORM", () => {
    const ctx = buildCtx({
      allDeps: { "better-sqlite3": "^11.0.0" },
      packageJson: pkg({ "better-sqlite3": "^11.0.0" }),
    });
    const findings = rules.CK_SYNC_SQLITE(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("CK-SYNC-SQLITE");
    expect(findings[0].severity).toBe("warn");
  });

  test("fires as INFO when better-sqlite3 is devDep-only AND Drizzle is also present (dual-driver pattern)", () => {
    const ctx = buildCtx({
      allDeps: {
        "better-sqlite3": "^11.0.0",
        "drizzle-orm": "^0.36.0",
      },
      packageJson: pkg({ "drizzle-orm": "^0.36.0" }, { "better-sqlite3": "^11.0.0" }),
    });
    const findings = rules.CK_SYNC_SQLITE(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("info");
    expect(findings[0].title).toContain("dual-driver");
  });

  test("WARN (not INFO) when ORM present but better-sqlite3 is in prod deps — suspicious", () => {
    const ctx = buildCtx({
      allDeps: {
        "better-sqlite3": "*",
        "drizzle-orm": "*",
      },
      packageJson: pkg({ "better-sqlite3": "*", "drizzle-orm": "*" }),
    });
    const findings = rules.CK_SYNC_SQLITE(ctx);
    expect(findings[0].severity).toBe("warn");
  });

  test("silent when only drizzle-orm is present (async-capable)", () => {
    const ctx = buildCtx({ allDeps: { "drizzle-orm": "^0.36.0" } });
    expect(rules.CK_SYNC_SQLITE(ctx)).toEqual([]);
  });
});

// ─── CK-PRISMA-SQLITE ───────────────────────────────────────────────────

describe("CK-PRISMA-SQLITE", () => {
  test("fires on @prisma/client", () => {
    const ctx = buildCtx({ allDeps: { "@prisma/client": "^5.0.0" } });
    expect(rules.CK_PRISMA_SQLITE(ctx)).toHaveLength(1);
  });

  test("fires on prisma devDep", () => {
    const ctx = buildCtx({ allDeps: { prisma: "^5.0.0" } });
    expect(rules.CK_PRISMA_SQLITE(ctx)).toHaveLength(1);
  });

  test("silent without prisma", () => {
    const ctx = buildCtx({ allDeps: { "drizzle-orm": "^0.36.0" } });
    expect(rules.CK_PRISMA_SQLITE(ctx)).toEqual([]);
  });
});

// ─── CK-RUNTIME-LOCKIN ──────────────────────────────────────────────────

describe("CK-RUNTIME-LOCKIN", () => {
  test("fires when 'creek' is in production dependencies", () => {
    const ctx = buildCtx({
      packageJson: pkg({ creek: "^0.4.13" }),
    });
    const findings = rules.CK_RUNTIME_LOCKIN(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("CK-RUNTIME-LOCKIN");
    expect(findings[0].severity).toBe("info");
  });

  test("silent when 'creek' is only in devDependencies (CLI use case)", () => {
    const ctx = buildCtx({
      packageJson: pkg({}, { creek: "^0.4.13" }),
    });
    expect(rules.CK_RUNTIME_LOCKIN(ctx)).toEqual([]);
  });

  test("lists all offending packages in one finding", () => {
    const ctx = buildCtx({
      packageJson: pkg({
        creek: "*",
        "@solcreek/runtime": "*",
      }),
    });
    const findings = rules.CK_RUNTIME_LOCKIN(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].detail).toContain("creek");
    expect(findings[0].detail).toContain("@solcreek/runtime");
  });
});

// ─── CK-CONFIG-OVERLAP ──────────────────────────────────────────────────

describe("CK-CONFIG-OVERLAP", () => {
  test("fires when both creek.toml and wrangler.jsonc exist", () => {
    const ctx = buildCtx({
      creekTomlRaw: `[project]\nname = "x"\n`,
      fileExists: (p) => p === "wrangler.jsonc",
    });
    expect(rules.CK_CONFIG_OVERLAP(ctx)).toHaveLength(1);
  });

  test("silent with only creek.toml", () => {
    const ctx = buildCtx({
      creekTomlRaw: `[project]\nname = "x"\n`,
      fileExists: () => false,
    });
    expect(rules.CK_CONFIG_OVERLAP(ctx)).toEqual([]);
  });

  test("silent with only wrangler.toml", () => {
    const ctx = buildCtx({
      fileExists: (p) => p === "wrangler.toml",
    });
    expect(rules.CK_CONFIG_OVERLAP(ctx)).toEqual([]);
  });
});

// ─── CK-NOTHING-TO-DEPLOY ───────────────────────────────────────────────

describe("CK-NOTHING-TO-DEPLOY", () => {
  test("fires when dist missing and no worker", () => {
    const ctx = buildCtx({
      resolved: resolvedConfig({ buildOutput: "dist", buildCommand: "npm run build" }),
      fileExists: () => false,
    });
    const findings = rules.CK_NOTHING_TO_DEPLOY(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("CK-NOTHING-TO-DEPLOY");
    expect(findings[0].fix).toContain("npm run build");
  });

  test("silent when dist exists", () => {
    const ctx = buildCtx({
      resolved: resolvedConfig(),
      fileExists: (p) => p === "dist",
    });
    expect(rules.CK_NOTHING_TO_DEPLOY(ctx)).toEqual([]);
  });

  test("silent when worker entry exists (even without dist)", () => {
    const ctx = buildCtx({
      resolved: resolvedConfig({ workerEntry: "worker/index.ts" }),
      fileExists: (p) => p === "worker/index.ts",
    });
    expect(rules.CK_NOTHING_TO_DEPLOY(ctx)).toEqual([]);
  });

  test("silent when resolved is null (CK-NO-CONFIG handles that)", () => {
    expect(rules.CK_NOTHING_TO_DEPLOY(buildCtx())).toEqual([]);
  });
});

// ─── runner ─────────────────────────────────────────────────────────────

describe("runDoctor", () => {
  test("aggregates all rules + reports ok=false on any error", () => {
    const report = runDoctor(buildCtx()); // no config → CK-NO-CONFIG error
    expect(report.ok).toBe(false);
    expect(report.summary.error).toBeGreaterThan(0);
  });

  test("ok=true when only warnings", () => {
    const report = runDoctor(
      buildCtx({
        resolved: resolvedConfig({
          buildCommand: "npm run build",
          workerEntry: "worker/index.ts",
        }),
        fileExists: (p) => p === "worker/index.ts",
        allDeps: { "better-sqlite3": "*" }, // warn
      }),
    );
    expect(report.ok).toBe(true);
    expect(report.summary.warn).toBeGreaterThan(0);
  });

  test("archetype detection — vanilla worker-only", () => {
    const report = runDoctor(
      buildCtx({
        resolved: resolvedConfig({ workerEntry: "worker/index.ts" }),
        fileExists: (p) => p === "worker/index.ts",
      }),
    );
    expect(report.archetype).toBe("worker-only");
  });

  test("archetype detection — worker+assets (framework + worker)", () => {
    const report = runDoctor(
      buildCtx({
        resolved: resolvedConfig({
          framework: "vite-react",
          workerEntry: "worker/index.ts",
        }),
        fileExists: (p) => p === "worker/index.ts" || p === "dist",
      }),
    );
    expect(report.archetype).toBe("worker+assets");
  });

  test("archetype detection — pure SPA framework", () => {
    const report = runDoctor(
      buildCtx({
        resolved: resolvedConfig({ framework: "vite-react" }),
        fileExists: (p) => p === "dist",
      }),
    );
    expect(report.archetype).toBe("spa");
  });

  test("empty project → ok=false + archetype=unknown", () => {
    const report = runDoctor(buildCtx());
    expect(report.archetype).toBe("unknown");
  });
});

// ─── CK-DB-DUAL-DRIVER-SPLIT ─────────────────────────────────────────────

describe("CK-DB-DUAL-DRIVER-SPLIT", () => {
  test("fires when server/db.local.ts + server/db.prod.ts both exist", () => {
    const present = new Set(["server/db.local.ts", "server/db.prod.ts"]);
    const ctx = buildCtx({
      fileExists: (p) => present.has(p),
      resolved: resolvedConfig(),
    });
    const findings = rules.CK_DB_DUAL_DRIVER_SPLIT(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("CK-DB-DUAL-DRIVER-SPLIT");
    expect(findings[0].severity).toBe("info");
  });

  test("fires on db.local.ts + db.prod.ts at project root too", () => {
    const present = new Set(["db.local.ts", "db.prod.ts"]);
    const ctx = buildCtx({ fileExists: (p) => present.has(p) });
    expect(rules.CK_DB_DUAL_DRIVER_SPLIT(ctx)).toHaveLength(1);
  });

  test("silent when only one half of the pair exists", () => {
    const present = new Set(["server/db.local.ts"]);
    const ctx = buildCtx({ fileExists: (p) => present.has(p) });
    expect(rules.CK_DB_DUAL_DRIVER_SPLIT(ctx)).toEqual([]);
  });

  test("silent on single unified server/db.ts (the recommended shape)", () => {
    const present = new Set(["server/db.ts"]);
    const ctx = buildCtx({ fileExists: (p) => present.has(p) });
    expect(rules.CK_DB_DUAL_DRIVER_SPLIT(ctx)).toEqual([]);
  });
});

describe("collectFindings contract", () => {
  test("builtin rules return at least one finding on an empty context", () => {
    // Sanity: an empty project hits CK-NO-CONFIG at minimum.
    const findings = collectFindings(buildCtx());
    expect(findings.length).toBeGreaterThan(0);
  });
});
