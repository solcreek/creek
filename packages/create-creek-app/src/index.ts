#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import consola from "consola";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEMPLATES } from "./templates.js";
import { scaffold } from "./scaffold.js";
import { validateData } from "./validate.js";
import { fetchTemplate } from "./fetch.js";
import { promptTemplate, promptDir } from "./prompts.js";

const main = defineCommand({
  meta: {
    name: "create-creek-app",
    description: "Create a new Creek project from a template",
  },
  args: {
    dir: {
      type: "positional",
      description: "Project directory",
      required: false,
    },
    template: {
      type: "string",
      alias: "t",
      description: "Template name or github:user/repo",
    },
    data: {
      type: "string",
      description: "JSON data for template params",
    },
    "data-file": {
      type: "string",
      description: "Path to JSON file for template params",
    },
    list: {
      type: "boolean",
      description: "List available templates (JSON)",
      default: false,
    },
    schema: {
      type: "boolean",
      description: "Print template JSON Schema",
      default: false,
    },
    validate: {
      type: "boolean",
      description: "Validate data against template schema",
      default: false,
    },
    registry: {
      type: "string",
      description: "Private template registry URL (enterprise)",
    },
    yes: {
      type: "boolean",
      alias: "y",
      description: "Skip prompts, use defaults",
      default: false,
    },
    install: {
      type: "boolean",
      description: "Install dependencies (use --no-install to skip)",
      default: true,
    },
    git: {
      type: "boolean",
      description: "Initialize git repo (use --no-git to skip)",
      default: true,
    },
  },
  async run({ args }) {
    // --registry: enterprise placeholder
    if (args.registry) {
      console.log(
        JSON.stringify({
          error: "Private template registry is an enterprise feature. Coming soon — creek.dev/enterprise",
        }),
      );
      process.exit(0);
    }

    // --list: output JSON array of templates
    if (args.list) {
      console.log(JSON.stringify(TEMPLATES, null, 2));
      return;
    }

    // --schema: print template's JSON Schema
    if (args.schema) {
      const templateName = args.template;
      if (!templateName) {
        consola.error("--schema requires --template <name>");
        process.exit(1);
      }
      const { templateConfig } = await fetchTemplate(templateName, makeTempDir());
      if (!templateConfig?.schema) {
        consola.error(`Template "${templateName}" has no schema`);
        process.exit(1);
      }
      console.log(JSON.stringify(templateConfig.schema, null, 2));
      return;
    }

    // Parse user data from --data or --data-file
    let userData: Record<string, unknown> = {};
    if (args.data) {
      try {
        userData = JSON.parse(args.data);
      } catch {
        consola.error("Invalid JSON in --data");
        process.exit(1);
      }
    } else if (args["data-file"]) {
      try {
        userData = JSON.parse(readFileSync(args["data-file"], "utf-8"));
      } catch {
        consola.error(`Cannot read --data-file: ${args["data-file"]}`);
        process.exit(1);
      }
    }

    // --validate: validate data and exit
    if (args.validate) {
      const templateName = args.template;
      if (!templateName) {
        consola.error("--validate requires --template <name>");
        process.exit(1);
      }
      const { templateConfig, defaultData } = await fetchTemplate(templateName, makeTempDir());
      if (!templateConfig?.schema) {
        console.log(JSON.stringify({ valid: true, errors: [] }));
        return;
      }
      const merged = { ...defaultData, ...userData };
      const result = validateData(templateConfig.schema, merged);
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.valid ? 0 : 1);
    }

    // Interactive or direct scaffold
    let template = args.template;
    let dir = args.dir;

    if (!args.yes) {
      // Interactive mode
      if (!template) {
        template = await promptTemplate();
      }
      if (!dir) {
        dir = await promptDir();
      }
    } else {
      // Non-interactive: require --template, default dir
      if (!template) {
        template = "blank";
      }
      if (!dir) {
        dir = "my-creek-app";
      }
    }

    await scaffold({
      template,
      dir,
      data: userData,
      install: args.install,
      git: args.git,
      silent: false,
    });
  },
});

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "creek-tpl-"));
}

runMain(main);
