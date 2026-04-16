import { defineCommand } from "citty";
import consola from "consola";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { CreekClient } from "@solcreek/sdk";
import { createResourceCommand } from "./resource-cmd.js";
import { detectMigrationDir, parseMigrationFiles, splitStatements, computePending } from "./migrate.js";
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
      description: "Database name (as shown by `creek db ls`)",
      required: true,
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

    // Resolve name → resource ID
    const { resources } = await client.listResources();
    const db = resources.find((r) => r.name === args.name && r.kind === "database");
    if (!db) {
      if (jsonMode) jsonOutput({ ok: false, error: "not_found", message: `No database named "${args.name}"` }, 1);
      consola.error(`No database named "${args.name}"`);
      process.exit(1);
    }

    // Single query mode
    if (args.sql) {
      await executeAndPrint(client, db.id, args.sql, jsonMode);
      return;
    }

    // Interactive REPL
    consola.info(`Connected to ${args.name} (${db.id.slice(0, 8)})`);
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

const migrateCommand = defineCommand({
  meta: {
    name: "migrate",
    description: "Apply pending SQL migrations to a team database. Reads .sql files from a migration directory, tracks applied state, executes in order.",
  },
  args: {
    name: {
      type: "positional",
      description: "Database name (as shown by `creek db ls`)",
      required: true,
    },
    dir: {
      type: "string",
      description: "Migration directory path. Default: auto-detect drizzle/, drizzle/migrations/, migrations/, sql/",
      required: false,
    },
    "dry-run": {
      type: "boolean",
      description: "Show pending migrations without executing them.",
      default: false,
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

    // 1. Resolve database name → resource ID
    const { resources } = await client.listResources();
    const db = resources.find((r) => r.name === args.name && r.kind === "database");
    if (!db) {
      if (jsonMode) jsonOutput({ ok: false, error: "not_found", message: `No database named "${args.name}"` }, 1);
      consola.error(`No database named "${args.name}"`);
      process.exit(1);
    }

    // 2. Find migration directory
    const cwd = process.cwd();
    const migrationDir = args.dir ? resolve(cwd, args.dir) : detectMigrationDir(cwd);
    if (!migrationDir) {
      const msg = args.dir
        ? `Migration directory not found: ${args.dir}`
        : "No migration directory found. Looked for: drizzle/, drizzle/migrations/, migrations/, sql/. Use --dir to specify.";
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
        consola.success(`Database "${args.name}" is up to date (${appliedSet.size} applied)`);
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
      consola.success(`Database "${args.name}" is up to date (${appliedSet.size} applied)`);
      return;
    }

    consola.info(`Migrating "${args.name}": ${pending.length} pending of ${files.length} total\n`);

    let migrated = 0;
    for (const file of pending) {
      const sql = readFileSync(file.path, "utf-8");
      const statements = splitStatements(sql);

      if (statements.length === 0) {
        consola.warn(`  ${file.name} — empty, skipping`);
        continue;
      }

      consola.start(`  ${file.name} (${statements.length} statement${statements.length > 1 ? "s" : ""})`);

      let failed = false;
      for (let i = 0; i < statements.length; i++) {
        try {
          await client.queryDatabase(db.id, statements[i]);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          consola.error(`  ${file.name} — statement ${i + 1}/${statements.length} failed: ${msg}`);
          if (jsonMode) {
            jsonOutput({
              ok: false,
              error: "migration_failed",
              file: file.name,
              statement: i + 1,
              totalStatements: statements.length,
              message: msg,
              migrated,
              remaining: pending.length - migrated,
            }, 1);
          }
          consola.error(`\n${migrated} migration(s) applied before failure. Fix the SQL and re-run.`);
          process.exit(1);
        }
      }

      // Record success
      try {
        await client.queryDatabase(db.id,
          "INSERT INTO _creek_migrations (name, applied_at) VALUES (?, ?);",
          [file.name, Date.now()],
        );
      } catch {
        // Non-fatal — migration ran but tracking failed. It won't re-run
        // because the schema changes already happened. Warn and continue.
        consola.warn(`  ${file.name} — applied but failed to record in tracking table`);
      }

      migrated++;
      consola.success(`  ${file.name}`);
    }

    if (jsonMode) {
      jsonOutput({ ok: true, migrated, total: files.length, applied: appliedSet.size + migrated }, 0);
    }
    consola.success(`\n${migrated} migration(s) applied successfully`);
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
