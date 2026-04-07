import { defineCommand } from "citty";
import { getToken, getApiUrl } from "../utils/config.js";
import { globalArgs, resolveJsonMode, jsonOutput } from "../utils/output.js";

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
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const sub = args.sub || "deployments";

    if (sub === "deployments") {
      return await listDeployments(jsonMode);
    }

    if (sub === "health") {
      return await health(jsonMode);
    }

    jsonOutput({ error: `Unknown subcommand: ${sub}`, usage: "creek ops [deployments|health]" }, 1);
  },
});

async function listDeployments(jsonMode: boolean) {
  const apiUrl = getApiUrl();
  const token = getToken();
  if (!token) {
    jsonOutput({ error: "Not authenticated", hint: "Run `creek login` first" }, 1);
  }

  const res = await fetch(`${apiUrl}/web-deploy/list`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    jsonOutput({ error: `Failed to fetch deployments: ${res.status}` }, 1);
  }

  const deploys = await res.json() as any[];

  if (jsonMode) {
    jsonOutput({
      ok: true,
      count: deploys.length,
      deploys,
      breadcrumbs: [
        { command: "creek ops health", description: "Check platform health" },
      ],
    });
  }

  // Human-readable output
  if (deploys.length === 0) {
    console.log("\n  No recent deployments (last 1 hour)\n");
    return;
  }

  console.log(`\n  Web Deploys (${deploys.length} in last hour)\n`);

  const statusColors: Record<string, string> = {
    active: "\x1b[32m",   // green
    building: "\x1b[34m", // blue
    deploying: "\x1b[33m", // yellow
    failed: "\x1b[31m",   // red
  };
  const reset = "\x1b[0m";

  for (const d of deploys) {
    const color = statusColors[d.status] || "";
    const time = d.createdAt ? timeAgo(d.createdAt) : "";
    const preview = d.previewUrl ? ` → ${d.previewUrl}` : "";
    const error = d.error ? `\n           ${"\x1b[31m"}${d.error.slice(0, 80)}${reset}` : "";
    console.log(`  ${color}●${reset} ${d.buildId}  ${color}${d.status.padEnd(9)}${reset}  ${d.type || ""}  ${time}${preview}${error}`);
  }

  console.log();

  // Summary
  const active = deploys.filter((d: any) => d.status === "active").length;
  const failed = deploys.filter((d: any) => d.status === "failed").length;
  const building = deploys.filter((d: any) => d.status === "building" || d.status === "deploying").length;
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
    checks["sandbox-api"] = res.status === 400 || res.status === 429 ? "ok" : `unexpected ${res.status}`;
  } catch (err) {
    checks["sandbox-api"] = `unreachable: ${err instanceof Error ? err.message : String(err)}`;
  }

  if (jsonMode) {
    const allOk = Object.values(checks).every((v) => v === "ok");
    jsonOutput({ ok: allOk, checks });
  }

  console.log("\n  Platform Health\n");
  for (const [name, status] of Object.entries(checks)) {
    const icon = status === "ok" ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
    console.log(`  ${icon} ${name}: ${status}`);
  }
  console.log();
}

function timeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}
