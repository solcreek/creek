import type { Permission } from "./permissions.js";

/**
 * API key scopes — what a scoped API key may do.
 *
 * A request made with a scoped key is allowed only when the key holds the
 * route's scope AND the key owner's current team role grants the scope's
 * `rolePermission` (re-read on every request, so demoting the owner shrinks
 * the key). Session (dashboard) requests and legacy keys (no scopes stored)
 * are not affected by scopes.
 *
 * Adding a scope: add it here with a description, risk and impact, then use
 * it on a route. A new scope is never granted to an existing key — presets
 * are stored on the key as concrete lists, not as names.
 *
 * Each scope carries two ratings, both shown by GET /api-keys/scopes:
 * - `risk`, what kind of power it is (SCOPE_RISKS):
 *     read         reads only
 *     write        creates or changes things; nothing it does loses data
 *     destructive  can delete things or their data for good
 *     admin        changes what production serves or how: production
 *                  deploys, secrets, domains
 * - `impact`, how much harm a leaked key holding it can do (low, moderate,
 *   high). The two differ on purpose: deploy:preview is a write, but its
 *   code runs with production data, so its impact is high.
 */
export const SCOPE_RISKS = ["read", "write", "destructive", "admin"] as const;
export type ScopeRisk = (typeof SCOPE_RISKS)[number];

export const SCOPE_IMPACTS = ["low", "moderate", "high"] as const;
export type ScopeImpact = (typeof SCOPE_IMPACTS)[number];

export const SCOPES = {
  "project:read": {
    description: "List projects; read project, deployment and rollback details",
    risk: "read",
    impact: "low",
    rolePermission: "project:read",
  },
  "project:write": {
    description: "Create projects",
    risk: "write",
    impact: "moderate",
    rolePermission: "project:create",
  },
  "project:delete": {
    description: "Delete projects",
    risk: "destructive",
    impact: "high",
    rolePermission: "project:delete",
  },
  "deploy:preview": {
    // High, not moderate: a branch deploy runs with the project's environment
    // variables and resource bindings (deploy-job.ts binds the same D1/R2/KV
    // as production), so code deployed with this scope can read secrets and
    // read or write production data. It cannot replace the production
    // script, and it cannot add bindings to the project: a preview bundle
    // that declares a resource the project lacks is refused unless the key
    // also holds resource:write (PUT .../bundle).
    description:
      "Deploy to a non-production branch, using the resources the project already has. The deploy runs with the project's environment variables and resources, including production data",
    risk: "write",
    impact: "high",
    rolePermission: "deploy:create",
  },
  "deploy:production": {
    // Deploys provision the resources and bindings the bundle declares
    // (ensureProjectBindings) without resource:write.
    description:
      "Deploy, promote or roll back production; change production triggers; connect a repo. A deploy creates and binds the resources its bundle declares",
    risk: "admin",
    impact: "high",
    rolePermission: "deploy:create",
  },
  "env:read": {
    description: "List environment variable keys (values are never returned)",
    risk: "read",
    impact: "low",
    rolePermission: "project:read",
  },
  "env:write": {
    description: "Set and remove environment variables",
    risk: "admin",
    impact: "high",
    rolePermission: "envvar:manage",
  },
  "domain:read": {
    description: "Read custom domains",
    risk: "read",
    impact: "low",
    rolePermission: "project:read",
  },
  "domain:write": {
    description: "Add, activate and remove custom domains",
    risk: "admin",
    impact: "high",
    rolePermission: "domain:manage",
  },
  "resource:read": {
    description: "Read databases, storage and caches, their bindings and metrics",
    risk: "read",
    impact: "low",
    rolePermission: "project:read",
  },
  "resource:write": {
    description: "Create, rename, attach and detach databases, storage and caches",
    risk: "write",
    impact: "moderate",
    rolePermission: "project:create",
  },
  "resource:delete": {
    description: "Delete databases, storage and caches with their data",
    risk: "destructive",
    impact: "high",
    rolePermission: "project:create",
  },
  "db:query": {
    description: "Run any SQL, including writes, against a database",
    risk: "destructive",
    impact: "high",
    rolePermission: "project:create",
  },
  "logs:read": {
    description: "Read runtime logs, build logs, metrics, analytics and cron logs",
    risk: "read",
    impact: "low",
    rolePermission: "project:read",
  },
  "github:read": {
    description: "Read GitHub installations, repositories and connections",
    risk: "read",
    impact: "low",
    rolePermission: "project:read",
  },
  "github:write": {
    description: "Claim installations, scan repositories, connect and disconnect repos",
    risk: "write",
    impact: "moderate",
    rolePermission: "project:create",
  },
  "queue:send": {
    description: "Send messages to a project's queue",
    risk: "write",
    impact: "moderate",
    rolePermission: "deploy:create",
  },
} as const satisfies Record<
  string,
  { description: string; risk: ScopeRisk; impact: ScopeImpact; rolePermission: Permission }
>;

export type Scope = keyof typeof SCOPES;

export const ALL_SCOPES = Object.keys(SCOPES) as Scope[];

export function isScope(value: unknown): value is Scope {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(SCOPES, value);
}

/**
 * Named starting points for a key's scopes. A preset is expanded into its
 * concrete list when a key is created; keys never store a preset name, so
 * changing a preset (or adding a scope) changes no existing key.
 */
export const SCOPE_PRESETS = {
  "read-only": [
    "project:read",
    "env:read",
    "domain:read",
    "resource:read",
    "logs:read",
    "github:read",
  ],
  "agent-preview": ["project:read", "deploy:preview", "logs:read"],
  "ci-deploy": ["project:read", "deploy:preview", "deploy:production", "logs:read"],
  full: ALL_SCOPES,
} as const satisfies Record<string, readonly Scope[]>;

export type ScopePreset = keyof typeof SCOPE_PRESETS;

/** What each preset is for, shown by GET /api-keys/scopes. */
export const SCOPE_PRESET_DESCRIPTIONS: Record<ScopePreset, string> = {
  "read-only": "Read projects, environment variable names, domains, resources, logs and GitHub",
  "agent-preview":
    "An agent that deploys preview branches and reads logs. It cannot deploy production, but preview code runs with the project's environment variables and production data",
  "ci-deploy": "CI that deploys preview branches and production",
  full: "Every scope, including deletes and SQL; use sparingly",
};
