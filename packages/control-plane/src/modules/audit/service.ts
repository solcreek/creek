import type { D1Database } from "@cloudflare/workers-types";
import type { AuditEntry, AuditRequestContext } from "./types.js";
import type { AuthUser } from "../tenant/types.js";

export async function hashIp(ip: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(ip + salt);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

/**
 * Record an audit log entry. Uses DB.batch() for a single round-trip.
 * Errors are caught and logged — audit failure must never break the user-facing operation.
 */
export async function recordAudit(
  db: D1Database,
  user: AuthUser,
  teamId: string,
  entry: AuditEntry,
  reqCtx: AuditRequestContext,
): Promise<void> {
  const id = crypto.randomUUID();
  const now = Date.now();

  try {
    await db.batch([
      db.prepare(
        `INSERT INTO audit_log (id, teamId, userId, userEmail, action, resourceType, resourceId, metadata, ipHash, country, userAgent, cfRay, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        teamId,
        user.id,
        user.email,
        entry.action,
        entry.resourceType,
        entry.resourceId ?? null,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
        reqCtx.ipHash,
        reqCtx.country,
        reqCtx.userAgent?.slice(0, 512) ?? null,
        reqCtx.cfRay,
        now,
      ),
      db.prepare(
        "INSERT INTO audit_ip_log (auditLogId, rawIp, createdAt) VALUES (?, ?, ?)",
      ).bind(id, reqCtx.ip, now),
    ]);
  } catch (err) {
    // Audit failure must never break the user-facing operation
    console.error("[audit] Failed to record audit log:", err);
  }
}

/** Purge raw IP logs older than 30 days. */
export async function purgeAuditIpLogs(db: D1Database): Promise<number> {
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const result = await db.prepare(
    "DELETE FROM audit_ip_log WHERE createdAt < ?",
  ).bind(thirtyDaysAgo).run();
  return result.meta.changes ?? 0;
}
