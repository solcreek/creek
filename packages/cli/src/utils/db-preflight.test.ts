import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectSqliteOrm,
  databaseDirectiveState,
  enableDatabaseResource,
  prismaNeedsGenerate,
  runDatabasePreflight,
  migrationOfferPlan,
  readProjectDeps,
  type PreflightIO,
} from "./db-preflight.js";

/** In-memory PreflightIO recording prompts, writes, and messages. */
function fakeIO(opts: { toml?: string | null; confirmAnswer?: boolean }): PreflightIO & {
  written: string | null;
  prompts: string[];
  logs: string[];
  warns: string[];
} {
  let toml = opts.toml ?? null;
  const rec = {
    written: null as string | null,
    prompts: [] as string[],
    logs: [] as string[],
    warns: [] as string[],
    readToml: () => toml,
    writeToml: (c: string) => {
      toml = c;
      rec.written = c;
    },
    confirm: async (m: string) => {
      rec.prompts.push(m);
      return opts.confirmAnswer ?? false;
    },
    log: (m: string) => rec.logs.push(m),
    warn: (m: string) => rec.warns.push(m),
  };
  return rec;
}

const PRISMA_DEPS = { "@prisma/adapter-better-sqlite3": "^7.8.0" };

describe("detectSqliteOrm", () => {
  test("detects Prisma via @prisma/adapter-better-sqlite3", () => {
    expect(
      detectSqliteOrm({ "@prisma/adapter-better-sqlite3": "^7.8.0", "@prisma/client": "^7.8.0" }),
    ).toBe("prisma");
  });

  test("detects Drizzle via drizzle-orm + better-sqlite3", () => {
    expect(detectSqliteOrm({ "drizzle-orm": "^0.36.0", "better-sqlite3": "^12.0.0" })).toBe(
      "drizzle",
    );
  });

  test("returns null for Drizzle without better-sqlite3 (e.g. drizzle-orm/d1 directly)", () => {
    expect(detectSqliteOrm({ "drizzle-orm": "^0.36.0" })).toBeNull();
  });

  test("returns null when neither ORM-on-sqlite is present", () => {
    expect(detectSqliteOrm({ next: "16.2.4", react: "19.2.0" })).toBeNull();
  });

  test("prefers Prisma when both signals somehow coexist", () => {
    expect(
      detectSqliteOrm({
        "@prisma/adapter-better-sqlite3": "^7.8.0",
        "drizzle-orm": "^0.36.0",
        "better-sqlite3": "^12.0.0",
      }),
    ).toBe("prisma");
  });
});

describe("databaseDirectiveState", () => {
  test("absent when no creek.toml", () => {
    expect(databaseDirectiveState(null)).toBe("absent");
  });

  test("absent when [resources] table has no database key", () => {
    expect(databaseDirectiveState('[project]\nname = "x"\n\n[resources]\nstorage = true\n')).toBe(
      "absent",
    );
  });

  test("absent when there is no [resources] table at all", () => {
    expect(databaseDirectiveState('[project]\nname = "x"\n')).toBe("absent");
  });

  test("enabled when database = true under [resources]", () => {
    expect(databaseDirectiveState("[resources]\ndatabase = true\n")).toBe("enabled");
  });

  test("disabled when database = false (explicit opt-out)", () => {
    expect(databaseDirectiveState("[resources]\ndatabase = false\n")).toBe("disabled");
  });

  test("reads the key regardless of surrounding sections and whitespace", () => {
    const toml = [
      "[project]",
      'name = "x"',
      "",
      "[resources]",
      "  database   =   true  ",
      "storage = false",
      "",
      "[release]",
      'command = "x"',
    ].join("\n");
    expect(databaseDirectiveState(toml)).toBe("enabled");
  });

  test("does not treat a [resources.sub] table as [resources]", () => {
    const toml = "[resources.cache]\ndatabase = true\n";
    expect(databaseDirectiveState(toml)).toBe("absent");
  });
});

describe("enableDatabaseResource", () => {
  test("creates a full creek.toml when none exists", () => {
    const out = enableDatabaseResource(null, "my-app");
    expect(out).toContain('[project]\nname = "my-app"');
    expect(out).toContain("[resources]\ndatabase = true");
    // The result round-trips as enabled.
    expect(databaseDirectiveState(out)).toBe("enabled");
  });

  test("inserts the key under an existing [resources] table, preserving other keys", () => {
    const before = '[project]\nname = "x"\n\n[resources]\nstorage = true\n';
    const out = enableDatabaseResource(before, "x");
    expect(out).toContain("storage = true");
    expect(databaseDirectiveState(out)).toBe("enabled");
  });

  test("appends a [resources] table when missing, keeping existing content", () => {
    const before = '[project]\nname = "x"\n\n[build]\ncommand = "next build"\n';
    const out = enableDatabaseResource(before, "x");
    expect(out).toContain('[build]\ncommand = "next build"'); // preserved
    expect(out).toContain("[resources]\ndatabase = true");
    expect(databaseDirectiveState(out)).toBe("enabled");
  });

  test("prepends [project] when the file has none", () => {
    const before = '[build]\ncommand = "next build"\n';
    const out = enableDatabaseResource(before, "inferred-name");
    expect(out).toContain('[project]\nname = "inferred-name"');
    expect(out).toContain("[resources]\ndatabase = true");
    expect(databaseDirectiveState(out)).toBe("enabled");
  });

  test("treats an empty file like a missing one", () => {
    expect(databaseDirectiveState(enableDatabaseResource("   \n", "x"))).toBe("enabled");
  });
});

describe("prismaNeedsGenerate", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "creek-prisma-gen-"));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test("false when there is no Prisma schema", () => {
    expect(prismaNeedsGenerate(cwd)).toBe(false);
  });

  test("true when schema declares an output dir that doesn't exist yet", () => {
    mkdirSync(join(cwd, "prisma"));
    writeFileSync(
      join(cwd, "prisma", "schema.prisma"),
      'generator client {\n  provider = "prisma-client"\n  output   = "../app/generated/prisma"\n}\n',
    );
    expect(prismaNeedsGenerate(cwd)).toBe(true);
  });

  test("false when the generated output dir already exists", () => {
    mkdirSync(join(cwd, "prisma"));
    writeFileSync(
      join(cwd, "prisma", "schema.prisma"),
      'generator client {\n  provider = "prisma-client"\n  output   = "../app/generated/prisma"\n}\n',
    );
    mkdirSync(join(cwd, "app", "generated", "prisma"), { recursive: true });
    expect(prismaNeedsGenerate(cwd)).toBe(false);
  });

  test("false (conservative) when schema declares no output path", () => {
    mkdirSync(join(cwd, "prisma"));
    writeFileSync(
      join(cwd, "prisma", "schema.prisma"),
      'datasource db {\n  provider = "sqlite"\n}\n',
    );
    expect(prismaNeedsGenerate(cwd)).toBe(false);
  });
});

describe("runDatabasePreflight", () => {
  test("no-op when no SQLite ORM is detected", async () => {
    const io = fakeIO({ toml: null });
    const r = await runDatabasePreflight(
      { deps: { next: "16.2.4" }, projectName: "x", tty: true, autoYes: false },
      io,
    );
    expect(r.wroteToml).toBe(false);
    expect(io.prompts).toHaveLength(0);
    expect(io.written).toBeNull();
  });

  test("no-op (respects opt-out) when database = false", async () => {
    const io = fakeIO({ toml: "[resources]\ndatabase = false\n", confirmAnswer: true });
    const r = await runDatabasePreflight(
      { deps: PRISMA_DEPS, projectName: "x", tty: true, autoYes: false },
      io,
    );
    expect(r.wroteToml).toBe(false);
    expect(io.prompts).toHaveLength(0); // never prompts after explicit opt-out
  });

  test("no-op when already enabled", async () => {
    const io = fakeIO({ toml: "[resources]\ndatabase = true\n" });
    const r = await runDatabasePreflight(
      { deps: PRISMA_DEPS, projectName: "x", tty: true, autoYes: false },
      io,
    );
    expect(r.wroteToml).toBe(false);
    expect(io.prompts).toHaveLength(0);
  });

  test("prompts and writes when accepted (interactive)", async () => {
    const io = fakeIO({ toml: '[project]\nname = "x"\n', confirmAnswer: true });
    const r = await runDatabasePreflight(
      { deps: PRISMA_DEPS, projectName: "x", tty: true, autoYes: false },
      io,
    );
    expect(r.wroteToml).toBe(true);
    expect(io.prompts[0]).toMatch(/separate instance from your local file/);
    expect(databaseDirectiveState(io.written)).toBe("enabled");
  });

  test("prompts and does NOT write when declined", async () => {
    const io = fakeIO({ toml: '[project]\nname = "x"\n', confirmAnswer: false });
    const r = await runDatabasePreflight(
      { deps: PRISMA_DEPS, projectName: "x", tty: true, autoYes: false },
      io,
    );
    expect(r.wroteToml).toBe(false);
    expect(io.prompts).toHaveLength(1);
    expect(io.written).toBeNull();
    expect(io.logs.join(" ")).toMatch(/setup hint/);
  });

  test("auto-writes under --yes without prompting", async () => {
    const io = fakeIO({ toml: null });
    const r = await runDatabasePreflight(
      { deps: PRISMA_DEPS, projectName: "auto-app", tty: false, autoYes: true },
      io,
    );
    expect(r.wroteToml).toBe(true);
    expect(io.prompts).toHaveLength(0);
    expect(io.written).toContain('name = "auto-app"');
    expect(databaseDirectiveState(io.written)).toBe("enabled");
  });

  test("non-interactive without --yes: warns and continues, no write", async () => {
    const io = fakeIO({ toml: null });
    const r = await runDatabasePreflight(
      { deps: PRISMA_DEPS, projectName: "x", tty: false, autoYes: false },
      io,
    );
    expect(r.wroteToml).toBe(false);
    expect(io.prompts).toHaveLength(0);
    expect(io.written).toBeNull();
    expect(io.warns.join(" ")).toMatch(/Database routes will fail/);
  });
});

describe("readProjectDeps", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "creek-deps-"));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test("merges dependencies and devDependencies", () => {
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({
        dependencies: { "@prisma/adapter-better-sqlite3": "^7.8.0" },
        devDependencies: { vitest: "^4.0.0" },
      }),
    );
    const deps = readProjectDeps(cwd);
    expect(deps["@prisma/adapter-better-sqlite3"]).toBe("^7.8.0");
    expect(deps["vitest"]).toBe("^4.0.0");
  });

  test("returns {} when package.json is missing or invalid", () => {
    expect(readProjectDeps(cwd)).toEqual({});
  });
});

describe("migrationOfferPlan", () => {
  test("none when no migration dir", () => {
    expect(migrationOfferPlan({ migrationDir: null, tty: true, autoMigrate: false })).toBe("none");
  });
  test("run under explicit --migrate", () => {
    expect(
      migrationOfferPlan({ migrationDir: "/p/prisma/migrations", tty: false, autoMigrate: true }),
    ).toBe("run");
  });
  test("prompt when interactive", () => {
    expect(migrationOfferPlan({ migrationDir: "/p/drizzle", tty: true, autoMigrate: false })).toBe(
      "prompt",
    );
  });
  test("suggest (print, don't run) when non-interactive", () => {
    expect(migrationOfferPlan({ migrationDir: "/p/drizzle", tty: false, autoMigrate: false })).toBe(
      "suggest",
    );
  });
});
