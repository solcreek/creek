import { defineCommand, type CommandDef } from "citty";
import { loginCommand } from "./commands/login.js";
import { whoamiCommand } from "./commands/whoami.js";
import { logoutCommand } from "./commands/logout.js";
import { keysCommand } from "./commands/keys.js";
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

/**
 * `cmd` with `meta.destructive` set. Only for commands whose definition
 * doesn't set it yet; set it in the definition instead when you touch one.
 */
function withDestructive<T extends CommandDef<any>>(cmd: T, destructive: boolean): T {
  return { ...cmd, meta: { ...(cmd.meta as object), destructive } };
}

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
      // Can replace what production serves (--prod).
      deploy: withDestructive(deployCommand, true),
      status: statusCommand,
      projects: projectsCommand,
      deployments: deploymentsCommand,
      logs: withDestructive(logsCommand, false),
      metrics: metricsCommand,
      doctor: doctorCommand,
      verify: verifyCommand,
      login: withDestructive(loginCommand, false),
      whoami: withDestructive(whoamiCommand, false),
      logout: logoutCommand,
      keys: keysCommand,
      // Overwrites an existing creek.toml (asks first in a TTY, not with --yes).
      init: withDestructive(initCommand, true),
      claim: claimCommand,
      env: envCommand,
      queue: queueCommand,
      db: dbCommand,
      storage: storageCommand,
      cache: cacheCommand,
      domains: domainsCommand,
      rollback: withDestructive(rollbackCommand, true),
      top: topCommand,
      dashboard: dashboardCommand,
      restart: restartCommand,
      stop: stopCommand,
      ops: withDestructive(opsCommand, false),
    },
  });
}
