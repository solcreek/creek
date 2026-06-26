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
    readFile: () => null,
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

// ─── CK-WORKER-UNRESOLVED-IMPORTS ───────────────────────────────────────

describe("CK-WORKER-UNRESOLVED-IMPORTS", () => {
  // The exact bytes `creek init --db` scaffolds.
  const SCAFFOLD = `import { Hono } from "hono";
import { db } from "creek";
import { define } from "d1-schema";
export default new Hono();`;

  test("fires (error) on the init --db scaffold with no deps installed", () => {
    const ctx = buildCtx({
      resolved: resolvedConfig({ workerEntry: "worker/index.ts" }),
      packageJson: pkg(),
      allDeps: {},
      readFile: (p) => (p === "worker/index.ts" ? SCAFFOLD : null),
    });
    const findings = rules.CK_WORKER_UNRESOLVED_IMPORTS(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("CK-WORKER-UNRESOLVED-IMPORTS");
    expect(findings[0].severity).toBe("error");
    expect(findings[0].title).toContain("hono");
    expect(findings[0].title).toContain("creek");
    expect(findings[0].title).toContain("d1-schema");
    expect(findings[0].fix).toContain("npm install hono creek d1-schema");
  });

  test("silent once every imported package is declared", () => {
    const ctx = buildCtx({
      resolved: resolvedConfig({ workerEntry: "worker/index.ts" }),
      packageJson: pkg({ hono: "^4", creek: "^0", "d1-schema": "^0" }),
      allDeps: { hono: "^4", creek: "^0", "d1-schema": "^0" },
      readFile: () => SCAFFOLD,
    });
    expect(rules.CK_WORKER_UNRESOLVED_IMPORTS(ctx)).toEqual([]);
  });

  test("only flags the undeclared subset", () => {
    const ctx = buildCtx({
      resolved: resolvedConfig({ workerEntry: "worker/index.ts" }),
      packageJson: pkg({ hono: "^4" }),
      allDeps: { hono: "^4" },
      readFile: () => SCAFFOLD,
    });
    const findings = rules.CK_WORKER_UNRESOLVED_IMPORTS(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].title).not.toContain("hono");
    expect(findings[0].title).toContain("creek");
    expect(findings[0].title).toContain("d1-schema");
  });

  test("ignores relative imports and node builtins", () => {
    const ctx = buildCtx({
      resolved: resolvedConfig({ workerEntry: "worker/index.ts" }),
      packageJson: pkg(),
      allDeps: {},
      readFile: () =>
        `import { x } from "./local";\nimport crypto from "node:crypto";\nimport { readFile } from "fs";\nexport default {};`,
    });
    expect(rules.CK_WORKER_UNRESOLVED_IMPORTS(ctx)).toEqual([]);
  });

  test("maps scoped + subpath specifiers to the installable package name", () => {
    const ctx = buildCtx({
      resolved: resolvedConfig({ workerEntry: "worker/index.ts" }),
      packageJson: pkg({ "@scope/lib": "^1", drizzle: "^0" }),
      allDeps: { "@scope/lib": "^1", drizzle: "^0" },
      readFile: () =>
        `import a from "@scope/lib/sub";\nimport b from "drizzle/d1";\nexport default {};`,
    });
    expect(rules.CK_WORKER_UNRESOLVED_IMPORTS(ctx)).toEqual([]);
  });

  test("silent when no package.json (nothing to assess against)", () => {
    const ctx = buildCtx({
      resolved: resolvedConfig({ workerEntry: "worker/index.ts" }),
      packageJson: null,
      readFile: () => SCAFFOLD,
    });
    expect(rules.CK_WORKER_UNRESOLVED_IMPORTS(ctx)).toEqual([]);
  });

  test("silent for pre-bundled (non-source) worker outputs", () => {
    const ctx = buildCtx({
      resolved: resolvedConfig({ workerEntry: "dist/_worker.mjs" }),
      packageJson: pkg(),
      readFile: () => `import x from "uninstalled";`,
    });
    expect(rules.CK_WORKER_UNRESOLVED_IMPORTS(ctx)).toEqual([]);
  });

  test("silent when the worker file can't be read (missing handled elsewhere)", () => {
    const ctx = buildCtx({
      resolved: resolvedConfig({ workerEntry: "worker/index.ts" }),
      packageJson: pkg(),
      readFile: () => null,
    });
    expect(rules.CK_WORKER_UNRESOLVED_IMPORTS(ctx)).toEqual([]);
  });
});

// ─── CK-RUNTIME-DEP-MISSING ─────────────────────────────────────────────

describe("CK-RUNTIME-DEP-MISSING", () => {
  test("fires when a TS worker is bundled but 'creek' isn't installed", () => {
    // The dogfood case: a dual-driver Drizzle worker whose own source never
    // imports `creek`, so CK-WORKER-UNRESOLVED-IMPORTS passes — but the
    // injected wrapper still imports it.
    const ctx = buildCtx({
      resolved: resolvedConfig({ workerEntry: "src/worker.ts" }),
      packageJson: pkg({ hono: "^4", "drizzle-orm": "^0.30" }),
      allDeps: { hono: "^4", "drizzle-orm": "^0.30" },
    });
    const findings = rules.CK_RUNTIME_DEP_MISSING(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("CK-RUNTIME-DEP-MISSING");
    expect(findings[0].severity).toBe("error");
    expect(findings[0].detail).toContain("src/worker.ts");
  });

  test("silent when 'creek' is installed (deps or devDeps)", () => {
    const ctx = buildCtx({
      resolved: resolvedConfig({ workerEntry: "src/worker.ts" }),
      packageJson: pkg({ creek: "^0.4.36" }),
      allDeps: { creek: "^0.4.36" },
    });
    expect(rules.CK_RUNTIME_DEP_MISSING(ctx)).toEqual([]);
  });

  test("silent for pre-bundled workers (uploaded as-is, no wrapper)", () => {
    const ctx = buildCtx({
      resolved: resolvedConfig({ workerEntry: "dist/_worker.mjs" }),
      packageJson: pkg({ hono: "^4" }),
      allDeps: { hono: "^4" },
    });
    expect(rules.CK_RUNTIME_DEP_MISSING(ctx)).toEqual([]);
  });

  // Regression: a `.js` SOURCE worker outside the build output is still
  // esbuild-bundled (the wrapper is injected), so the runtime dep is needed.
  // Extension alone must not classify it as pre-bundled.
  test("fires for a .js source worker outside the build output", () => {
    const ctx = buildCtx({
      resolved: resolvedConfig({
        workerEntry: "src/worker.js",
        buildOutput: "dist",
      }),
      packageJson: pkg({ hono: "^4" }),
      allDeps: { hono: "^4" },
    });
    const findings = rules.CK_RUNTIME_DEP_MISSING(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("CK-RUNTIME-DEP-MISSING");
  });

  test("silent for a pre-bundled .js worker inside the build output", () => {
    const ctx = buildCtx({
      resolved: resolvedConfig({
        workerEntry: "dist/worker.js",
        buildOutput: "dist",
      }),
      packageJson: pkg({ hono: "^4" }),
      allDeps: { hono: "^4" },
    });
    expect(rules.CK_RUNTIME_DEP_MISSING(ctx)).toEqual([]);
  });

  test("silent when no worker entry is declared", () => {
    const ctx = buildCtx({
      resolved: resolvedConfig({ workerEntry: null }),
      packageJson: pkg(),
      allDeps: {},
    });
    expect(rules.CK_RUNTIME_DEP_MISSING(ctx)).toEqual([]);
  });

  test("silent when there is no package.json", () => {
    const ctx = buildCtx({
      resolved: resolvedConfig({ workerEntry: "src/worker.ts" }),
      packageJson: null,
    });
    expect(rules.CK_RUNTIME_DEP_MISSING(ctx)).toEqual([]);
  });
});

// ─── CK-RESOURCES-NO-WORKER ─────────────────────────────────────────────

describe("CK-RESOURCES-NO-WORKER", () => {
  test("fires when a database is declared but there is no worker entry", () => {
    const ctx = buildCtx({
      resolved: resolvedConfig({
        bindings: [{ type: "d1", name: "DB" }],
        workerEntry: null,
      }),
    });
    const findings = rules.CK_RESOURCES_NO_WORKER(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: "CK-RESOURCES-NO-WORKER",
      severity: "warn",
    });
    expect(findings[0].detail).toContain("spa");
    expect(findings[0].fix).toContain('worker = "worker/index.ts"');
  });

  test("silent when a worker entry is declared", () => {
    const ctx = buildCtx({
      resolved: resolvedConfig({
        bindings: [{ type: "d1", name: "DB" }],
        workerEntry: "worker/index.ts",
      }),
    });
    expect(rules.CK_RESOURCES_NO_WORKER(ctx)).toEqual([]);
  });

  test("silent when no resource bindings are declared", () => {
    const ctx = buildCtx({ resolved: resolvedConfig() });
    expect(rules.CK_RESOURCES_NO_WORKER(ctx)).toEqual([]);
  });

  test("silent for SSR frameworks — the framework provides the server bundle", () => {
    const ctx = buildCtx({
      resolved: resolvedConfig({
        framework: "nextjs",
        bindings: [{ type: "d1", name: "DB" }],
      }),
    });
    expect(rules.CK_RESOURCES_NO_WORKER(ctx)).toEqual([]);
  });

  test("silent for Astro with the Cloudflare adapter", () => {
    const ctx = buildCtx({
      resolved: resolvedConfig({
        framework: "astro",
        bindings: [{ type: "kv", name: "KV" }],
      }),
      allDeps: { "@astrojs/cloudflare": "^12.0.0" },
    });
    expect(rules.CK_RESOURCES_NO_WORKER(ctx)).toEqual([]);
  });

  test("silent when only non-resource bindings (durable objects) are present", () => {
    const ctx = buildCtx({
      resolved: resolvedConfig({
        bindings: [{ type: "durable_object", name: "ROOM" }],
      }),
    });
    expect(rules.CK_RESOURCES_NO_WORKER(ctx)).toEqual([]);
  });
});

// ─── CK-WORKER-UNDECLARED ───────────────────────────────────────────────

describe("CK-WORKER-UNDECLARED", () => {
  test("fires when worker/index.ts exists on disk but no worker entry is declared", () => {
    const ctx = buildCtx({
      resolved: resolvedConfig(),
      fileExists: (p) => p === "worker/index.ts",
    });
    const findings = rules.CK_WORKER_UNDECLARED(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: "CK-WORKER-UNDECLARED",
      severity: "info",
    });
    expect(findings[0].title).toContain("worker/index.ts");
    expect(findings[0].references).toContain("worker/index.ts");
  });

  test("fires for src/worker.ts too", () => {
    const ctx = buildCtx({
      resolved: resolvedConfig(),
      fileExists: (p) => p === "src/worker.ts",
    });
    const findings = rules.CK_WORKER_UNDECLARED(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toContain("src/worker.ts");
  });

  test("silent when the worker entry is declared", () => {
    const ctx = buildCtx({
      resolved: resolvedConfig({ workerEntry: "worker/index.ts" }),
      fileExists: (p) => p === "worker/index.ts",
    });
    expect(rules.CK_WORKER_UNDECLARED(ctx)).toEqual([]);
  });

  test("silent when no candidate file exists", () => {
    const ctx = buildCtx({ resolved: resolvedConfig() });
    expect(rules.CK_WORKER_UNDECLARED(ctx)).toEqual([]);
  });

  test("silent for SSR frameworks — server code is the framework's, not a custom worker", () => {
    const ctx = buildCtx({
      resolved: resolvedConfig({ framework: "sveltekit" }),
      fileExists: (p) => p === "src/worker.ts",
    });
    expect(rules.CK_WORKER_UNDECLARED(ctx)).toEqual([]);
  });
});

// ─── CK-UNDEPLOYED-SERVICES ─────────────────────────────────────────────

describe("CK-UNDEPLOYED-SERVICES", () => {
  test("warns when a server/ backend exists but no worker is declared (spa)", () => {
    const ctx = buildCtx({
      resolved: resolvedConfig({ framework: "vite" }),
      fileExists: (p) => p === "server/index.ts",
    });
    const findings = rules.CK_UNDEPLOYED_SERVICES(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("CK-UNDEPLOYED-SERVICES");
    expect(findings[0].severity).toBe("warn");
    expect(findings[0].title).toContain("server/");
    expect(findings[0].references).toContain("server");
  });

  test("reports every service directory found (server + mcp)", () => {
    const ctx = buildCtx({
      resolved: resolvedConfig({ framework: "vite" }),
      fileExists: (p) => p === "server/package.json" || p === "mcp/index.ts",
    });
    const findings = rules.CK_UNDEPLOYED_SERVICES(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toContain("server/");
    expect(findings[0].title).toContain("mcp/");
    expect(findings[0].references).toEqual(expect.arrayContaining(["server", "mcp"]));
  });

  test("silent when a worker entry is declared (backend is wired in)", () => {
    const ctx = buildCtx({
      resolved: resolvedConfig({ framework: "vite", workerEntry: "worker/index.ts" }),
      fileExists: (p) => p === "server/index.ts",
    });
    expect(rules.CK_UNDEPLOYED_SERVICES(ctx)).toEqual([]);
  });

  test("silent for SSR frameworks — server/ belongs to the framework build", () => {
    const ctx = buildCtx({
      resolved: resolvedConfig({ framework: "sveltekit" }),
      fileExists: (p) => p === "server/index.ts",
    });
    expect(rules.CK_UNDEPLOYED_SERVICES(ctx)).toEqual([]);
  });

  test("silent when no service directory exists", () => {
    const ctx = buildCtx({
      resolved: resolvedConfig({ framework: "vite" }),
      fileExists: () => false,
    });
    expect(rules.CK_UNDEPLOYED_SERVICES(ctx)).toEqual([]);
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

// ─── CK-AUTH-SECRET ─────────────────────────────────────────────────────

describe("CK-AUTH-SECRET", () => {
  test("fires as WARN for better-auth and names BETTER_AUTH_SECRET", () => {
    const ctx = buildCtx({ allDeps: { "better-auth": "^1.0.0" } });
    const findings = rules.CK_AUTH_SECRET(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("CK-AUTH-SECRET");
    expect(findings[0].severity).toBe("warn");
    expect(findings[0].title).toContain("Better Auth");
    expect(findings[0].detail).toContain("BETTER_AUTH_SECRET");
    // The fix must point at `creek env set`, not a build-time config.
    expect(findings[0].fix).toContain("creek env set BETTER_AUTH_SECRET");
    expect(findings[0].fix).toContain("creek deploy");
  });

  test("fires for Auth.js (next-auth) and names AUTH_SECRET", () => {
    const ctx = buildCtx({ allDeps: { "next-auth": "^5.0.0" } });
    const findings = rules.CK_AUTH_SECRET(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].detail).toContain("AUTH_SECRET");
    expect(findings[0].fix).toContain("creek env set AUTH_SECRET");
  });

  test("dedupes the env var when next-auth + @auth/core are both present", () => {
    const ctx = buildCtx({
      allDeps: { "next-auth": "^5.0.0", "@auth/core": "^0.37.0" },
    });
    const findings = rules.CK_AUTH_SECRET(ctx);
    expect(findings).toHaveLength(1);
    // AUTH_SECRET appears once in the detail's required list (no dup).
    const occurrences = findings[0].detail.split("AUTH_SECRET").length - 1;
    expect(occurrences).toBe(1);
  });

  test("silent when no auth framework is present", () => {
    const ctx = buildCtx({ allDeps: { "drizzle-orm": "^0.36.0" } });
    expect(rules.CK_AUTH_SECRET(ctx)).toEqual([]);
  });

  test("does not affect ok (warning, not error)", () => {
    const report = runDoctor(
      buildCtx({
        resolved: resolvedConfig({ workerEntry: "worker/index.ts" }),
        fileExists: (p) => p === "worker/index.ts",
        allDeps: { "better-auth": "^1.0.0" },
      }),
    );
    expect(report.ok).toBe(true);
    expect(report.summary.warn).toBeGreaterThan(0);
  });
});

// ─── CK-SYNC-SQLITE × CK-PRISMA-SQLITE cross-reference ──────────────────

describe("SQLite findings cross-reference when both deps present", () => {
  test("both fire and each detail points at the other", () => {
    const ctx = buildCtx({
      allDeps: { "better-sqlite3": "^12.0.0", prisma: "^7.0.0" },
      packageJson: pkg({ "better-sqlite3": "^12.0.0", prisma: "^7.0.0" }),
    });
    const sync = rules.CK_SYNC_SQLITE(ctx);
    const prisma = rules.CK_PRISMA_SQLITE(ctx);
    expect(sync[0].detail).toContain("CK-PRISMA-SQLITE");
    expect(prisma[0].detail).toContain("CK-SYNC-SQLITE");
  });

  test("no cross-reference when only one dep is present", () => {
    const syncOnly = rules.CK_SYNC_SQLITE(
      buildCtx({ allDeps: { "better-sqlite3": "^12.0.0" }, packageJson: pkg({ "better-sqlite3": "^12.0.0" }) }),
    );
    const prismaOnly = rules.CK_PRISMA_SQLITE(buildCtx({ allDeps: { prisma: "^7.0.0" } }));
    expect(syncOnly[0].detail).not.toContain("CK-PRISMA-SQLITE");
    expect(prismaOnly[0].detail).not.toContain("CK-SYNC-SQLITE");
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

  // R2 regression: when `creek` is the offender, the fix must NOT tell the
  // user to demote it to devDependencies — the Creek-injected worker wrapper
  // imports it at bundle time, so that advice breaks the next deploy.
  test("does not advise moving 'creek' to devDependencies", () => {
    const ctx = buildCtx({ packageJson: pkg({ creek: "^0.4.36" }) });
    const fix = rules.CK_RUNTIME_LOCKIN(ctx)[0].fix;
    expect(fix).not.toMatch(/devDependencies/);
    expect(fix).toContain("must stay in `dependencies`");
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
    // The worker entry must be presented as a co-equal path, not a
    // footnote — users with API routes otherwise chase build output.
    expect(findings[0].fix).toContain('worker = "worker/index.ts"');
    expect(findings[0].detail).toContain("[build].worker");
  });

  test("fix offers the worker entry even without a build command", () => {
    const ctx = buildCtx({
      resolved: resolvedConfig({ buildOutput: "dist", buildCommand: "" }),
      fileExists: () => false,
    });
    const findings = rules.CK_NOTHING_TO_DEPLOY(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].fix).toContain('worker = "worker/index.ts"');
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

  test("Next.js: info note (not warn) and never says to run next build", () => {
    const ctx = buildCtx({
      resolved: resolvedConfig({ buildOutput: ".open-next", buildCommand: "next build" }),
      allDeps: { next: "^16.2.3" },
      fileExists: () => false,
    });
    const findings = rules.CK_NOTHING_TO_DEPLOY(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("info");
    expect(findings[0].fix).not.toContain("next build");
    expect(findings[0].fix).toContain("creek deploy");
    // Must not push the user to install an adapter themselves.
    expect(findings[0].fix).toMatch(/do NOT need to install/i);
  });

  test("Next.js: silent once adapter output exists", () => {
    const ctx = buildCtx({
      resolved: resolvedConfig({ buildOutput: ".open-next" }),
      allDeps: { next: "^16.2.3" },
      fileExists: (p) => p === ".creek/adapter-output",
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
