export interface ParsedHostname {
  type: "production" | "branch" | "deployment" | "custom";
  team?: string;
  project?: string;
  branch?: string;
  deployId?: string;
  customHostname?: string;
}

export interface TeamInfo {
  slug: string;
  plan: string;
}

export const PLAN_LIMITS: Record<string, { cpuMs: number; subRequests: number }> = {
  free:       { cpuMs: 10,  subRequests: 5 },
  pro:        { cpuMs: 50,  subRequests: 50 },
  enterprise: { cpuMs: 500, subRequests: 1000 },
};

export function getLimitsForPlan(plan: string) {
  return PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;
}

/**
 * Parse a hostname into its components given a known list of teams.
 * Pure function — no DB access.
 */
export function parseHostnameWithTeams(
  hostname: string,
  domain: string,
  teams: TeamInfo[],
): ParsedHostname {
  const suffix = `.${domain}`;
  if (!hostname.endsWith(suffix)) {
    return { type: "custom", customHostname: hostname };
  }

  const sub = hostname.slice(0, -suffix.length);
  if (!sub || sub.includes(".")) {
    return { type: "custom", customHostname: hostname };
  }

  for (const team of teams) {
    if (!sub.endsWith(`-${team.slug}`)) continue;
    const rest = sub.slice(0, -(team.slug.length + 1));
    if (!rest) continue;

    const gitIdx = rest.lastIndexOf("-git-");
    if (gitIdx !== -1) {
      return {
        type: "branch",
        team: team.slug,
        project: rest.slice(0, gitIdx),
        branch: rest.slice(gitIdx + 5),
      };
    }

    const lastDash = rest.lastIndexOf("-");
    if (lastDash !== -1) {
      const candidate = rest.slice(lastDash + 1);
      if (/^[0-9a-f]{8}$/.test(candidate)) {
        return {
          type: "deployment",
          team: team.slug,
          project: rest.slice(0, lastDash),
          deployId: candidate,
        };
      }
    }

    return { type: "production", team: team.slug, project: rest };
  }

  return { type: "custom", customHostname: hostname };
}
