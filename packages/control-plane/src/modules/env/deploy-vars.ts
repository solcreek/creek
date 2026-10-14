import { selectForTarget, type DeployTarget } from "./targets.js";
import { envTargetsAvailable } from "./schema-compat.js";

/** One environment variable as a deploy gets it, still encrypted. */
export interface DeployEnvVarRow {
  key: string;
  target: string;
  encryptedValue: string;
}

/**
 * The environment variables a deploy to `target` gets: each key's value for
 * that target, else its `all` value. The deploy job injects these, and the
 * upload check reads the same set to find names that collide with bindings.
 */
export async function loadDeployEnvVars(
  db: D1Database,
  projectId: string,
  target: DeployTarget,
): Promise<DeployEnvVarRow[]> {
  // Before migration 0013 every variable is an all-deploys value.
  const rows = await (
    (await envTargetsAvailable(db))
      ? db
          .prepare(
            "SELECT key, target, encryptedValue FROM environment_variable WHERE projectId = ? AND target IN ('all', ?)",
          )
          .bind(projectId, target)
      : db
          .prepare(
            "SELECT key, 'all' AS target, encryptedValue FROM environment_variable WHERE projectId = ?",
          )
          .bind(projectId)
  ).all<DeployEnvVarRow>();
  return selectForTarget(rows.results, target);
}
