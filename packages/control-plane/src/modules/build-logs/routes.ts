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
import { requirePermission } from "../tenant/permissions.js";
import { storeBuildLog } from "./storage.js";
import type { BuildLogLine, BuildLogStatus } from "./types.js";

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

// --- Read routes (mounted under /projects) --------------------------
//
// GET /projects/:slug/deployments/:id/logs — dashboard + CLI read path.
// Tenant check via tenantMiddleware; ownership cross-checked against
// the deployment's project.
export const buildLogsRead = new Hono<BuildLogsEnv>();

buildLogsRead.get(
  "/:slug/deployments/:id/logs",
  requirePermission("project:read"),
  async (c) => {
    const projectSlug = c.req.param("slug");
    const deploymentId = c.req.param("id");
    const teamId = c.get("teamId");
    if (!teamId) return c.json({ error: "unauthorized" }, 401);

    // Ownership: the deployment's project.slug + project.organizationId
    // must match the URL slug + session team.
    const row = await c.env.DB.prepare(
      `SELECT p.slug AS projectSlug, t.slug AS teamSlug
       FROM deployment d
       JOIN project p ON d.projectId = p.id
       JOIN organization t ON p.organizationId = t.id
       WHERE d.id = ? AND p.slug = ? AND t.id = ?`,
    )
      .bind(deploymentId, projectSlug, teamId)
      .first<{ projectSlug: string; teamSlug: string }>();
    if (!row) {
      return c.json({ error: "not_found" }, 404);
    }

    // Metadata row — covers the "still running / never uploaded" cases.
    const meta = await c.env.DB.prepare(
      `SELECT deploymentId, status, startedAt, endedAt, bytes, lines,
              truncated, errorCode, errorStep, r2Key
       FROM build_log WHERE deploymentId = ?`,
    )
      .bind(deploymentId)
      .first<{
        deploymentId: string;
        status: string;
        startedAt: number;
        endedAt: number | null;
        bytes: number;
        lines: number;
        truncated: number;
        errorCode: string | null;
        errorStep: string | null;
        r2Key: string;
      }>();

    if (!meta) {
      return c.json({
        entries: [] as BuildLogLine[],
        metadata: null,
        message: "Build log not yet available — the deploy may still be running or never uploaded logs.",
      });
    }

    if (!c.env.LOGS_BUCKET) {
      return c.json({ error: "logs_unavailable" }, 503);
    }

    const object = await c.env.LOGS_BUCKET.get(meta.r2Key);
    if (!object) {
      // D1 row exists but R2 object missing — consistency issue.
      return c.json(
        {
          entries: [] as BuildLogLine[],
          metadata: meta,
          message: "Log archive not found",
        },
        200,
      );
    }

    // Decompress the gzipped ndjson in-worker. R2 does NOT auto-decode
    // contentEncoding on .get() — it returns raw bytes.
    const decoded = await new Response(
      object.body!.pipeThrough(new DecompressionStream("gzip")),
    ).text();

    const entries: BuildLogLine[] = [];
    for (const line of decoded.split("\n")) {
      if (!line) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // Non-JSON residue from scrubNdjson fallback path — skip.
      }
    }

    return c.json({
      entries,
      metadata: {
        ...meta,
        truncated: Boolean(meta.truncated),
      },
    });
  },
);

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
