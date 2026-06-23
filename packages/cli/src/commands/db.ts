import { defineCommand } from "citty";
import consola from "consola";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { CreekClient, parseConfig } from "@solcreek/sdk";
import { createResourceCommand } from "./resource-cmd.js";
import { detectMigrationDir, parseMigrationFiles, splitStatements, computePending, batchStatements } from "./migrate.js";
import { getToken, getApiUrl } from "../utils/config.js";
import { globalArgs, resolveJsonMode, jsonOutput, AUTH_BREADCRUMBS } from "../utils/output.js";

const base = createResourceCommand({
  kind: "database",
  label: "database",
  defaultBinding: "DB",
});

const shellCommand = defineCommand({
  meta: {
    name: "shell",
    description: "Execute SQL against a team database. Interactive REPL or single query with --sql.",
  },
  args: {
    name: {
      type: "positional",
      description: "Database name (as shown by `creek db ls`). Optional when --project is given or run inside a project directory.",
      required: false,
    },
    project: {
      type: "string",
      description: "Resolve the database bound to this project instead of naming it. Defaults to the project in ./creek.toml when neither a name nor --project is given.",
      required: false,
    },
    sql: {
      type: "string",
      description: "SQL query to execute (non-interactive mode). Omit for interactive REPL.",
      required: false,
    },
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const token = getToken();
    if (!token) {
      if (jsonMode) jsonOutput({ ok: false, error: "not_authenticated" }, 1, AUTH_BREADCRUMBS);
      consola.error("Not authenticated. Run `creek login` first.");
      process.exit(1);
    }
    const client = new CreekClient(getApiUrl(), token);

    const db = await resolveShellDatabase(client, {
      name: args.name as string | undefined,
      project: args.project as string | undefined,
      jsonMode,
    });

    // Single query mode
    if (args.sql) {
      await executeAndPrint(client, db.id, args.sql, jsonMode);
      return;
    }

    // Interactive REPL
    consola.info(`Connected to ${db.name} (${db.id.slice(0, 8)})`);
    consola.info("Type SQL and press Enter. Use .exit to quit.\n");

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "sql> ",
    });

    rl.prompt();
    let buffer = "";

    rl.on("line", async (line) => {
      const trimmed = line.trim();

      if (trimmed === ".exit" || trimmed === ".quit") {
        rl.close();
        return;
      }

      if (trimmed === ".tables") {
        buffer = "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name";
      } else if (trimmed === ".schema") {
        buffer = "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name";
      } else {
        buffer += (buffer ? "\n" : "") + line;
      }

      // Execute when line ends with semicolon or is a dot-command
      if (!buffer.endsWith(";") && !trimmed.startsWith(".")) {
        rl.setPrompt("...> ");
        rl.prompt();
        return;
      }

      await executeAndPrint(client, db.id, buffer, false);
      buffer = "";
      rl.setPrompt("sql> ");
      rl.prompt();
    });

    rl.on("close", () => {
      consola.info("Bye.");
      process.exit(0);
    });
  },
});

/**
 * Resolve which database `db shell` should open. Three inputs, in order:
 *   1. an explicit `name` positional (existing behaviour),
 *   2. `--project <slug>` → the single D1 bound to that project,
 *   3. neither → the project in ./creek.toml, same single-binding rule.
 *
 * The point is to not force the user to look up the auto-generated DB
 * name (e.g. creek-97d8c075) when the project binds exactly one D1.
 * Exits the process with a structured error if resolution is ambiguous
 * or empty.
 */
export async function resolveShellDatabase(
  client: CreekClient,
  opts: { name?: string; project?: string; jsonMode: boolean },
): Promise<{ id: string; name: string }> {
  const { name, jsonMode } = opts;

  // 1. Explicit name → look up by name (unchanged path).
  if (name) {
    const { resources } = await client.listResources();
    const db = resources.find((r) => r.name === name && r.kind === "database");
    if (!db) {
      if (jsonMode) jsonOutput({ ok: false, error: "not_found", message: `No database named "${name}"` }, 1);
      consola.error(`No database named "${name}"`);
      process.exit(1);
    }
    return { id: db.id, name: db.name };
  }

  // 2/3. Resolve via project bindings.
  const slug = opts.project ?? projectFromCreekToml();
  if (!slug) {
    const msg = "Provide a database name, pass --project <slug>, or run inside a project directory with creek.toml.";
    if (jsonMode) jsonOutput({ ok: false, error: "no_database_specified", message: msg }, 1);
    consola.error(msg);
    process.exit(1);
  }

  const { bindings } = await client.listBindings(slug);
  const dbs = bindings.filter((b) => b.kind === "database");
  if (dbs.length === 0) {
    const msg = `Project "${slug}" has no database bound. Attach one with \`creek db attach\`.`;
    if (jsonMode) jsonOutput({ ok: false, error: "no_database_bound", project: slug, message: msg }, 1);
    consola.error(msg);
    process.exit(1);
  }
  if (dbs.length > 1) {
    const names = dbs.map((b) => b.name).join(", ");
    const msg = `Project "${slug}" binds ${dbs.length} databases (${names}). Pass the name explicitly: creek db shell <name> --sql "…".`;
    if (jsonMode) jsonOutput({ ok: false, error: "ambiguous_database", project: slug, databases: dbs.map((b) => b.name), message: msg }, 1);
    consola.error(msg);
    process.exit(1);
  }
  return { id: dbs[0].resourceId, name: dbs[0].name };
}

/** Read the project name from ./creek.toml, or null if absent/unparseable. */
function projectFromCreekToml(): string | null {
  const configPath = resolve(process.cwd(), "creek.toml");
  if (!existsSync(configPath)) return null;
  try {
    return parseConfig(readFileSync(configPath, "utf-8")).project.name;
  } catch {
    return null;
  }
}

async function executeAndPrint(
  client: CreekClient,
  resourceId: string,
  sql: string,
  jsonMode: boolean,
): Promise<void> {
  try {
    const result = await client.queryDatabase(resourceId, sql);

    if (jsonMode) {
      jsonOutput({ ok: true, ...result }, 0);
      return;
    }

    if (result.rows.length === 0) {
      if (result.meta.changes > 0) {
        consola.info(`${result.meta.changes} row(s) changed (${result.meta.duration.toFixed(1)}ms)`);
      } else {
        consola.info("No results.");
      }
      return;
    }

    // Print table
    const cols = result.columns;
    const widths = cols.map((c) => c.length);
    for (const row of result.rows) {
      for (let i = 0; i < cols.length; i++) {
        const val = String(row[cols[i]] ?? "NULL");
        widths[i] = Math.max(widths[i], val.length);
      }
    }

    // Cap column widths
    const maxWidth = 40;
    const cappedWidths = widths.map((w) => Math.min(w, maxWidth));

    const header = cols.map((c, i) => c.padEnd(cappedWidths[i])).join("  ");
    const separator = cappedWidths.map((w) => "─".repeat(w)).join("──");
    console.log(header);
    console.log(separator);
    for (const row of result.rows) {
      const line = cols
        .map((c, i) => {
          const val = String(row[c] ?? "NULL");
          return val.length > maxWidth ? val.slice(0, maxWidth - 1) + "…" : val.padEnd(cappedWidths[i]);
        })
        .join("  ");
      console.log(line);
    }
    consola.info(`\n${result.rows.length} row(s) · ${result.meta.duration.toFixed(1)}ms`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (jsonMode) {
      jsonOutput({ ok: false, error: "query_failed", message: msg }, 1);
    } else {
      consola.error(msg);
    }
  }
}

/** Escape a string for safe inlining inside a single-quoted SQL literal. */
function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

const migrateCommand = defineCommand({
  meta: {
    name: "migrate",
    description: "Apply pending SQL migrations to a team database. Reads .sql files from a migration directory, tracks applied state, executes in order.",
  },
  args: {
    // Accept the database name either as the first positional (`db migrate
    // <NAME>`) or as `--name <NAME>` — both spellings appear in docs/examples.
    // Defined as an option (not a positional) so `--name` parses; the bare
    // positional is read from args._ in run().
    name: {
      type: "string",
      description: "Database name (as shown by `creek db ls`). May also be given as the first positional argument.",
      required: false,
    },
    dir: {
      type: "string",
      description: "Migration directory path. Default: auto-detect drizzle/, drizzle/migrations/, prisma/migrations/, migrations/, sql/",
      required: false,
    },
    "dry-run": {
      type: "boolean",
      description: "Show pending migrations without executing them.",
      default: false,
    },
    resume: {
      type: "boolean",
      description: "Reconcile a partially-applied migration: if applying fails because objects already exist, mark it applied and continue. Use after an interrupted run.",
      default: false,
    },
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const dbName = args.name ?? (args._ as string[] | undefined)?.[0];
    if (!dbName) {
      const msg = "Database name required. Usage: `creek db migrate <NAME>` (or `--name <NAME>`).";
      if (jsonMode) jsonOutput({ ok: false, error: "missing_name", message: msg }, 1);
      consola.error(msg);
      process.exit(1);
    }
    const token = getToken();
    if (!token) {
      if (jsonMode) jsonOutput({ ok: false, error: "not_authenticated" }, 1, AUTH_BREADCRUMBS);
      consola.error("Not authenticated. Run `creek login` first.");
      process.exit(1);
    }
    const client = new CreekClient(getApiUrl(), token);

    // 1. Resolve database name → resource ID
    const { resources } = await client.listResources();
    const db = resources.find((r) => r.name === dbName && r.kind === "database");
    if (!db) {
      if (jsonMode) jsonOutput({ ok: false, error: "not_found", message: `No database named "${dbName}"` }, 1);
      consola.error(`No database named "${dbName}"`);
      process.exit(1);
    }

    // 2. Find migration directory
    const cwd = process.cwd();
    const migrationDir = args.dir ? resolve(cwd, args.dir) : detectMigrationDir(cwd);
    if (!migrationDir) {
      const msg = args.dir
        ? `Migration directory not found: ${args.dir}`
        : "No migration directory found. Looked for: drizzle/, drizzle/migrations/, prisma/migrations/, migrations/, sql/. Use --dir to specify.";
      if (jsonMode) jsonOutput({ ok: false, error: "no_migration_dir", message: msg }, 1);
      consola.error(msg);
      process.exit(1);
    }

    // 3. Read migration files
    const files = parseMigrationFiles(migrationDir);
    if (files.length === 0) {
      if (jsonMode) jsonOutput({ ok: true, message: "No .sql files found", applied: 0, pending: 0 }, 0);
      consola.info(`No .sql files found in ${migrationDir}`);
      return;
    }

    // 4. Create tracking table + query applied migrations
    try {
      await client.queryDatabase(db.id,
        `CREATE TABLE IF NOT EXISTS _creek_migrations (
          name TEXT PRIMARY KEY,
          applied_at INTEGER NOT NULL
        );`,
      );
    } catch (err) {
      const msg = `Failed to create migration tracking table: ${err instanceof Error ? err.message : String(err)}`;
      if (jsonMode) jsonOutput({ ok: false, error: "tracking_table_failed", message: msg }, 1);
      consola.error(msg);
      process.exit(1);
    }

    let appliedRows: { name: string }[];
    try {
      const result = await client.queryDatabase(db.id, "SELECT name FROM _creek_migrations ORDER BY name;");
      appliedRows = result.rows as { name: string }[];
    } catch (err) {
      const msg = `Failed to query applied migrations: ${err instanceof Error ? err.message : String(err)}`;
      if (jsonMode) jsonOutput({ ok: false, error: "query_failed", message: msg }, 1);
      consola.error(msg);
      process.exit(1);
    }

    const appliedSet = new Set(appliedRows.map((r) => r.name));
    const pending = computePending(files, appliedSet);

    // 5. Dry-run
    if (args["dry-run"]) {
      if (jsonMode) {
        jsonOutput({
          ok: true,
          dryRun: true,
          total: files.length,
          applied: appliedSet.size,
          pending: pending.map((f) => f.name),
        }, 0);
      } else if (pending.length === 0) {
        consola.success(`Database "${dbName}" is up to date (${appliedSet.size} applied)`);
      } else {
        consola.info(`${pending.length} pending migration(s):\n`);
        for (const f of pending) {
          consola.log(`  ${f.name}`);
        }
        consola.info(`\nRun without --dry-run to apply.`);
      }
      return;
    }

    // 6. Apply pending
    if (pending.length === 0) {
      if (jsonMode) jsonOutput({ ok: true, message: "up to date", applied: appliedSet.size, migrated: 0 }, 0);
      consola.success(`Database "${dbName}" is up to date (${appliedSet.size} applied)`);
      return;
    }

    consola.info(`Migrating "${dbName}": ${pending.length} pending of ${files.length} total\n`);

    let migrated = 0;
    let resumed = 0;
    for (const file of pending) {
      const sql = readFileSync(file.path, "utf-8");
      const statements = splitStatements(sql);

      if (statements.length === 0) {
        consola.warn(`  ${file.name} — empty, skipping`);
        continue;
      }

      consola.start(`  ${file.name} (${statements.length} statement${statements.length > 1 ? "s" : ""})`);

      // Apply the migration AND record it as applied in the same request: the
      // tracking insert rides along as the final statement. This closes the
      // window where the schema changed but the migration still looked pending
      // — an interrupted run between "apply" and a separate "record" used to
      // leave exactly that, unrecoverable without manual SQL. D1 runs a
      // multi-statement /query in one round-trip, so this stays ~1 request.
      const trackSql = `INSERT INTO _creek_migrations (name, applied_at) VALUES ('${escapeSqlLiteral(file.name)}', ${Date.now()});`;
      const batches = batchStatements([...statements, trackSql]);

      try {
        for (const batch of batches) {
          await client.queryDatabase(db.id, batch);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const alreadyExists = /already exists/i.test(msg);

        // --resume: a prior run applied this migration's schema but was
        // interrupted before recording it, so re-running collides with an
        // object that "already exists". Reconcile by marking it applied and
        // moving on, rather than getting stuck needing manual cleanup.
        if (args.resume && alreadyExists) {
          try {
            await client.queryDatabase(db.id, trackSql);
            consola.warn(`  ${file.name} — objects already exist; marked applied (--resume)`);
            resumed++;
            migrated++;
            continue;
          } catch (recordErr) {
            const rmsg = recordErr instanceof Error ? recordErr.message : String(recordErr);
            if (jsonMode) jsonOutput({ ok: false, error: "resume_failed", file: file.name, message: rmsg, migrated }, 1);
            consola.error(`  ${file.name} — resume failed: ${rmsg}`);
            process.exit(1);
          }
        }

        // The server's D1 error names the offending statement's SQL, so we
        // surface that rather than a now-meaningless global index.
        consola.error(`  ${file.name} — failed: ${msg}`);
        if (jsonMode) {
          jsonOutput({
            ok: false,
            error: "migration_failed",
            file: file.name,
            totalStatements: statements.length,
            message: msg,
            migrated,
            remaining: pending.length - migrated,
            ...(alreadyExists ? { hint: "Re-run with --resume to reconcile a partially-applied migration." } : {}),
          }, 1);
        }
        if (alreadyExists) {
          consola.info(`  If a previous run was interrupted, re-run with --resume to reconcile.`);
        }
        consola.error(`\n${migrated} migration(s) applied before failure. Fix the SQL and re-run.`);
        process.exit(1);
      }

      migrated++;
      consola.success(`  ${file.name}`);
    }

    if (jsonMode) {
      jsonOutput({ ok: true, migrated, resumed, total: files.length, applied: appliedSet.size + migrated }, 0);
    }
    consola.success(`\n${migrated} migration(s) applied successfully${resumed ? ` (${resumed} reconciled via --resume)` : ""}`);
  },
});

const SEED_CANDIDATES = [
  "drizzle/seed.sql",
  "drizzle/migrations/seed.sql",
  "migrations/seed.sql",
  "sql/seed.sql",
  "seed.sql",
];

const seedCommand = defineCommand({
  meta: {
    name: "seed",
    description: "Execute a seed SQL file against a team database. Looks for seed.sql in common locations or use --file to specify.",
  },
  args: {
    name: {
      type: "positional",
      description: "Database name (as shown by `creek db ls`)",
      required: true,
    },
    file: {
      type: "string",
      description: "Path to seed SQL file. Default: auto-detect seed.sql in drizzle/, migrations/, sql/, or project root.",
      required: false,
    },
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const token = getToken();
    if (!token) {
      if (jsonMode) jsonOutput({ ok: false, error: "not_authenticated" }, 1, AUTH_BREADCRUMBS);
      consola.error("Not authenticated. Run `creek login` first.");
      process.exit(1);
    }
    const client = new CreekClient(getApiUrl(), token);

    // Resolve database
    const { resources } = await client.listResources();
    const db = resources.find((r) => r.name === args.name && r.kind === "database");
    if (!db) {
      if (jsonMode) jsonOutput({ ok: false, error: "not_found", message: `No database named "${args.name}"` }, 1);
      consola.error(`No database named "${args.name}"`);
      process.exit(1);
    }

    // Find seed file
    const cwd = process.cwd();
    let seedPath: string | null = null;

    if (args.file) {
      seedPath = resolve(cwd, args.file);
      if (!existsSync(seedPath)) {
        if (jsonMode) jsonOutput({ ok: false, error: "file_not_found", message: `Seed file not found: ${args.file}` }, 1);
        consola.error(`Seed file not found: ${args.file}`);
        process.exit(1);
      }
    } else {
      for (const candidate of SEED_CANDIDATES) {
        const abs = resolve(cwd, candidate);
        if (existsSync(abs)) {
          seedPath = abs;
          break;
        }
      }
      if (!seedPath) {
        const msg = "No seed file found. Looked for: " + SEED_CANDIDATES.join(", ") + ". Use --file to specify.";
        if (jsonMode) jsonOutput({ ok: false, error: "no_seed_file", message: msg }, 1);
        consola.error(msg);
        process.exit(1);
      }
    }

    // Read and execute
    const sql = readFileSync(seedPath, "utf-8");
    const statements = splitStatements(sql);

    if (statements.length === 0) {
      if (jsonMode) jsonOutput({ ok: true, message: "Seed file is empty", executed: 0 }, 0);
      consola.info("Seed file is empty — nothing to execute.");
      return;
    }

    consola.info(`Seeding "${args.name}" from ${seedPath.replace(cwd + "/", "")}`);
    consola.info(`${statements.length} statement(s)\n`);

    for (let i = 0; i < statements.length; i++) {
      try {
        await client.queryDatabase(db.id, statements[i]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (jsonMode) {
          jsonOutput({
            ok: false,
            error: "seed_failed",
            statement: i + 1,
            totalStatements: statements.length,
            message: msg,
          }, 1);
        }
        consola.error(`Statement ${i + 1}/${statements.length} failed: ${msg}`);
        process.exit(1);
      }
    }

    if (jsonMode) jsonOutput({ ok: true, executed: statements.length }, 0);
    consola.success(`Seed complete (${statements.length} statement${statements.length > 1 ? "s" : ""})`);
  },
});

// Merge subcommands into the base resource command
export const dbCommand = defineCommand({
  meta: base.meta!,
  subCommands: {
    ...base.subCommands,
    shell: shellCommand,
    migrate: migrateCommand,
    seed: seedCommand,
  },
});
