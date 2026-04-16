import { defineCommand } from "citty";
import consola from "consola";
import { createInterface } from "node:readline";
import { CreekClient } from "@solcreek/sdk";
import { createResourceCommand } from "./resource-cmd.js";
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

// Merge shell into the base resource command
export const dbCommand = defineCommand({
  meta: base.meta!,
  subCommands: {
    ...base.subCommands,
    shell: shellCommand,
  },
});
