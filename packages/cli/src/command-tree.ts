import { defineCommand } from "citty";
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
import { verifyCommand } from "./commands/verify.js";
import { dbCommand } from "./commands/db.js";
import { storageCommand } from "./commands/storage.js";
import { cacheCommand } from "./commands/cache.js";
import { topCommand } from "./commands/top.js";
import { restartCommand } from "./commands/restart.js";
import { stopCommand } from "./commands/stop.js";
import { dashboardCommand } from "./commands/dashboard.js";

/** The `creek` command tree. index.ts runs it; the help schema test walks it. */
export function createMain(version: string) {
  return defineCommand({
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
      verify: verifyCommand,
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
}
