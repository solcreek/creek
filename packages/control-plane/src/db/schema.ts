import { sqliteTable, text, integer, primaryKey, index, uniqueIndex } from "drizzle-orm/sqlite-core";

// ============================================================================
// Better Auth Core Tables (camelCase columns to match Better Auth defaults)
// ============================================================================

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("emailVerified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  role: text("role").default("user"),
  banned: integer("banned", { mode: "boolean" }),
  banReason: text("banReason"),
  banExpires: integer("banExpires", { mode: "timestamp" }),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
});

export const session = sqliteTable("session", {
  id: text("id").primaryKey(),
  userId: text("userId").notNull().references(() => user.id),
  token: text("token").notNull().unique(),
  expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
  ipAddress: text("ipAddress"),
  userAgent: text("userAgent"),
  impersonatedBy: text("impersonatedBy"),
  activeOrganizationId: text("activeOrganizationId"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
});

export const account = sqliteTable("account", {
  id: text("id").primaryKey(),
  userId: text("userId").notNull().references(() => user.id),
  accountId: text("accountId").notNull(),
  providerId: text("providerId").notNull(),
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  accessTokenExpiresAt: integer("accessTokenExpiresAt", { mode: "timestamp" }),
  refreshTokenExpiresAt: integer("refreshTokenExpiresAt", { mode: "timestamp" }),
  scope: text("scope"),
  idToken: text("idToken"),
  password: text("password"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
});

export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }),
  updatedAt: integer("updatedAt", { mode: "timestamp" }),
});

// ============================================================================
// API Key Plugin
// ============================================================================

export const apikey = sqliteTable("apikey", {
  id: text("id").primaryKey(),
  configId: text("configId").notNull().default("default"),
  name: text("name"),
  start: text("start"),
  prefix: text("prefix"),
  key: text("key").notNull(),
  referenceId: text("referenceId").notNull(),
  refillInterval: integer("refillInterval"),
  refillAmount: integer("refillAmount"),
  lastRefillAt: integer("lastRefillAt", { mode: "timestamp" }),
  enabled: integer("enabled", { mode: "boolean" }).default(true),
  rateLimitEnabled: integer("rateLimitEnabled", { mode: "boolean" }),
  rateLimitTimeWindow: integer("rateLimitTimeWindow"),
  rateLimitMax: integer("rateLimitMax"),
  requestCount: integer("requestCount"),
  remaining: integer("remaining"),
  lastRequest: integer("lastRequest", { mode: "timestamp" }),
  expiresAt: integer("expiresAt", { mode: "timestamp" }),
  permissions: text("permissions"),
  metadata: text("metadata"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
});

// ============================================================================
// Organization Plugin
// ============================================================================

export const organization = sqliteTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  metadata: text("metadata"),
  plan: text("plan").notNull().default("free"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
});

export const member = sqliteTable("member", {
  id: text("id").primaryKey(),
  userId: text("userId").notNull().references(() => user.id),
  organizationId: text("organizationId").notNull().references(() => organization.id),
  role: text("role").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
});

export const invitation = sqliteTable("invitation", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  inviterId: text("inviterId").notNull().references(() => user.id),
  organizationId: text("organizationId").notNull().references(() => organization.id),
  role: text("role"),
  status: text("status").notNull(),
  expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }),
});

// ============================================================================
// Creek App Tables (also camelCase for consistency)
// ============================================================================

export const project = sqliteTable("project", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull(),
  organizationId: text("organizationId").notNull().references(() => organization.id),
  productionDeploymentId: text("productionDeploymentId"),
  productionBranch: text("productionBranch").notNull().default("main"),
  framework: text("framework"),
  githubRepo: text("githubRepo"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
}, (table) => [
  uniqueIndex("idx_project_org_slug").on(table.organizationId, table.slug),
]);

export const deployment = sqliteTable("deployment", {
  id: text("id").primaryKey(),
  projectId: text("projectId").notNull().references(() => project.id),
  version: integer("version").notNull(),
  status: text("status").notNull().default("queued"),
  branch: text("branch"),
  commitSha: text("commitSha"),
  commitMessage: text("commitMessage"),
  triggerType: text("triggerType").notNull().default("cli"),
  environment: text("environment").notNull().default("production"),
  failedStep: text("failedStep"),
  errorMessage: text("errorMessage"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
}, (table) => [
  index("idx_deployment_project").on(table.projectId),
  index("idx_deployment_branch").on(table.projectId, table.branch),
]);

export const environmentVariable = sqliteTable("environment_variable", {
  projectId: text("projectId").notNull().references(() => project.id),
  key: text("key").notNull(),
  encryptedValue: text("encryptedValue").notNull(),
}, (table) => [
  primaryKey({ columns: [table.projectId, table.key] }),
]);

export const customDomain = sqliteTable("custom_domain", {
  id: text("id").primaryKey(),
  projectId: text("projectId").notNull().references(() => project.id),
  hostname: text("hostname").notNull().unique(),
  status: text("status").notNull().default("pending"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
}, (table) => [
  index("idx_custom_domain_project").on(table.projectId),
]);

// ============================================================================
// GitHub App Integration
// ============================================================================

export const githubInstallation = sqliteTable("github_installation", {
  id: integer("id").primaryKey(),  // GitHub's installation ID (not UUID)
  accountLogin: text("accountLogin").notNull(),
  accountType: text("accountType").notNull(),  // "User" | "Organization"
  organizationId: text("organizationId").references(() => organization.id),  // Creek team association
  appId: integer("appId").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
});

export const githubConnection = sqliteTable("github_connection", {
  id: text("id").primaryKey(),
  projectId: text("projectId").notNull().references(() => project.id),
  installationId: integer("installationId").notNull(),
  // GitHub's internal repository ID — stable across renames and ownership
  // transfers. Populated at connect time from the installation repos API.
  // Nullable because rows created before this column existed won't have it
  // backfilled yet.
  repoId: integer("repoId"),
  repoOwner: text("repoOwner").notNull(),
  repoName: text("repoName").notNull(),
  productionBranch: text("productionBranch").notNull().default("main"),
  autoDeployEnabled: integer("autoDeployEnabled", { mode: "boolean" }).notNull().default(true),
  previewEnabled: integer("previewEnabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
}, (table) => [
  uniqueIndex("idx_github_connection_project").on(table.projectId),
  index("idx_github_connection_repo").on(table.repoOwner, table.repoName),
  // Lookup by repo ID for the repository.renamed webhook — the new name
  // won't match, but the ID does.
  index("idx_github_connection_repo_id").on(table.repoId),
]);

export const repoScan = sqliteTable("repo_scan", {
  repoOwner: text("repoOwner").notNull(),
  repoName: text("repoName").notNull(),
  installationId: integer("installationId").notNull(),
  framework: text("framework"),
  configType: text("configType"),
  bindings: text("bindings"),    // JSON: [{ type, name }]
  envHints: text("envHints"),    // JSON: ["KEY1", "KEY2"]
  deployable: integer("deployable", { mode: "boolean" }).notNull().default(false),
  scannedAt: integer("scannedAt", { mode: "timestamp" }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.repoOwner, table.repoName] }),
]);

// ============================================================================
// Audit Log
// ============================================================================

export const auditLog = sqliteTable("audit_log", {
  id: text("id").primaryKey(),
  teamId: text("teamId").notNull(),
  userId: text("userId").notNull(),
  userEmail: text("userEmail").notNull(),
  action: text("action").notNull(),
  resourceType: text("resourceType").notNull(),
  resourceId: text("resourceId"),
  metadata: text("metadata"),
  ipHash: text("ipHash"),
  country: text("country"),
  userAgent: text("userAgent"),
  cfRay: text("cfRay"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
}, (table) => [
  index("idx_audit_log_user_time").on(table.userId, table.createdAt),
  index("idx_audit_log_team_time").on(table.teamId, table.createdAt),
]);

export const auditIpLog = sqliteTable("audit_ip_log", {
  auditLogId: text("auditLogId").notNull(),
  rawIp: text("rawIp").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
}, (table) => [
  index("idx_audit_ip_log_created").on(table.createdAt),
]);

// ============================================================================
// Resources — team-owned resources + project-level bindings
// ============================================================================
//
// - `resource` is a team-scoped first-class entity (DB, storage bucket, ...)
//   with a stable UUID and a mutable semantic name.
// - `project_resource_binding` is the project-side alias: "in this project,
//   the env var DB points to resource X." One resource can be bound to
//   many projects under many names; renaming the resource never breaks
//   the binding.

export const resource = sqliteTable("resource", {
  id: text("id").primaryKey(),
  teamId: text("teamId").notNull(),
  kind: text("kind").notNull(), // database | storage | cache | ai
  name: text("name").notNull(), // semantic label — mutable
  cfResourceId: text("cfResourceId"),
  cfResourceType: text("cfResourceType"), // d1 | r2 | kv
  status: text("status").notNull().default("active"), // active | provisioning | failed | deleted
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
}, (table) => [
  uniqueIndex("idx_resource_team_name").on(table.teamId, table.name),
  index("idx_resource_team_kind").on(table.teamId, table.kind),
]);

export const projectResourceBinding = sqliteTable("project_resource_binding", {
  projectId: text("projectId").notNull().references(() => project.id),
  bindingName: text("bindingName").notNull(),
  resourceId: text("resourceId").notNull().references(() => resource.id),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.projectId, table.bindingName] }),
  index("idx_prb_resource").on(table.resourceId),
]);

// ============================================================================
// Build Logs
// ============================================================================
//
// Build log pipeline (see product-planning/creek-build-logs.md):
//   - build-container / remote-builder / CLI → POST /builds/:id/logs
//   - Body: ndjson lines {ts, step, stream, level, msg, code?}
//   - control-plane gzips, scrubs secrets, writes R2: builds/{team}/{project}/{deployId}.ndjson.gz
//   - This table is metadata only — no log bodies live here
//   - Retention: 30d for success, 90d for failed; cron purges both

export const buildLog = sqliteTable("build_log", {
  deploymentId: text("deploymentId").primaryKey().references(() => deployment.id),
  status: text("status").notNull(), // running | success | failed
  startedAt: integer("startedAt", { mode: "timestamp" }).notNull(),
  endedAt: integer("endedAt", { mode: "timestamp" }),
  bytes: integer("bytes").notNull().default(0), // compressed size
  lines: integer("lines").notNull().default(0),
  truncated: integer("truncated", { mode: "boolean" }).notNull().default(false),
  errorCode: text("errorCode"), // CK-* if failed
  errorStep: text("errorStep"), // which step died
  r2Key: text("r2Key").notNull(),
}, (table) => [
  index("idx_build_log_status").on(table.status, table.startedAt),
]);

// ============================================================================
// Resource Cleanup
// ============================================================================

export const resourceCleanupQueue = sqliteTable("resource_cleanup_queue", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  resourceType: text("resourceType").notNull(),
  cfResourceId: text("cfResourceId").notNull(),
  cfResourceName: text("cfResourceName").notNull(),
  status: text("status").notNull().default("pending"),
  reason: text("reason"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
}, (table) => [
  index("idx_cleanup_status").on(table.status),
]);
