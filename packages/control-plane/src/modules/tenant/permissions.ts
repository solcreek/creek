import type { Context, Next } from "hono";
import type { Env } from "../../types.js";
import type { AuthUser } from "./types.js";

export type Permission =
  | "project:read"
  | "project:create"
  | "project:delete"
  | "deploy:read"
  | "deploy:create"
  | "envvar:manage"
  | "domain:manage"
  | "member:manage"
  | "team:delete";

const ALL_PERMISSIONS: Permission[] = [
  "project:read",
  "project:create",
  "project:delete",
  "deploy:read",
  "deploy:create",
  "envvar:manage",
  "domain:manage",
  "member:manage",
  "team:delete",
];

const ROLE_PERMISSIONS: Record<string, Set<Permission>> = {
  owner: new Set(ALL_PERMISSIONS),
  admin: new Set([
    "project:read",
    "project:create",
    "deploy:read",
    "deploy:create",
    "envvar:manage",
    "domain:manage",
  ]),
  member: new Set(["project:read", "deploy:read", "deploy:create"]),
};

type RbacEnv = {
  Bindings: Env;
  Variables: { user: AuthUser; teamId: string; teamSlug: string; memberRole?: string };
};

/**
 * Middleware factory that checks if the current user has the required permissions
 * for the active team. Reads the member role from context — resolved once by
 * tenantMiddleware (which already JOINs the member table to verify membership).
 */
export function requirePermission(...perms: Permission[]) {
  return async (c: Context<RbacEnv>, next: Next) => {
    const role = c.get("memberRole");

    if (!role) {
      return c.json({ error: "forbidden", message: "Not a member of this team" }, 403);
    }

    const allowed = ROLE_PERMISSIONS[role];
    if (!allowed || !perms.every((p) => allowed.has(p))) {
      return c.json(
        { error: "forbidden", message: `Insufficient permissions. Required: ${perms.join(", ")}` },
        403,
      );
    }

    return next();
  };
}
