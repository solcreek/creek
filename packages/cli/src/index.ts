#!/usr/bin/env node
import consola from "consola";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { createMain } from "./command-tree.js";
import { runCli, wantsJson } from "./cli-runner.js";
import { installRequestLedger } from "./utils/request-ledger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));

// Read version from the "creek" facade package (what users install),
// falling back to CLI's own version if not available.
let version = cliPkg.version;
try {
  const require = createRequire(import.meta.url);
  const facadePkg = require("creek/package.json");
  version = facadePkg.version;
} catch {
  // Running outside facade (e.g. workspace dev) — use CLI version
}

const main = createMain(version);

const rawArgs = process.argv.slice(2);
const jsonMode = wantsJson(rawArgs, process.stdout.isTTY ?? false);
// Before any command runs: a network failure then knows whether this run
// may already have changed something (utils/request-ledger.ts).
installRequestLedger();
runCli(main, rawArgs, { jsonMode }).catch((err) => {
  // Non-CLIError runtime failure that no command handled. Keep citty's
  // human behaviour: error to stderr, exit non-zero.
  consola.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
