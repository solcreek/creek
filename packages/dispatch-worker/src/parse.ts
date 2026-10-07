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

export interface WorkerLimits {
  cpuMs: number;
  subRequests: number;
}

/** Plans in upgrade order (matches the pricing page). */
export const PLANS = ["free", "starter", "pro", "enterprise"] as const;
export type Plan = (typeof PLANS)[number];

// Per-plan, per-request CPU + subrequest ceilings the dispatch Worker applies
// to each user worker via `DISPATCHER.get(name, {}, { limits })`. CPU time
// excludes I/O waits (D1/fetch/KV don't count); subrequests include binding
// calls (D1/KV/R2), not just fetch().
//
// A per-request ceiling is runaway protection (an infinite loop, mining), not
// cost control: CPU on Workers for Platforms is $0.02 per million ms, so the
// heaviest production app (30 days to 2026-10-07: 120k requests, CPU p50
// 345 ms / p99 1.9 s / max 3.9 s) cost about $1.1 of CPU a month. Every
// production team is on `free` today, so free must carry real SSR + database
// workloads with headroom over that app; paid tiers widen subrequests and the
// runaway ceiling. Workers Paid defaults are 30,000 ms CPU and 10,000
// subrequests.
export const PLAN_LIMITS: Record<Plan, WorkerLimits> = {
  free: { cpuMs: 5_000, subRequests: 200 },
  starter: { cpuMs: 15_000, subRequests: 1_000 },
  pro: { cpuMs: 30_000, subRequests: 5_000 },
  enterprise: { cpuMs: 120_000, subRequests: 10_000 },
};

function isPlan(plan: string): plan is Plan {
  return (PLANS as readonly string[]).includes(plan);
}

/** Limits for a team's plan; an unknown plan gets free's. */
export function getLimitsForPlan(plan: string): WorkerLimits {
  return isPlan(plan) ? PLAN_LIMITS[plan] : PLAN_LIMITS.free;
}

/**
 * The upgrade suggestion shown when a request hits its plan's limit: the next
 * plan up, or undefined on the top plan. An unknown plan is treated as free,
 * matching getLimitsForPlan.
 */
export function upgradeHintForPlan(plan: string): string | undefined {
  const index = PLANS.indexOf(isPlan(plan) ? plan : "free");
  const next = PLANS[index + 1];
  if (!next) return undefined;
  if (next === "enterprise") return "Contact us about Enterprise for higher limits.";
  return `Upgrade to ${next[0]!.toUpperCase()}${next.slice(1)} for higher limits.`;
}

/**
 * The 429 body for a user worker that threw because it hit its CPU or
 * subrequest limit, or null when the error is something else.
 */
export function limitExceededBody(
  errorMessage: string,
  plan: string,
  limits: WorkerLimits,
): { error: string; message: string; upgrade?: string } | null {
  if (errorMessage.includes("CPU time limit")) {
    return {
      error: "cpu_limit_exceeded",
      message: `CPU time limit exceeded (${limits.cpuMs}ms on ${plan} plan).`,
      upgrade: upgradeHintForPlan(plan),
    };
  }
  if (errorMessage.includes("subrequest limit")) {
    return {
      error: "subrequest_limit_exceeded",
      message: `Subrequest limit exceeded (${limits.subRequests} on ${plan} plan).`,
      upgrade: upgradeHintForPlan(plan),
    };
  }
  return null;
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
