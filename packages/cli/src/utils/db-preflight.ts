/**
 * Database deploy preflight: detect → confirm helpers.
 *
 * An app that uses Prisma or Drizzle on local SQLite runs on a Cloudflare D1
 * database on Creek (a separate cloud instance from the local file). Getting
 * there needs `database = true` under `[resources]` in creek.toml and, for
 * Prisma, a generated client. These pure helpers detect that situation and
 * patch creek.toml; the actual prompts, file writes, and `creek db migrate`
 * are wired by the deploy command so the consequential steps stay behind
 * explicit consent (see the deploy flow).
 *
 * Design split by risk: client generation is safe to automate; provisioning a
 * (billed) database is confirm-first; applying migrations is never silent.
 *
 * Pure functions are exported for testing.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import consola from "consola";

export type SqliteOrm = "prisma" | "drizzle";

/**
 * Detect an ORM configured against local SQLite — the case Creek swaps onto
 * D1. The signal is the presence of the better-sqlite3 driver/adapter the
 * adapter-creek build-time swap targets:
 *  - Prisma: `@prisma/adapter-better-sqlite3`
 *  - Drizzle: `drizzle-orm` + `better-sqlite3`
 *
 * Returns null when neither is present (e.g. an app on an external DB, or
 * Drizzle pointed straight at `drizzle-orm/d1`), so we never guess a database
 * the project didn't ask for.
 */
export function detectSqliteOrm(deps: Record<string, string | undefined>): SqliteOrm | null {
  if (deps["@prisma/adapter-better-sqlite3"]) return "prisma";
  if (deps["drizzle-orm"] && deps["better-sqlite3"]) return "drizzle";
  return null;
}

export type DatabaseDirective = "enabled" | "disabled" | "absent";

/**
 * Read the `[resources].database` directive from raw creek.toml text — NOT the
 * SDK-parsed config, because the parser defaults `database` to `false` and so
 * can't tell "explicitly opted out" from "never decided". The distinction
 * drives whether we may prompt:
 *  - "enabled"  → already on, nothing to do
 *  - "disabled" → explicit opt-out, never prompt
 *  - "absent"   → undecided, eligible to prompt
 */
export function databaseDirectiveState(rawToml: string | null): DatabaseDirective {
  if (!rawToml) return "absent";
  let inResources = false;
  for (const rawLine of rawToml.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("[")) {
      // A new table header. `[resources]` exactly; `[resources.x]` is a
      // different (sub)table and doesn't carry the boolean directive.
      inResources = line === "[resources]";
      continue;
    }
    if (!inResources) continue;
    const m = line.match(/^database\s*=\s*(true|false)\b/);
    if (m) return m[1] === "true" ? "enabled" : "disabled";
  }
  return "absent";
}

/**
 * Patch raw creek.toml to enable the database resource, preserving existing
 * content (so the file stays reviewable). Only called when the directive is
 * "absent". Handles: no file, `[resources]` present (insert the key), and
 * `[resources]` missing (append the section, prepending `[project]` when the
 * file has none so the result is a valid creek.toml).
 */
export function enableDatabaseResource(rawToml: string | null, projectName: string): string {
  const resourcesBlock = "[resources]\ndatabase = true\n";

  if (rawToml === null || rawToml.trim() === "") {
    return `[project]\nname = "${projectName}"\n\n${resourcesBlock}`;
  }

  const lines = rawToml.split(/\r?\n/);
  const resourcesIdx = lines.findIndex((l) => l.trim() === "[resources]");
  if (resourcesIdx !== -1) {
    // Insert the key directly under the existing header.
    lines.splice(resourcesIdx + 1, 0, "database = true");
    return lines.join("\n");
  }

  // No [resources] table — append one, ensuring a [project] table exists.
  const hasProject = lines.some((l) => l.trim() === "[project]");
  const trimmed = rawToml.replace(/\s*$/, "");
  const prefix = hasProject ? "" : `[project]\nname = "${projectName}"\n\n`;
  const sep = trimmed === "" ? "" : "\n\n";
  return `${prefix}${trimmed}${sep}${resourcesBlock}`;
}

/**
 * Read the generator `output` path from a Prisma schema (Prisma 7's
 * `prisma-client` generator requires one). Returns an absolute path or null.
 */
function prismaClientOutput(cwd: string, schemaPath: string): string | null {
  let schema: string;
  try {
    schema = readFileSync(schemaPath, "utf-8");
  } catch {
    return null;
  }
  const m = schema.match(/\boutput\s*=\s*"([^"]+)"/);
  if (!m) return null;
  const out = m[1];
  return out.startsWith("/") ? out : join(cwd, "prisma", out);
}

/**
 * Whether the project uses Prisma and its client hasn't been generated yet.
 * Safe to act on automatically (generation is idempotent, no external effect).
 * Conservative: only true when a schema exists, declares an `output`, and that
 * directory is missing — otherwise we leave the user's setup untouched.
 */
export function prismaNeedsGenerate(cwd: string): boolean {
  const schemaPath = join(cwd, "prisma", "schema.prisma");
  if (!existsSync(schemaPath)) return false;
  const out = prismaClientOutput(cwd, schemaPath);
  if (!out) return false;
  return !existsSync(out);
}

const ORM_LABEL: Record<SqliteOrm, string> = {
  prisma: "Prisma",
  drizzle: "Drizzle",
};

/**
 * Side-effect surface for the database preflight, injected so the decision flow
 * is testable without a real terminal or filesystem. `confirm` resolves the
 * interactive yes/no; `readToml`/`writeToml` are the raw creek.toml.
 */
export interface PreflightIO {
  readToml(): string | null;
  writeToml(content: string): void;
  confirm(message: string): Promise<boolean>;
  log(message: string): void;
  warn(message: string): void;
}

export interface PreflightOptions {
  deps: Record<string, string | undefined>;
  projectName: string;
  /** Interactive terminal — may prompt. */
  tty: boolean;
  /** `--yes`: auto-accept the (low-risk) DB-resource provisioning. */
  autoYes: boolean;
}

export interface PreflightResult {
  /** creek.toml was patched — the caller must re-resolve config before deploy. */
  wroteToml: boolean;
}

/**
 * Confirm-first database provisioning. When the project uses an ORM on SQLite
 * but creek.toml hasn't decided on a database resource, prompt (or auto-accept
 * under --yes) to add `database = true`. Never overrides an explicit opt-out,
 * never prompts in non-interactive contexts (warns and continues — the deploy
 * still succeeds and DB routes return a self-documenting hint at runtime).
 */
export async function runDatabasePreflight(
  opts: PreflightOptions,
  io: PreflightIO,
): Promise<PreflightResult> {
  const orm = detectSqliteOrm(opts.deps);
  if (!orm) return { wroteToml: false };

  const state = databaseDirectiveState(io.readToml());
  if (state !== "absent") return { wroteToml: false }; // already enabled or opted out

  if (!opts.tty && !opts.autoYes) {
    io.warn(
      `Detected ${ORM_LABEL[orm]} on better-sqlite3 but creek.toml has no [resources] database. ` +
        "Database routes will fail until you add `database = true` (run deploy in a terminal, or pass --yes).",
    );
    return { wroteToml: false };
  }

  const accepted = opts.autoYes
    ? true
    : await io.confirm(
        `Detected ${ORM_LABEL[orm]} on better-sqlite3. On Creek this runs on a Cloudflare D1 ` +
          "database in the cloud — a separate instance from your local file (local data is not " +
          "copied). Add `database = true` under [resources] to creek.toml?",
      );
  if (!accepted) {
    io.log(
      "Skipped. Database routes will return a setup hint until you add `database = true` to creek.toml.",
    );
    return { wroteToml: false };
  }

  io.writeToml(enableDatabaseResource(io.readToml(), opts.projectName));
  io.log("Enabled [resources] database in creek.toml (cloud D1 — separate from your local file).");
  return { wroteToml: true };
}

/**
 * What to do about a detected migration directory after the database exists.
 * Migrations can be destructive, so this is never silent:
 *  - "run"     → explicit opt-in (`--migrate`)
 *  - "prompt"  → interactive (ask, default no)
 *  - "suggest" → non-interactive (print the command, don't run)
 *  - "none"    → no migrations to apply
 */
export function migrationOfferPlan(opts: {
  migrationDir: string | null;
  tty: boolean;
  autoMigrate: boolean;
}): "run" | "prompt" | "suggest" | "none" {
  if (!opts.migrationDir) return "none";
  if (opts.autoMigrate) return "run";
  return opts.tty ? "prompt" : "suggest";
}

/** Merged dependencies + devDependencies from the project's package.json. */
export function readProjectDeps(cwd: string): Record<string, string | undefined> {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf-8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  } catch {
    return {};
  }
}

/** Real (consola + filesystem) PreflightIO for the deploy command. */
export function makePreflightIO(cwd: string): PreflightIO {
  const tomlPath = join(cwd, "creek.toml");
  return {
    readToml: () => (existsSync(tomlPath) ? readFileSync(tomlPath, "utf-8") : null),
    writeToml: (content) => writeFileSync(tomlPath, content),
    // DB provisioning is low-risk → default to yes.
    confirm: async (message) =>
      (await consola.prompt(message, { type: "confirm", initial: true })) as unknown as boolean,
    log: (message) => consola.success(`  ${message}`),
    warn: (message) => consola.warn(`  ${message}`),
  };
}
