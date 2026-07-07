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

// Per-plan CPU + subrequest ceilings the dispatch Worker applies to each user
// worker via `DISPATCHER.get(name, {}, { limits })`. CPU time excludes I/O
// waits (D1/fetch/KV don't count), but an SSR render plus a cold Prisma
// query-compiler WASM start can still cost hundreds of ms of pure CPU — and a
// page makes several subrequests. The earlier values (free 10ms / 5 reqs) were
// CF's doc-example numbers and throttled every SSR + database app to an
// immediate "exceeded CPU time limit" exception on every route. These track
// closer to the platform CPU defaults (Workers Paid default is 30,000ms) so
// SSR works on every plan, with headroom widening up the tiers.
export const PLAN_LIMITS: Record<string, { cpuMs: number; subRequests: number }> = {
  free: { cpuMs: 1000, subRequests: 50 },
  pro: { cpuMs: 5000, subRequests: 200 },
  enterprise: { cpuMs: 30000, subRequests: 1000 },
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
