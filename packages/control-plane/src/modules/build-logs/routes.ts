/**
 * Build-log routes.
 *
 * Phase 1:
 *   POST /builds/:id/logs — ingestion. Accepts ndjson body, stores
 *     compressed to R2, upserts D1 metadata. Accepts either:
 *       - Authorization: Bearer ${INTERNAL_SECRET}  (internal services:
 *         remote-builder, build-container, webhook handlers)
 *       - Better Auth session via tenantMiddleware (CLI)
 *
 * Phase 2 (not here):
 *   Streaming ingest via Realtime DO subscribe; per-line flush.
 */

import { Hono } from "hono";
import type { Env } from "../../types.js";
import type { AuthUser } from "../tenant/types.js";
import { tenantMiddleware } from "../tenant/index.js";
import { storeBuildLog } from "./storage.js";
import type { BuildLogStatus } from "./types.js";

type BuildLogsEnv = {
  Bindings: Env;
  Variables: {
    user?: AuthUser;
    teamId?: string;
    teamSlug?: string;
  };
};

export const buildLogs = new Hono<BuildLogsEnv>();

// --- Helpers --------------------------------------------------------

async function resolveDeployment(
  env: Env,
  deploymentId: string,
): Promise<{ projectSlug: string; teamSlug: string; teamId: string } | null> {
  const row = await env.DB.prepare(
    `SELECT p.slug AS projectSlug, t.slug AS teamSlug, t.id AS teamId
     FROM deployment d
     JOIN project p ON d.projectId = p.id
     JOIN organization t ON p.organizationId = t.id
     WHERE d.id = ?`,
  )
    .bind(deploymentId)
    .first<{ projectSlug: string; teamSlug: string; teamId: string }>();
  return row ?? null;
}

function isInternalAuth(c: { req: { header: (n: string) => string | undefined }; env: Env }): boolean {
  const header = c.req.header("Authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const token = header.slice("Bearer ".length).trim();
  return Boolean(c.env.INTERNAL_SECRET) && token === c.env.INTERNAL_SECRET;
}

// --- POST /builds/:id/logs ------------------------------------------
//
// Two auth paths sit behind the same handler. Internal callers send
// INTERNAL_SECRET; CLI/dashboard users go through tenantMiddleware.
// We split the handler so each path gets the right middleware chain.

buildLogs.post("/:id/logs", async (c, next) => {
  if (isInternalAuth(c)) return ingestHandler(c, { internal: true });
  // Fall through to the authenticated path below.
  await next();
});

buildLogs.post("/:id/logs", tenantMiddleware, async (c) => ingestHandler(c, { internal: false }));

async function ingestHandler(
  c: {
    req: {
      param: (k: string) => string;
      query: (k: string) => string | undefined;
      text: () => Promise<string>;
    };
    env: Env;
    get: <K extends keyof BuildLogsEnv["Variables"]>(k: K) => BuildLogsEnv["Variables"][K];
    json: (obj: unknown, status?: number) => Response;
  },
  opts: { internal: boolean },
): Promise<Response> {
  const deploymentId = c.req.param("id");
  if (!deploymentId) {
    return c.json({ error: "validation", message: "id required" }, 400);
  }

  const owner = await resolveDeployment(c.env, deploymentId);
  if (!owner) {
    return c.json({ error: "not_found", message: "deployment not found" }, 404);
  }

  // For authenticated (non-internal) callers, the deployment's team
  // must match the session's team.
  if (!opts.internal) {
    const sessionTeamId = c.get("teamId");
    if (!sessionTeamId || sessionTeamId !== owner.teamId) {
      return c.json(
        { error: "forbidden", message: "deployment not owned by session team" },
        403,
      );
    }
  }

  const status = (c.req.query("status") ?? "success") as BuildLogStatus;
  if (status !== "success" && status !== "failed" && status !== "running") {
    return c.json({ error: "validation", message: "invalid status" }, 400);
  }

  const errorCode = c.req.query("errorCode") ?? null;
  const errorStep = c.req.query("errorStep") ?? null;
  const startedAtRaw = c.req.query("startedAt");
  const startedAt = startedAtRaw ? Number(startedAtRaw) : Date.now();

  const body = await c.req.text();

  const result = await storeBuildLog(c.env, {
    team: owner.teamSlug,
    project: owner.projectSlug,
    deploymentId,
    status,
    startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
    endedAt: Date.now(),
    body,
    errorCode,
    errorStep,
  });

  return c.json({ ok: true, ...result });
}
