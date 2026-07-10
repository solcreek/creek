import type { DeployTarget } from "./target.js";
import {
  creekdConfigFromEnv,
  assertValidCreekdId,
  spawnApp,
  deployApp,
  waitHealthy,
  type SpawnRequest,
} from "./creekd-client.js";

/**
 * Deploy a June app onto a creekd fleet — the self-host-on-VM / June Cloud
 * execution substrate. This is the productionized shape of the poc/june-cloud/
 * prototype: derive the app id, spawn (or blue-green redeploy) the June server
 * process on creekd via its admin API, and wait for it to pass its health probe.
 * creekd handles supervision + the injected PORT; June Cloud's front-door turns
 * the hostname into creekd's `x-creek-app` header routing.
 *
 * Honest scope: this owns the creekd *control* interaction (the part the PoC
 * proved and the part that's genuinely creekd-specific). Getting the built
 * artifact bytes onto the fleet host, and picking which host, are fleet-infra
 * concerns stubbed here — the command/entry are configured (CREEKD_JUNE_*), and
 * the port is derived deterministically as a placeholder for a real scheduler.
 */
export const creekdFleetTarget: DeployTarget = {
  async deploy(env, projectSlug, teamSlug, deploymentId, _input, _branch, _productionBranch) {
    const cfg = creekdConfigFromEnv(env);

    // `{project}-{team}` is both a valid creekd app id (^[a-z0-9][a-z0-9-]{0,62}$)
    // AND the hostname label — same convention as the CF path's script name, so
    // the front-door derives `{appId}.{CREEK_DOMAIN}` → appId without a registry.
    const appId = `${projectSlug}-${teamSlug}`;
    assertValidCreekdId(appId); // fail early + clearly if slugs make an invalid id
    const port = derivePort(appId);

    const spawn: SpawnRequest = {
      id: appId,
      command: env.CREEKD_JUNE_COMMAND ?? "bun",
      args: [env.CREEKD_JUNE_ENTRY ?? "server.js"],
      port,
      env: [
        `PORT=${port}`,
        `JUNE_PROJECT=${projectSlug}`,
        `JUNE_TEAM=${teamSlug}`,
        `JUNE_DEPLOYMENT=${deploymentId}`,
      ],
      health_check_path: "/health",
    };

    // Fresh app → spawn; existing id (409 already_running) → blue-green redeploy.
    const result = await spawnApp(cfg, spawn);
    if (result === "exists") {
      await deployApp(cfg, appId, {
        command: spawn.command,
        args: spawn.args,
        port,
        env: spawn.env,
        health_check_path: "/health",
      });
    }

    await waitHealthy(cfg, appId);
  },
};

/**
 * Deterministically map an app id to a port in [20000, 40000). A placeholder
 * for a real fleet scheduler (which would assign host + port and track them);
 * stable per-app so a redeploy targets the same slot. djb2 over the id.
 */
export function derivePort(appId: string): number {
  let h = 5381;
  for (let i = 0; i < appId.length; i++) h = (h * 33) ^ appId.charCodeAt(i);
  return 20000 + (Math.abs(h) % 20000);
}
