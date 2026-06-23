#!/usr/bin/env node
import { defineCommand } from "citty";
import consola from "consola";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { loginCommand } from "./commands/login.js";
import { whoamiCommand } from "./commands/whoami.js";
import { initCommand } from "./commands/init.js";
import { deployCommand } from "./commands/deploy.js";
import { claimCommand } from "./commands/claim.js";
import { envCommand } from "./commands/env.js";
import { domainsCommand } from "./commands/domains.js";
import { projectsCommand } from "./commands/projects.js";
import { deploymentsCommand } from "./commands/deployments.js";
import { statusCommand } from "./commands/status.js";
import { devCommand } from "./commands/dev.js";
import { rollbackCommand } from "./commands/rollback.js";
import { opsCommand } from "./commands/ops.js";
import { queueCommand } from "./commands/queue.js";
import { logsCommand } from "./commands/logs.js";
import { metricsCommand } from "./commands/metrics.js";
import { doctorCommand } from "./commands/doctor.js";
import { dbCommand } from "./commands/db.js";
import { storageCommand } from "./commands/storage.js";
import { cacheCommand } from "./commands/cache.js";
import { topCommand } from "./commands/top.js";
import { restartCommand } from "./commands/restart.js";
import { stopCommand } from "./commands/stop.js";
import { dashboardCommand } from "./commands/dashboard.js";
import { runCli, wantsJson } from "./cli-runner.js";

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

const main = defineCommand({
  meta: {
    name: "⬡ creek",
    version,
    description: "Deploy full-stack apps to the edge",
  },
  subCommands: {
    dev: devCommand,
    deploy: deployCommand,
    status: statusCommand,
    projects: projectsCommand,
    deployments: deploymentsCommand,
    logs: logsCommand,
    metrics: metricsCommand,
    doctor: doctorCommand,
    login: loginCommand,
    whoami: whoamiCommand,
    init: initCommand,
    claim: claimCommand,
    env: envCommand,
    queue: queueCommand,
    db: dbCommand,
    storage: storageCommand,
    cache: cacheCommand,
    domains: domainsCommand,
    rollback: rollbackCommand,
    top: topCommand,
    dashboard: dashboardCommand,
    restart: restartCommand,
    stop: stopCommand,
    ops: opsCommand,
  },
});

const rawArgs = process.argv.slice(2);
const jsonMode = wantsJson(rawArgs, process.stdout.isTTY ?? false);
runCli(main, rawArgs, { jsonMode }).catch((err) => {
  // Non-CLIError runtime failure that no command handled. Keep citty's
  // human behaviour: error to stderr, exit non-zero.
  consola.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
