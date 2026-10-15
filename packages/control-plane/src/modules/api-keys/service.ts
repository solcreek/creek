import type { D1Database } from "@cloudflare/workers-types";
import { parseGrant, scopedKeyPermissions, type ApiKeyGrant } from "../tenant/api-key-grant.js";
import { roleGrants } from "../tenant/permissions.js";
import {
  ALL_SCOPES,
  SCOPES,
  SCOPE_PRESETS,
  isScope,
  type Scope,
  type ScopePreset,
} from "../tenant/scopes.js";

/**
 * API key management: mint scoped keys, describe and list them, revoke them.
 *
 * Keys are Better Auth api-key rows (`apikey`). A key's grant lives in
 * `apikey.permissions` (see tenant/api-key-grant.ts); a row whose
 * `permissions` is NULL is a legacy key with its owner's full access. So the
 * one thing this module must never do is leave a new row without them.
 */

const DAY = 24 * 60 * 60;

/** Expiry of a new key when the request names none. */
export const DEFAULT_EXPIRES_IN = 90 * DAY;
/** Longest expiry a new key may have. */
export const MAX_EXPIRES_IN = 365 * DAY;
/** Shortest expiry: Better Auth's api-key plugin refuses anything under a day. */
export const MIN_EXPIRES_IN = DAY;
/** Better Auth's api-key plugin limit on key names. */
export const MAX_NAME_LENGTH = 32;

export const LEGACY_KEY_WARNING =
  "This is a legacy API key: it has no scopes and carries its owner's full access in every team they belong to. Legacy keys will be retired; replace it with a scoped key (POST /api-keys from a signed-in session).";

export interface CreateKeyRequest {
  name: string;
  /** Team id or slug, as sent. */
  team: string;
  scopes: Scope[];
  /** The preset the scopes came from, if any (only reported, never stored). */
  preset: ScopePreset | null;
  /** Seconds. */
  expiresIn: number;
}

export type Invalid = {
  ok: false;
  status: 400;
  error: string;
  message: string;
  extra?: Record<string, unknown>;
};

const CREATE_FIELDS = new Set(["name", "team", "scopes", "expiresIn"]);

function invalid(error: string, message: string, extra?: Record<string, unknown>): Invalid {
  return { ok: false, status: 400, error, message, extra };
}

function isPreset(value: string): value is ScopePreset {
  return Object.prototype.hasOwnProperty.call(SCOPE_PRESETS, value);
}

/**
 * Validate a POST /api-keys body. Unknown fields are refused so that nobody
 * expects `permissions`, `userId` or the like to pass through to Better Auth.
 */
export function parseCreateKeyBody(body: unknown): { ok: true; value: CreateKeyRequest } | Invalid {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return invalid("validation", "The body must be a JSON object");
  }
  const fields = body as Record<string, unknown>;
  const unknown = Object.keys(fields).filter((k) => !CREATE_FIELDS.has(k));
  if (unknown.length > 0) {
    return invalid("unknown_field", `Unknown field: ${unknown.join(", ")}`, {
      fields: unknown,
      allowed: [...CREATE_FIELDS],
    });
  }

  const name = typeof fields.name === "string" ? fields.name.trim() : "";
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
    return invalid("validation", `name is required, 1 to ${MAX_NAME_LENGTH} characters`);
  }

  if (typeof fields.team !== "string" || fields.team.length === 0) {
    return invalid("validation", "team is required: the id or slug of a team you belong to");
  }

  // scopes: a preset name, or a list of scope names.
  let scopes: Scope[];
  let preset: ScopePreset | null = null;
  if (typeof fields.scopes === "string") {
    if (!isPreset(fields.scopes)) {
      return invalid("unknown_preset", `Unknown scope preset: ${fields.scopes}`, {
        presets: Object.keys(SCOPE_PRESETS),
      });
    }
    preset = fields.scopes;
    scopes = [...SCOPE_PRESETS[preset]];
  } else if (Array.isArray(fields.scopes)) {
    const unknownScopes = fields.scopes.filter((s) => !isScope(s));
    if (unknownScopes.length > 0) {
      return invalid("unknown_scope", `Unknown scope: ${unknownScopes.map(String).join(", ")}`, {
        scopes: unknownScopes,
        known: ALL_SCOPES,
      });
    }
    scopes = [...new Set(fields.scopes as Scope[])];
  } else {
    return invalid("validation", "scopes is required: a list of scopes or a preset name", {
      presets: Object.keys(SCOPE_PRESETS),
      known: ALL_SCOPES,
    });
  }
  if (scopes.length === 0) {
    return invalid("validation", "scopes must name at least one scope");
  }

  // expiresIn: seconds. Omitted means the default; a key never lacks an expiry.
  let expiresIn = DEFAULT_EXPIRES_IN;
  if (fields.expiresIn !== undefined) {
    const e = fields.expiresIn;
    if (typeof e !== "number" || !Number.isInteger(e)) {
      return invalid(
        "invalid_expiry",
        "expiresIn must be a whole number of seconds; keys always expire (omit it for 90 days)",
      );
    }
    if (e < MIN_EXPIRES_IN || e > MAX_EXPIRES_IN) {
      return invalid(
        "invalid_expiry",
        `expiresIn must be between ${MIN_EXPIRES_IN} (1 day) and ${MAX_EXPIRES_IN} (365 days) seconds`,
        { min: MIN_EXPIRES_IN, max: MAX_EXPIRES_IN },
      );
    }
    expiresIn = e;
  }

  return { ok: true, value: { name, team: fields.team, scopes, preset, expiresIn } };
}

/** Scopes, in registry order, that a team role does not grant. */
export function scopesBeyondRole(role: string, scopes: readonly Scope[]): Scope[] {
  return ALL_SCOPES.filter(
    (s) => scopes.includes(s) && !roleGrants(role, SCOPES[s].rolePermission),
  );
}

/** Scopes, in registry order, that a team role grants. */
export function scopesForRole(role: string | null | undefined): Scope[] {
  return ALL_SCOPES.filter((s) => roleGrants(role, SCOPES[s].rolePermission));
}

export interface MemberTeam {
  id: string;
  slug: string;
  role: string;
}

/** A team the user belongs to, by id or slug (id wins if both match). */
export async function findMemberTeam(
  db: D1Database,
  userId: string,
  idOrSlug: string,
): Promise<MemberTeam | null> {
  return db
    .prepare(
      `SELECT o.id, o.slug, m.role FROM organization o
       JOIN member m ON m.organizationId = o.id
       WHERE (o.id = ? OR o.slug = ?) AND m.userId = ?
       ORDER BY (o.id = ?) DESC
       LIMIT 1`,
    )
    .bind(idOrSlug, idOrSlug, userId, idOrSlug)
    .first<MemberTeam>();
}

/** Thrown when a key could not be created with exactly its grant. */
export class KeyMintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyMintError";
  }
}

/** The slice of Better Auth's server API this module uses. */
export interface KeyAuthApi {
  api: {
    createApiKey(args: {
      body: {
        userId: string;
        name: string;
        expiresIn: number;
        permissions: Record<string, string[]>;
      };
    }): Promise<{ id: string; key: string }>;
  };
}

export interface ApiKeyRow {
  id: string;
  name: string | null;
  start: string | null;
  prefix: string | null;
  referenceId: string;
  permissions: string | null;
  enabled: number | null;
  /** Epoch seconds (Better Auth's drizzle timestamp mode). */
  expiresAt: number | null;
  createdAt: number;
  lastRequest: number | null;
}

// Never select `key` (the hash): nothing here needs it.
const ROW_COLUMNS =
  "id, name, start, prefix, referenceId, permissions, enabled, expiresAt, createdAt, lastRequest";

async function readKeyRow(db: D1Database, id: string): Promise<ApiKeyRow | null> {
  return db.prepare(`SELECT ${ROW_COLUMNS} FROM apikey WHERE id = ?`).bind(id).first<ApiKeyRow>();
}

function sameScopes(a: ReadonlySet<Scope>, b: readonly Scope[]): boolean {
  const wanted = new Set(b);
  return a.size === wanted.size && [...wanted].every((s) => a.has(s));
}

/**
 * Create a scoped key and return its secret.
 *
 * Better Auth's server-side createApiKey (no request, no headers) accepts
 * `permissions` and writes them in the same INSERT as the key, so the row is
 * never visible without them. This does not rely on that alone: a row
 * without exactly this grant would be a legacy key with full access, so the
 * row is read back and, unless it holds exactly the requested scopes, team,
 * owner and an expiry, deleted before anything is returned. If the check
 * itself fails, the key is deleted too.
 */
export async function mintScopedKey(
  auth: KeyAuthApi,
  db: D1Database,
  input: { userId: string; teamId: string; name: string; scopes: Scope[]; expiresIn: number },
): Promise<{ id: string; key: string; row: ApiKeyRow }> {
  const permissions = scopedKeyPermissions(input.scopes, input.teamId);
  const before = await keyIds(db, input.userId);
  let created: { id: string; key: string } | undefined;
  try {
    created = await auth.api.createApiKey({
      body: {
        userId: input.userId,
        name: input.name,
        expiresIn: input.expiresIn,
        permissions,
      },
    });
    if (!created?.id || !created.key) throw new KeyMintError("Better Auth returned no key");
  } catch (err) {
    // A failure after the row was written leaves a key nobody received, and
    // if its scopes did not land, a full-access one. The id is unknown here,
    // so remove this user's new rows that are unscoped or carry this grant.
    // (A key the same user mints concurrently in another request could be
    // caught too; deleting is the safe direction.)
    await deleteOrphans(db, input.userId, before, JSON.stringify(permissions));
    throw err;
  }

  let row: ApiKeyRow | null = null;
  let problem: string | null = null;
  try {
    row = await readKeyRow(db, created.id);
    if (!row) problem = "the key row is missing";
    else if (row.referenceId !== input.userId) problem = "the key belongs to another user";
    else if (row.permissions === null) problem = "the key was stored without its scopes";
    else {
      const grant = parseGrant(row.id, row.permissions);
      if (grant.kind !== "scoped") problem = "the key's stored scopes are unreadable";
      else if (grant.teamId !== input.teamId) problem = "the key is pinned to another team";
      else if (!sameScopes(grant.scopes, input.scopes)) problem = "the key's stored scopes differ";
      else if (!row.expiresAt || row.expiresAt * 1000 <= Date.now())
        problem = "the key was stored without a future expiry";
    }
  } catch (err) {
    problem = `the key could not be verified: ${err instanceof Error ? err.message : String(err)}`;
  }

  if (problem !== null || row === null) {
    await deleteUnverifiedKey(db, created.id, problem ?? "unknown");
    throw new KeyMintError(`API key creation failed: ${problem}`);
  }
  return { id: created.id, key: created.key, row };
}

async function keyIds(db: D1Database, userId: string): Promise<Set<string>> {
  const rows = await db
    .prepare("SELECT id FROM apikey WHERE referenceId = ?")
    .bind(userId)
    .all<{ id: string }>();
  return new Set(rows.results.map((r) => r.id));
}

async function deleteOrphans(
  db: D1Database,
  userId: string,
  before: Set<string>,
  permissions: string,
): Promise<void> {
  let rows: { id: string; permissions: string | null }[];
  try {
    rows = (
      await db
        .prepare("SELECT id, permissions FROM apikey WHERE referenceId = ?")
        .bind(userId)
        .all<{ id: string; permissions: string | null }>()
    ).results;
  } catch (err) {
    console.error(`[api-keys] CRITICAL: could not look for orphaned keys of ${userId}:`, err);
    return;
  }
  for (const row of rows) {
    if (before.has(row.id)) continue;
    if (row.permissions !== null && row.permissions !== permissions) continue;
    await deleteUnverifiedKey(db, row.id, "key creation threw after writing the row");
  }
}

async function deleteUnverifiedKey(db: D1Database, id: string, why: string): Promise<void> {
  console.error(`[api-keys] deleting key ${id} after a failed creation: ${why}`);
  // Two attempts: a key left behind here may be a full-access legacy key.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await db.prepare("DELETE FROM apikey WHERE id = ?").bind(id).run();
      return;
    } catch (err) {
      console.error(`[api-keys] CRITICAL: delete of unverified key ${id} failed:`, err);
    }
  }
}

function iso(seconds: number | null | undefined): string | null {
  return typeof seconds === "number" ? new Date(seconds * 1000).toISOString() : null;
}

export interface KeyTeam {
  id: string;
  slug: string | null;
}

/** A key as the API shows it. Never carries secret material. */
export interface KeyView {
  id: string;
  name: string | null;
  /** The first characters of the key, as stored at creation. */
  start: string | null;
  prefix: string | null;
  legacy: boolean;
  /** The pinned team; null for a legacy key (it follows the request's team). */
  team: KeyTeam | null;
  /** Stored scopes, sorted; null for a legacy key. */
  scopes: Scope[] | null;
  enabled: boolean;
  expiresAt: string | null;
  expired: boolean;
  createdAt: string | null;
  lastUsedAt: string | null;
  warning?: string;
}

function viewOf(row: ApiKeyRow, grant: ApiKeyGrant, slugs: Map<string, string>): KeyView {
  const expired = row.expiresAt !== null && row.expiresAt * 1000 <= Date.now();
  const view: KeyView = {
    id: row.id,
    name: row.name,
    start: row.start,
    prefix: row.prefix,
    legacy: grant.kind === "legacy",
    team:
      grant.kind === "scoped" ? { id: grant.teamId, slug: slugs.get(grant.teamId) ?? null } : null,
    scopes: grant.kind === "scoped" ? ALL_SCOPES.filter((s) => grant.scopes.has(s)) : null,
    enabled: row.enabled !== 0,
    expiresAt: iso(row.expiresAt),
    expired,
    createdAt: iso(row.createdAt),
    lastUsedAt: iso(row.lastRequest),
  };
  if (grant.kind === "legacy") view.warning = LEGACY_KEY_WARNING;
  if (grant.kind === "invalid") {
    view.scopes = [];
    view.warning = "This key's stored scopes are unreadable; it is refused everywhere. Revoke it.";
  }
  return view;
}

async function teamSlugs(db: D1Database, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .prepare(`SELECT id, slug FROM organization WHERE id IN (${unique.map(() => "?").join(", ")})`)
    .bind(...unique)
    .all<{ id: string; slug: string }>();
  return new Map(rows.results.map((r) => [r.id, r.slug]));
}

/** What GET /api-keys/self reports for the key making the request. */
export interface SelfView extends KeyView {
  /** The owner's current role in the pinned team (null: not a member any more, or legacy). */
  role: string | null;
  /**
   * Scopes the key can use now: its scopes ∩ the owner's current role in the
   * pinned team. Null for a legacy key, whose access is its owner's role in
   * whichever team a request names.
   */
  effectiveScopes: Scope[] | null;
  access: "scoped" | "full" | "none";
}

/**
 * The view of a key mintScopedKey just created and verified, from its
 * verified row and the team (with the creator's role) already resolved for
 * the request. Pure: no database read stands between a live key and the
 * response that carries its secret.
 */
export function mintedKeyView(row: ApiKeyRow, team: MemberTeam): SelfView {
  const grant = parseGrant(row.id, row.permissions);
  const view = viewOf(row, grant, new Map([[team.id, team.slug]]));
  const effectiveScopes =
    grant.kind === "scoped"
      ? ALL_SCOPES.filter(
          (s) => grant.scopes.has(s) && roleGrants(team.role, SCOPES[s].rolePermission),
        )
      : [];
  return {
    ...view,
    role: team.role,
    effectiveScopes,
    access: effectiveScopes.length > 0 ? "scoped" : "none",
  };
}

/** Delete a key that was created but could not be handed over. */
export async function discardKey(db: D1Database, id: string, why: string): Promise<void> {
  await deleteUnverifiedKey(db, id, why);
}

export async function describeKey(
  db: D1Database,
  keyId: string,
  userId: string,
): Promise<SelfView | null> {
  const row = await readKeyRow(db, keyId);
  if (!row || row.referenceId !== userId) return null;
  const grant = parseGrant(row.id, row.permissions);
  const slugs = await teamSlugs(db, grant.kind === "scoped" ? [grant.teamId] : []);
  const view = viewOf(row, grant, slugs);

  if (grant.kind === "legacy") {
    return { ...view, role: null, effectiveScopes: null, access: "full" };
  }
  if (grant.kind === "invalid") {
    return { ...view, role: null, effectiveScopes: [], access: "none" };
  }
  const member = await db
    .prepare("SELECT role FROM member WHERE userId = ? AND organizationId = ?")
    .bind(userId, grant.teamId)
    .first<{ role: string }>();
  const role = member?.role ?? null;
  const effectiveScopes = ALL_SCOPES.filter(
    (s) => grant.scopes.has(s) && roleGrants(role, SCOPES[s].rolePermission),
  );
  const self: SelfView = {
    ...view,
    role,
    effectiveScopes,
    access: effectiveScopes.length > 0 ? "scoped" : "none",
  };
  if (!member) {
    self.warning =
      "The key's owner is no longer a member of the team the key is pinned to; it is refused everywhere.";
  }
  return self;
}

/**
 * A user's keys, newest first. With `teamId`, only the keys that can act on
 * that team: keys pinned to it, and legacy keys (which can act on any team).
 */
export async function listKeys(
  db: D1Database,
  userId: string,
  teamId: string | null,
): Promise<KeyView[]> {
  const rows = await db
    .prepare(`SELECT ${ROW_COLUMNS} FROM apikey WHERE referenceId = ? ORDER BY createdAt DESC`)
    .bind(userId)
    .all<ApiKeyRow>();
  const keys = rows.results.map((row) => ({ row, grant: parseGrant(row.id, row.permissions) }));
  const visible = teamId
    ? keys.filter(({ grant }) => grant.kind !== "scoped" || grant.teamId === teamId)
    : keys;
  const slugs = await teamSlugs(
    db,
    visible.flatMap(({ grant }) => (grant.kind === "scoped" ? [grant.teamId] : [])),
  );
  return visible.map(({ row, grant }) => viewOf(row, grant, slugs));
}

/**
 * Delete one of the user's keys. Returns the key as it was, or null when the
 * user has no key with that id (someone else's key is "not found" too).
 *
 * The api-key plugin is configured with database storage only, so deleting
 * the row is the whole revocation: the next request with the key finds
 * nothing.
 */
export async function revokeKey(
  db: D1Database,
  keyId: string,
  userId: string,
): Promise<KeyView | null> {
  const row = await readKeyRow(db, keyId);
  if (!row || row.referenceId !== userId) return null;
  const result = await db
    .prepare("DELETE FROM apikey WHERE id = ? AND referenceId = ?")
    .bind(keyId, userId)
    .run();
  if (!result.meta.changes) return null;
  const grant = parseGrant(row.id, row.permissions);
  const slugs = await teamSlugs(db, grant.kind === "scoped" ? [grant.teamId] : []);
  return viewOf(row, grant, slugs);
}
