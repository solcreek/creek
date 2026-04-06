import { defineCommand } from "citty";
import consola from "consola";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { stringify } from "smol-toml";
import { detectFramework } from "@solcreek/sdk";
import { globalArgs, resolveJsonMode, jsonOutput, shouldAutoConfirm } from "../utils/output.js";

export const initCommand = defineCommand({
  meta: {
    name: "init",
    description: "Initialize a new Creek project",
  },
  args: {
    name: {
      type: "string",
      description: "Project name",
      required: false,
    },
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const cwd = process.cwd();
    const configPath = join(cwd, "creek.toml");

    if (existsSync(configPath)) {
      if (!shouldAutoConfirm(args)) {
        consola.warn("creek.toml already exists");
        const overwrite = await consola.prompt("Overwrite?", { type: "confirm" });
        if (!overwrite) return;
      }
    }

    // Detect framework
    const pkgPath = join(cwd, "package.json");
    let framework: string | undefined;
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const detected = detectFramework(pkg);
      if (detected) {
        framework = detected;
        if (!jsonMode) consola.info(`Detected framework: ${framework}`);
      }
    }

    const defaultName = basename(cwd).toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const name = args.name ?? defaultName;

    // Ask about database
    let useDb = false;
    if (!jsonMode && !shouldAutoConfirm(args)) {
      useDb = await consola.prompt("Add a database?", { type: "confirm" }) as unknown as boolean;
    }

    const config: Record<string, unknown> = {
      project: {
        name,
        ...(framework ? { framework } : {}),
      },
      build: {
        command: "npm run build",
        output: "dist",
        ...(useDb ? { worker: "worker/index.ts" } : {}),
      },
      resources: {
        d1: useDb,
        kv: false,
        r2: false,
      },
    };

    writeFileSync(configPath, stringify(config));

    // Scaffold worker + d1-schema example when database enabled
    if (useDb) {
      const workerDir = join(cwd, "worker");
      const workerFile = join(workerDir, "index.ts");

      if (!existsSync(workerFile)) {
        mkdirSync(workerDir, { recursive: true });
        writeFileSync(
          workerFile,
          `import { Hono } from "hono";
import { db } from "creek";
import { define } from "d1-schema";

const app = new Hono();

// Define your tables — auto-created on first request
app.use("*", async (c, next) => {
  await define(c.env.DB, {
    users: {
      id: "text primary key",
      email: "text unique not null",
      name: "text not null",
      created_at: "text default (datetime('now'))",
    },
  });
  return next();
});

app.get("/api/users", async (c) => {
  const users = await db.query("SELECT * FROM users");
  return c.json(users);
});

app.post("/api/users", async (c) => {
  const { email, name } = await c.req.json();
  const id = crypto.randomUUID().slice(0, 16);
  await db.mutate("INSERT INTO users (id, email, name) VALUES (?, ?, ?)", id, email, name);
  return c.json({ id, email, name });
});

export default app;
`,
        );

        if (!jsonMode) {
          consola.success("Created worker/index.ts with database example");
          consola.info("  Install dependencies: npm install hono creek d1-schema");
        }
      }
    }

    if (jsonMode) {
      jsonOutput({ ok: true, name, framework: framework ?? null, database: useDb, path: configPath }, 0, [
        { command: "creek deploy", description: "Deploy the project" },
        { command: "creek dev", description: "Start local development server" },
      ]);
    }

    consola.success(`Created creek.toml for "${name}"`);

    if (!jsonMode) {
      console.log("");
      consola.info("  Next steps:");
      consola.info("    creek deploy    Deploy to production");
      consola.info("    creek dev       Start local development");
    }
  },
});
