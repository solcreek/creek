/**
 * Which deploys an environment variable applies to.
 *
 * - `production`: deploys of the production branch (or with no branch).
 * - `preview`: branch deploys.
 * - `all`: both — what every variable was before targets existed.
 *
 * A key may hold one value per target. A deploy uses the value for its own
 * target, else the `all` value, else the key is absent.
 */
export const ENV_TARGETS = ["all", "production", "preview"] as const;
export type EnvTarget = (typeof ENV_TARGETS)[number];
export type DeployTarget = Exclude<EnvTarget, "all">;

export function isEnvTarget(value: unknown): value is EnvTarget {
  return typeof value === "string" && (ENV_TARGETS as readonly string[]).includes(value);
}

/** The target a deploy is for. Same rule as deploy-job's isProduction. */
export function deployTargetFor(
  branch: string | null | undefined,
  productionBranch: string,
): DeployTarget {
  return !branch || branch === productionBranch ? "production" : "preview";
}

/**
 * Pick each key's value for a deploy to `target` from rows of any target:
 * the target's own value wins over `all`; other targets' values are dropped.
 */
export function selectForTarget<R extends { key: string; target: string }>(
  rows: readonly R[],
  target: DeployTarget,
): R[] {
  const chosen = new Map<string, R>();
  for (const row of rows) {
    if (row.target === target) chosen.set(row.key, row);
    else if (row.target === "all" && !chosen.has(row.key)) chosen.set(row.key, row);
  }
  return [...chosen.values()].sort((a, b) => a.key.localeCompare(b.key));
}
