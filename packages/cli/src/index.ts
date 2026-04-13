#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
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
import { doctorCommand } from "./commands/doctor.js";

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
    doctor: doctorCommand,
    login: loginCommand,
    whoami: whoamiCommand,
    init: initCommand,
    claim: claimCommand,
    env: envCommand,
    queue: queueCommand,
    domains: domainsCommand,
    rollback: rollbackCommand,
    ops: opsCommand,
  },
});

runMain(main);
