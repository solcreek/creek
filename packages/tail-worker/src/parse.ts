/**
 * scriptName → tenant identity.
 *
 * WfP script naming convention (set by deploy-core/src/deploy.ts):
 *   {project}-{team}                   → production
 *   {project}-git-{branch}-{team}      → branch preview
 *   {project}-{shortDeployId}-{team}   → deployment preview (8-hex)
 *
 * The team slug is part of the script name AND can itself contain
 * hyphens, so we can't tokenize blindly — we walk the team list
 * (longest first) and match by suffix. Same shape as the
 * dispatch-worker's hostname parser; we re-implement here because
 * input is a bare script name (no `.bycreek.com` to strip).
 *
 * Tail Worker pipeline relies on this parser to (a) drop trace
 * events from non-tenant scripts (control plane, dispatch-worker,
 * etc.) and (b) tag every log with the tenant tuple so R2 keys
 * and metrics dimensions are stable.
 */

export type ScriptType = "production" | "branch" | "deployment";

export interface ParsedScriptName {
  type: ScriptType;
  team: string;
  project: string;
  /** Set when type === "branch". Sanitized — same shape dispatch uses. */
  branch?: string;
  /** Set when type === "deployment". 8-hex short id. */
  deployId?: string;
}

export interface TeamInfo {
  slug: string;
  plan: string;
}

const SHORT_DEPLOY_ID = /^[0-9a-f]{8}$/;

/**
 * Parse a WfP script name. Returns null when the name doesn't match
 * any tenant pattern — Tail Worker uses null as the "drop this event"
 * signal (e.g. for the dispatch-worker's own traces).
 *
 * Teams MUST be sorted longest-slug-first (caller's responsibility, or
 * pass them already sorted from the DB query — see wrangler.toml).
 * Without that ordering, a team `a` would shadow `acme` for every
 * script ending in `-a-`-something.
 */
export function parseScriptName(
  scriptName: string,
  teams: TeamInfo[],
): ParsedScriptName | null {
  for (const team of teams) {
    const suffix = `-${team.slug}`;
    if (!scriptName.endsWith(suffix)) continue;
    const rest = scriptName.slice(0, -suffix.length);
    if (!rest) continue; // script name == "-{team}" — malformed

    // Branch preview: project-git-branch-team
    const gitIdx = rest.lastIndexOf("-git-");
    if (gitIdx !== -1) {
      const project = rest.slice(0, gitIdx);
      const branch = rest.slice(gitIdx + "-git-".length);
      if (project && branch) {
        return { type: "branch", team: team.slug, project, branch };
      }
    }

    // Deployment preview: project-{8hex}-team
    const lastDash = rest.lastIndexOf("-");
    if (lastDash !== -1) {
      const candidate = rest.slice(lastDash + 1);
      if (SHORT_DEPLOY_ID.test(candidate)) {
        const project = rest.slice(0, lastDash);
        if (project) {
          return { type: "deployment", team: team.slug, project, deployId: candidate };
        }
      }
    }

    // Production: project-team
    return { type: "production", team: team.slug, project: rest };
  }

  return null;
}
