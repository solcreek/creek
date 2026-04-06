import { resolve, basename } from "node:path";
import { existsSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import consola from "consola";
import { fetchTemplate } from "./fetch.js";
import { applyData } from "./apply-data.js";
import { validateData } from "./validate.js";

export interface ScaffoldOptions {
  template: string;
  dir: string;
  data?: Record<string, unknown>;
  install?: boolean;
  git?: boolean;
  silent?: boolean;
}

export interface ScaffoldResult {
  dir: string;
  template: string;
  name: string;
}

export async function scaffold(opts: ScaffoldOptions): Promise<ScaffoldResult> {
  const dest = resolve(opts.dir);
  const projectName = basename(dest);

  // 1. Fetch template
  if (!opts.silent) consola.start(`Downloading template: ${opts.template}`);
  const { dir, templateConfig, defaultData } = await fetchTemplate(
    opts.template,
    dest,
  );

  // 2. Validate user data against schema (if schema exists)
  const userData = { name: projectName, ...(opts.data ?? {}) };

  if (templateConfig?.schema) {
    const result = validateData(templateConfig.schema, { ...defaultData, ...userData });
    if (!result.valid) {
      consola.error("Data validation failed:");
      for (const err of result.errors) {
        consola.error(`  ${err.path}: ${err.message}`);
      }
      throw new Error("Template data validation failed");
    }
  }

  // 3. Apply data
  applyData(dir, userData, defaultData);

  // 4. Remove creek-template.json from output (metadata, not project file)
  const templateConfigPath = resolve(dir, "creek-template.json");
  if (existsSync(templateConfigPath)) {
    unlinkSync(templateConfigPath);
  }

  // 6. Install dependencies
  if (opts.install !== false) {
    const pkgPath = resolve(dir, "package.json");
    if (existsSync(pkgPath)) {
      if (!opts.silent) consola.start("Installing dependencies...");
      try {
        execSync("npm install", { cwd: dir, stdio: "pipe" });
        if (!opts.silent) consola.success("Dependencies installed");
      } catch {
        consola.warn("Failed to install dependencies. Run `npm install` manually.");
      }
    }
  }

  // 7. Git init
  if (opts.git !== false) {
    try {
      execSync("git init", { cwd: dir, stdio: "pipe" });
      execSync("git add -A", { cwd: dir, stdio: "pipe" });
      execSync('git commit -m "Initial commit from create-creek-app"', {
        cwd: dir,
        stdio: "pipe",
      });
      if (!opts.silent) consola.success("Git repository initialized");
    } catch {
      // git not available or failed — that's fine
    }
  }

  if (!opts.silent) {
    console.log("");
    consola.success(`Created ${projectName} with template "${opts.template}"`);
    console.log("");
    consola.info("  Next steps:");
    consola.info(`    cd ${projectName}`);
    consola.info("    creek deploy    Deploy to production");
    consola.info("    creek dev       Start local development");
  }

  return { dir, template: opts.template, name: projectName };
}
