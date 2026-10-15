import { defineCommand } from "citty";
import { getToken, getApiUrl } from "../utils/config.js";
import { globalArgs, resolveJsonMode, jsonOutput, AUTH_BREADCRUMBS } from "../utils/output.js";

export const opsCommand = defineCommand({
  meta: {
    name: "ops",
    description: "Platform admin (self-hosted) — deployments, health",
  },
  args: {
    sub: {
      type: "positional",
      description: "Subcommand: deployments | health",
      required: false,
    },
    env: {
      type: "string",
      description: "Filter by environment: sandbox | production",
    },
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const sub = args.sub || "deployments";

    if (sub === "deployments") {
      return await listDeployments(jsonMode, args.env as string | undefined);
    }

    if (sub === "health") {
      return await health(jsonMode);
    }

    const message = `Unknown subcommand: ${sub}. Use: creek ops [deployments|health]`;
    if (jsonMode)
      jsonOutput(
        {
          ok: false,
          error: "unknown_command",
          message,
          usage: "creek ops [deployments|health]",
        },
        1,
        [{ command: "creek ops --help --json", description: "List ops subcommands" }],
      );
    console.error(message);
    process.exit(1);
  },
});

async function listDeployments(jsonMode: boolean, envFilter?: string) {
  const apiUrl = getApiUrl();
  const token = getToken();
  if (!token) {
    jsonOutput(
      { ok: false, error: "not_authenticated", message: "Not authenticated" },
      1,
      AUTH_BREADCRUMBS,
    );
  }

  // The control-plane reads API keys from x-api-key (it ignores Bearer).
  const res = await fetch(`${apiUrl}/web-deploy/list`, {
    headers: { "x-api-key": token! },
  });

  if (res.status === 401) {
    jsonOutput(
      { ok: false, error: "not_authenticated", message: "Invalid or expired API key" },
      1,
      AUTH_BREADCRUMBS,
    );
  }
  if (res.status === 403) {
    jsonOutput(
      {
        ok: false,
        error: "forbidden",
        message: "`creek ops deployments` requires a platform admin account",
      },
      1,
    );
  }
  if (!res.ok) {
    jsonOutput(
      { ok: false, error: "api_error", message: `Failed to fetch deployments: ${res.status}` },
      1,
    );
  }

  let deploys = (await res.json()) as any[];

  if (envFilter) {
    deploys = deploys.filter((d: any) => d.environment === envFilter);
  }

  if (jsonMode) {
    jsonOutput({
      ok: true,
      count: deploys.length,
      deploys,
      breadcrumbs: [{ command: "creek ops health", description: "Check platform health" }],
    });
  }

  // Human-readable output
  if (deploys.length === 0) {
    console.log("\n  No recent deployments (last 1 hour)\n");
    return;
  }

  const label = envFilter ? `Deployments — ${envFilter}` : "Deployments";
  console.log(`\n  ${label} (${deploys.length})\n`);

  const statusColors: Record<string, string> = {
    active: "\x1b[32m", // green
    building: "\x1b[34m", // blue
    deploying: "\x1b[33m", // yellow
    failed: "\x1b[31m", // red
  };
  const reset = "\x1b[0m";

  for (const d of deploys) {
    const color = statusColors[d.status] || "";
    const time = d.createdAt ? timeAgo(d.createdAt) : "";
    const preview = d.previewUrl ? ` → ${d.previewUrl}` : "";
    const error = d.error ? `\n           ${"\x1b[31m"}${d.error.slice(0, 80)}${reset}` : "";
    console.log(
      `  ${color}●${reset} ${d.buildId}  ${color}${d.status.padEnd(9)}${reset}  ${d.type || ""}  ${time}${preview}${error}`,
    );
  }

  console.log();

  // Summary
  const active = deploys.filter((d: any) => d.status === "active").length;
  const failed = deploys.filter((d: any) => d.status === "failed").length;
  const building = deploys.filter(
    (d: any) => d.status === "building" || d.status === "deploying",
  ).length;
  console.log(`  Active: ${active}  Failed: ${failed}  In progress: ${building}\n`);
}

async function health(jsonMode: boolean) {
  const apiUrl = getApiUrl();

  const checks: Record<string, string> = {};

  // Control plane
  try {
    const res = await fetch(`${apiUrl}/web-deploy/nonexistent`);
    checks["control-plane"] = res.status === 404 ? "ok" : `unexpected ${res.status}`;
  } catch (err) {
    checks["control-plane"] = `unreachable: ${err instanceof Error ? err.message : String(err)}`;
  }

  // Sandbox API — probe with empty POST (expect 400 validation error = alive)
  try {
    const res = await fetch("https://sandbox-api.creek.dev/api/sandbox/deploy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    checks["sandbox-api"] =
      res.status === 400 || res.status === 429 ? "ok" : `unexpected ${res.status}`;
  } catch (err) {
    checks["sandbox-api"] = `unreachable: ${err instanceof Error ? err.message : String(err)}`;
  }

  const failing = Object.entries(checks).filter(([, v]) => v !== "ok");
  if (jsonMode) {
    if (failing.length === 0) jsonOutput({ ok: true, checks });
    jsonOutput(
      {
        ok: false,
        error: "unhealthy",
        message: `Unhealthy: ${failing.map(([name, v]) => `${name} (${v})`).join(", ")}`,
        checks,
      },
      1,
    );
  }

  console.log("\n  Platform Health\n");
  for (const [name, status] of Object.entries(checks)) {
    const icon = status === "ok" ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
    console.log(`  ${icon} ${name}: ${status}`);
  }
  console.log();
  // Same exit code as --json: a script can check health without parsing.
  if (failing.length > 0) process.exit(1);
}

function timeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}
