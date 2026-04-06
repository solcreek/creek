import {
  type ParsedHostname,
  type TeamInfo,
  getLimitsForPlan,
  parseHostnameWithTeams,
} from "./parse.js";

interface Env {
  DISPATCHER: {
    get(
      name: string,
      metadata?: Record<string, unknown>,
      options?: { limits?: { cpuMs?: number; subRequests?: number } },
    ): { fetch(request: Request): Promise<Response> };
  };
  DB: D1Database;
  CREEK_DOMAIN: string;
}

// --- Team cache (slug + plan) ---

let teamsCache: TeamInfo[] = [];
let teamsCacheTime = 0;
const TEAM_CACHE_TTL = 5 * 60 * 1000;

async function getTeams(db: D1Database): Promise<TeamInfo[]> {
  if (Date.now() - teamsCacheTime < TEAM_CACHE_TTL) return teamsCache;
  const rows = await db
    .prepare("SELECT slug, plan FROM organization ORDER BY length(slug) DESC")
    .all<TeamInfo>();
  teamsCache = rows.results;
  teamsCacheTime = Date.now();
  return teamsCache;
}

// --- Hostname parsing (delegates to pure function) ---

async function parseHostname(
  hostname: string,
  domain: string,
  db: D1Database,
): Promise<ParsedHostname> {
  const teams = await getTeams(db);
  return parseHostnameWithTeams(hostname, domain, teams);
}

// --- Script resolution ---

async function resolveScriptName(
  parsed: ParsedHostname,
  db: D1Database,
): Promise<string | null> {
  switch (parsed.type) {
    case "production": {
      const row = await db
        .prepare(
          `SELECT p.productionDeploymentId FROM project p
           JOIN organization t ON p.organizationId = t.id
           WHERE p.slug = ? AND t.slug = ?`,
        )
        .bind(parsed.project, parsed.team)
        .first<{ productionDeploymentId: string | null }>();
      if (!row?.productionDeploymentId) return null;
      return `${parsed.project}-${parsed.team}`;
    }

    case "branch": {
      const row = await db
        .prepare(
          `SELECT d.id FROM deployment d
           JOIN project p ON d.projectId = p.id
           JOIN organization t ON p.organizationId = t.id
           WHERE p.slug = ? AND t.slug = ? AND d.branch = ?
             AND d.status = 'active'
           ORDER BY d.createdAt DESC LIMIT 1`,
        )
        .bind(parsed.project, parsed.team, parsed.branch)
        .first<{ id: string }>();
      if (!row) return null;
      return `${parsed.project}-git-${parsed.branch}-${parsed.team}`;
    }

    case "deployment":
      return `${parsed.project}-${parsed.deployId}-${parsed.team}`;

    case "custom": {
      const row = await db
        .prepare(
          `SELECT p.slug, t.slug as team_slug FROM custom_domain cd
           JOIN project p ON cd.projectId = p.id
           JOIN organization t ON p.organizationId = t.id
           WHERE cd.hostname = ? AND cd.status = 'active'`,
        )
        .bind(parsed.customHostname)
        .first<{ slug: string; team_slug: string }>();
      if (!row) return null;
      return `${row.slug}-${row.team_slug}`;
    }
  }
}

// --- Resolve team plan for custom domains ---

async function resolveTeamPlan(
  parsed: ParsedHostname,
  db: D1Database,
): Promise<string> {
  if (parsed.team) {
    const teams = await getTeams(db);
    const team = teams.find((t) => t.slug === parsed.team);
    return team?.plan ?? "free";
  }

  if (parsed.type === "custom") {
    const row = await db
      .prepare(
        `SELECT t.plan FROM custom_domain cd
         JOIN project p ON cd.projectId = p.id
         JOIN organization t ON p.organizationId = t.id
         WHERE cd.hostname = ? AND cd.status = 'active'`,
      )
      .bind(parsed.customHostname)
      .first<{ plan: string }>();
    return row?.plan ?? "free";
  }

  return "free";
}

// --- MIME type inference ---
// WfP Static Assets does not set Content-Type on responses.
// This is a known limitation — we infer from file extension.

const MIME_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  wasm: "application/wasm",
  map: "application/json; charset=utf-8",
};

function inferContentType(pathname: string): string {
  const lastSegment = pathname.split("/").pop() ?? "";
  const ext = lastSegment.includes(".") ? lastSegment.split(".").pop()?.toLowerCase() ?? "" : "";
  if (!ext) return "text/html; charset=utf-8"; // Extensionless = SPA route
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

// --- Main handler ---

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const hostname = new URL(request.url).hostname;

    // NOTE: No dispatch-level edge cache.
    // WfP Static Assets has its own CDN cache layer.
    // Adding caches.default here would create a stale layer
    // that doesn't invalidate on redeploy.

    const parsed = await parseHostname(hostname, env.CREEK_DOMAIN, env.DB);
    const scriptName = await resolveScriptName(parsed, env.DB);

    if (!scriptName) {
      return new Response("Not Found", { status: 404 });
    }

    // Resolve plan-based limits
    const plan = await resolveTeamPlan(parsed, env.DB);
    const limits = getLimitsForPlan(plan);

    try {
      // Forward Cloudflare geo data to user workers via headers
      const cf = (request as any).cf as Record<string, string> | undefined;
      const forwarded = new Request(request);
      if (cf?.country) forwarded.headers.set("cf-ipcountry", cf.country);
      if (cf?.city) forwarded.headers.set("cf-ipcity", cf.city);
      if (cf?.colo) forwarded.headers.set("cf-ipcolo", cf.colo);

      const userWorker = env.DISPATCHER.get(scriptName, {}, { limits });
      let response = await userWorker.fetch(forwarded);

      // WfP Static Assets does not set Content-Type — infer from URL extension
      if (response.ok && !response.headers.get("Content-Type")) {
        const pathname = new URL(request.url).pathname;
        const contentType = inferContentType(pathname);
        const headers = new Headers(response.headers);
        headers.set("Content-Type", contentType);
        response = new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }

      return response;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);

      if (message.startsWith("Worker not found")) {
        return new Response(`Deployment '${scriptName}' not found`, {
          status: 404,
        });
      }

      if (message.includes("CPU time limit")) {
        return new Response(
          JSON.stringify({
            error: "cpu_limit_exceeded",
            message: `CPU time limit exceeded (${limits.cpuMs}ms on ${plan} plan).`,
            upgrade: plan === "free" ? "Upgrade to Pro for higher limits." : undefined,
          }),
          { status: 429, headers: { "Content-Type": "application/json" } },
        );
      }

      if (message.includes("subrequest limit")) {
        return new Response(
          JSON.stringify({
            error: "subrequest_limit_exceeded",
            message: `Subrequest limit exceeded (${limits.subRequests} on ${plan} plan).`,
            upgrade: plan === "free" ? "Upgrade to Pro for higher limits." : undefined,
          }),
          { status: 429, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(`Error: ${message}`, { status: 500 });
    }
  },
};
