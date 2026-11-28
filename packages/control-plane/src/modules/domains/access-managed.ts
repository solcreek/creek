/**
 * Creek-managed Access: Creek creates and keeps the Access applications for a
 * project in the team's own Cloudflare account, through the team's "Connect
 * Cloudflare" grant. The customer only says who may get in.
 *
 * Per project, at most two applications, each owning its one inline policy:
 *   - the main one on every custom domain of the project, allowing the listed
 *     emails, email domains and (optionally) the Creek team's members;
 *   - with bypass paths, one on each host/path pair, letting everyone through.
 *
 * Their ids live in project.accessManaged (migration 0017); the team domain
 * and AUD go to the same columns a customer-made application uses (0016), so
 * the dispatch worker enforces both the same way.
 */

import type { Env } from "../../types.js";
import {
  CloudflareNotConnectedError,
  CloudflareReauthRequiredError,
} from "../cloudflare-connection/store.js";
import { getCloudflareAccessToken, grantClient } from "../cloudflare-connection/grant-object.js";
import {
  CloudflareApiError,
  countIdentityProviders,
  createApp,
  createOneTimePin,
  createOrganization,
  deleteApp,
  getTeamDomain,
  updateApp,
  type AccessRule,
  type AppSpec,
} from "./access-cloudflare.js";

export interface ManagedAccess {
  accountId: string;
  appId: string;
  bypassAppId: string | null;
  emails: string[];
  emailDomains: string[];
  teamMembers: boolean;
  /**
   * What the applications were last synced with: the project's custom domains
   * and (with teamMembers) the team's member emails. Null on rows saved before
   * Creek recorded them.
   */
  appliedHostnames: string[] | null;
  appliedMemberEmails: string[] | null;
}

export const MAX_EMAILS = 100;
export const MAX_EMAIL_DOMAINS = 50;

const EMAIL = /^[^\s@]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,63}$/;
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const ACCOUNT_ID = /^[0-9a-f]{32}$/;

/** The scope that lets Creek set up Zero Trust and its login method. */
export const ORG_WRITE_SCOPE = "access-acct.write";

/**
 * How long a request may hold a project's Access lease. Longer than the worst
 * case of one change: a token refresh (20 s) plus a handful of Cloudflare
 * calls at 15 s each. If it ever runs out mid-change, the conditional save in
 * the routes still refuses to overwrite a row another request changed.
 */
export const ACCESS_LEASE_MS = 3 * 60 * 1000;

/** Take the project's Access lease; returns its expiry, or null when someone holds it. */
export async function acquireAccessLease(db: Env["DB"], projectId: string): Promise<number | null> {
  const now = Date.now();
  const until = now + ACCESS_LEASE_MS;
  const res = await db
    .prepare(
      `UPDATE project SET accessLockedUntil = ?
       WHERE id = ? AND (accessLockedUntil IS NULL OR accessLockedUntil < ?)`,
    )
    .bind(until, projectId, now)
    .run();
  return res.meta.changes ? until : null;
}

/** Give the lease back, unless it expired and someone else took it. */
export async function releaseAccessLease(db: Env["DB"], projectId: string, until: number) {
  await db
    .prepare("UPDATE project SET accessLockedUntil = NULL WHERE id = ? AND accessLockedUntil = ?")
    .bind(projectId, until)
    .run()
    .catch((err) => console.error(`[access] could not release the lease on ${projectId}:`, err));
}

/** project.accessManaged for a project, or null (also before migration 0017). */
export async function managedAccessOf(
  db: Env["DB"],
  projectId: string,
): Promise<ManagedAccess | null> {
  try {
    const row = await db
      .prepare("SELECT accessManaged FROM project WHERE id = ?")
      .bind(projectId)
      .first<{ accessManaged: string | null }>();
    return readManaged(row?.accessManaged);
  } catch (err) {
    if (/no such column/i.test(String(err))) return null;
    throw err;
  }
}

/** A refusal the route turns into a JSON error. */
export class ProvisionError extends Error {
  constructor(
    readonly status: 400 | 409 | 502 | 503,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ProvisionError";
  }
}

export type ManagedInput = {
  accountId: string | null;
  emails: string[];
  emailDomains: string[];
  teamMembers: boolean;
};

type ParsedInput = { ok: true; input: ManagedInput } | { ok: false; message: string };

function stringList(value: unknown, max: number, field: string): string[] | string {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max) {
    return `${field} must be a list of at most ${max} entries`;
  }
  if (value.some((v) => typeof v !== "string")) return `${field} must be a list of strings`;
  return [...new Set((value as string[]).map((v) => v.trim().toLowerCase()))];
}

/** Who may get in, and in which account. Bypass paths are parsed by the caller. */
export function parseManagedInput(body: Record<string, unknown>): ParsedInput {
  const emails = stringList(body.emails, MAX_EMAILS, "emails");
  if (typeof emails === "string") return { ok: false, message: emails };
  const bad = emails.find((e) => !EMAIL.test(e));
  if (bad !== undefined) return { ok: false, message: `Invalid email ${JSON.stringify(bad)}` };

  const rawDomains = stringList(body.emailDomains, MAX_EMAIL_DOMAINS, "emailDomains");
  if (typeof rawDomains === "string") return { ok: false, message: rawDomains };
  const emailDomains = [...new Set(rawDomains.map((d) => d.replace(/^@/, "")))];
  const badDomain = emailDomains.find((d) => !DOMAIN.test(d));
  if (badDomain !== undefined) {
    return {
      ok: false,
      message: `Invalid email domain ${JSON.stringify(badDomain)}`,
    };
  }

  if (body.teamMembers !== undefined && typeof body.teamMembers !== "boolean") {
    return { ok: false, message: "teamMembers must be true or false" };
  }
  const teamMembers = body.teamMembers === true;

  let accountId: string | null = null;
  if (body.accountId !== undefined && body.accountId !== null) {
    if (typeof body.accountId !== "string" || !ACCOUNT_ID.test(body.accountId)) {
      return {
        ok: false,
        message: "accountId must be a Cloudflare account id (32 hex)",
      };
    }
    accountId = body.accountId;
  }

  if (!emails.length && !emailDomains.length && !teamMembers) {
    return {
      ok: false,
      message: "Say who may get in: emails, emailDomains, or teamMembers: true",
    };
  }
  return { ok: true, input: { accountId, emails, emailDomains, teamMembers } };
}

/** project.accessManaged, or null when absent or unreadable. */
export function readManaged(value: string | null | undefined): ManagedAccess | null {
  if (!value) return null;
  try {
    const m = JSON.parse(value) as Partial<ManagedAccess>;
    if (typeof m?.accountId !== "string" || typeof m.appId !== "string") return null;
    return {
      accountId: m.accountId,
      appId: m.appId,
      bypassAppId: typeof m.bypassAppId === "string" ? m.bypassAppId : null,
      emails: Array.isArray(m.emails) ? m.emails : [],
      emailDomains: Array.isArray(m.emailDomains) ? m.emailDomains : [],
      teamMembers: m.teamMembers === true,
      appliedHostnames: stringsOrNull(m.appliedHostnames),
      appliedMemberEmails: stringsOrNull(m.appliedMemberEmails),
    };
  } catch {
    return null;
  }
}

function stringsOrNull(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((v) => typeof v === "string") ? value : null;
}

/** The team's Cloudflare token, with the grant's failures as refusals. */
export async function teamToken(env: Env, teamId: string): Promise<string> {
  if (!env.CLOUDFLARE_GRANTS) {
    throw new ProvisionError(
      503,
      "not_configured",
      "This Creek instance cannot connect Cloudflare",
    );
  }
  try {
    return await getCloudflareAccessToken(env, teamId);
  } catch (err) {
    if (err instanceof CloudflareNotConnectedError) {
      throw new ProvisionError(
        409,
        "cloudflare_not_connected",
        "Connect your Cloudflare account first (Settings → Cloudflare)",
      );
    }
    if (err instanceof CloudflareReauthRequiredError) {
      throw new ProvisionError(
        409,
        "cloudflare_reauth_required",
        "Your Cloudflare connection has expired: reconnect it under Settings → Cloudflare",
      );
    }
    throw new ProvisionError(502, "cloudflare_unavailable", String(err));
  }
}

/** A Cloudflare refusal as the route's answer, keeping Cloudflare's message. */
export function fromCloudflare(err: unknown): ProvisionError {
  if (err instanceof ProvisionError) return err;
  if (err instanceof CloudflareApiError) {
    if (err.status === 401 || err.status === 403) {
      return new ProvisionError(
        409,
        "cloudflare_forbidden",
        `${err.message}. The Cloudflare connection may lack a permission: reconnect it and approve every permission Creek asks for.`,
      );
    }
    if (err.status >= 400 && err.status < 500) {
      return new ProvisionError(400, "cloudflare_rejected", err.message);
    }
  }
  return new ProvisionError(502, "cloudflare_unavailable", String(err));
}

export interface ProvisionContext {
  teamId: string;
  teamSlug: string;
  project: { id: string; slug: string };
  previous: ManagedAccess | null;
  input: ManagedInput;
  bypassPaths: string[];
}

export interface Provisioned {
  teamDomain: string;
  aud: string;
  managed: ManagedAccess;
  hostnames: string[];
  /** Applications this call created: the caller deletes them if it cannot save. */
  created: string[];
  token: string;
}

async function chooseAccount(
  env: Env,
  teamId: string,
  input: ManagedInput,
  previous: ManagedAccess | null,
): Promise<{
  accountId: string;
  accountName: string | null;
  scopes: string[];
}> {
  const status = await grantClient(env, teamId).status();
  if (!status) {
    throw new ProvisionError(
      409,
      "cloudflare_not_connected",
      "Connect your Cloudflare account first (Settings → Cloudflare)",
    );
  }
  const accounts = status.accounts;
  const accountId =
    input.accountId ?? previous?.accountId ?? (accounts.length === 1 ? accounts[0]!.id : null);
  if (!accountId) {
    throw new ProvisionError(400, "account_required", "Choose the Cloudflare account to use", {
      accounts,
    });
  }
  if (previous && previous.accountId !== accountId) {
    throw new ProvisionError(
      409,
      "account_change",
      "This project's Access applications are in another Cloudflare account: remove protection first, then set it up in the new account",
    );
  }
  // An empty list means it could not be read at connect time; Cloudflare
  // still refuses an account the grant does not cover.
  if (accounts.length && !accounts.some((a) => a.id === accountId)) {
    throw new ProvisionError(
      400,
      "account_not_granted",
      "Creek has no access to that Cloudflare account",
      {
        accounts,
      },
    );
  }
  const accountName = accounts.find((a) => a.id === accountId)?.name ?? null;
  return { accountId, accountName, scopes: status.grantedScopes };
}

/** The Zero Trust team domain, setting Zero Trust up first when the grant allows it. */
async function ensureZeroTrust(
  token: string,
  accountId: string,
  orgName: string,
  scopes: string[],
): Promise<string> {
  const canWrite = scopes.includes(ORG_WRITE_SCOPE);
  const setupUrl = `https://dash.cloudflare.com/${accountId}/one/onboarding`;

  let teamDomain = await getTeamDomain(token, accountId);
  if (!teamDomain) {
    if (!canWrite) {
      throw new ProvisionError(
        409,
        "zero_trust_setup_required",
        "Zero Trust is not set up on this Cloudflare account. Set it up (the free plan is enough), or reconnect Cloudflare so Creek may do it.",
        { setupUrl },
      );
    }
    teamDomain = await createOrganization(token, accountId, orgName);
  }

  let idps: number | null = null;
  try {
    idps = await countIdentityProviders(token, accountId);
  } catch (err) {
    // Without read access to login methods, assume the account has one:
    // a login page with none fails visibly, not open.
    if (!(err instanceof CloudflareApiError && (err.status === 401 || err.status === 403))) {
      throw err;
    }
  }
  if (idps === 0) {
    if (!canWrite) {
      throw new ProvisionError(
        409,
        "login_method_required",
        "Your Zero Trust organization has no login method. Add one (One-time PIN is enough), or reconnect Cloudflare so Creek may do it.",
        {
          setupUrl: `https://dash.cloudflare.com/${accountId}/one/settings/authentication`,
        },
      );
    }
    await createOneTimePin(token, accountId);
  }
  return teamDomain;
}

/** The team's members' emails, lowercased and sorted. */
export async function memberEmails(env: Env, teamId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT u.email AS email FROM member m JOIN user u ON u.id = m.userId
     WHERE m.organizationId = ? ORDER BY u.email`,
  )
    .bind(teamId)
    .all<{ email: string }>();
  return results.map((r) => r.email.trim().toLowerCase()).filter((e) => EMAIL.test(e));
}

/** The project's custom domains, primary first. */
export async function projectHostnames(env: Env, projectId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT hostname FROM custom_domain WHERE projectId = ?
     ORDER BY isPrimary DESC, createdAt, hostname`,
  )
    .bind(projectId)
    .all<{ hostname: string }>();
  return results.map((r) => r.hostname);
}

/** Create or update an application; replaces one that was deleted at Cloudflare. */
async function upsertApp(
  token: string,
  accountId: string,
  appId: string | null,
  spec: AppSpec,
  created: string[],
) {
  if (appId) {
    const updated = await updateApp(token, accountId, appId, spec);
    if (updated) return updated;
  }
  const app = await createApp(token, accountId, spec);
  created.push(app.id);
  return app;
}

/**
 * Bring the team's Cloudflare account in line with the request. Does not
 * write to D1: the caller saves the result, and deletes `created` if it
 * cannot. On a throw, applications this call created are already deleted.
 */
export async function provisionManagedAccess(
  env: Env,
  ctx: ProvisionContext,
): Promise<Provisioned> {
  const hostnames = await projectHostnames(env, ctx.project.id);
  if (!hostnames.length) {
    throw new ProvisionError(
      400,
      "no_custom_domain",
      "Add a custom domain on a zone in your Cloudflare account first: Access protects your own domain",
    );
  }

  const token = await teamToken(env, ctx.teamId);
  const { accountId, accountName, scopes } = await chooseAccount(
    env,
    ctx.teamId,
    ctx.input,
    ctx.previous,
  );

  const include: AccessRule[] = [];
  const members = ctx.input.teamMembers ? await memberEmails(env, ctx.teamId) : [];
  const emails = new Set(ctx.input.emails);
  for (const e of members) emails.add(e);
  for (const email of emails) include.push({ email: { email } });
  for (const domain of ctx.input.emailDomains) include.push({ email_domain: { domain } });
  if (!include.length) {
    throw new ProvisionError(
      400,
      "validation",
      "Nobody would be allowed in: add an email or domain",
    );
  }

  const created: string[] = [];
  try {
    const teamDomain = await ensureZeroTrust(token, accountId, accountName ?? ctx.teamSlug, scopes);

    const label = `Creek · ${ctx.teamSlug}/${ctx.project.slug}`;

    // Bypass first, the allow-list last: once an existing application's
    // allow-list changes it is live, so nothing else at Cloudflare may fail
    // after it. A bypass change that is left half-done fails closed, because
    // the dispatch worker still only exempts the paths saved in D1.
    let bypassAppId: string | null = null;
    if (ctx.bypassPaths.length) {
      const destinations = hostnames.flatMap((h) => ctx.bypassPaths.map((p) => `${h}${p}`));
      const bypass = await upsertApp(
        token,
        accountId,
        ctx.previous?.bypassAppId ?? null,
        {
          name: `${label} (public paths)`,
          destinations,
          decision: "bypass",
          include: [],
        },
        created,
      );
      bypassAppId = bypass.id;
    } else if (ctx.previous?.bypassAppId) {
      await deleteApp(token, accountId, ctx.previous.bypassAppId);
    }

    const app = await upsertApp(
      token,
      accountId,
      ctx.previous?.appId ?? null,
      { name: label, destinations: hostnames, decision: "allow", include },
      created,
    );

    return {
      teamDomain,
      aud: app.aud,
      hostnames,
      created,
      token,
      managed: {
        accountId,
        appId: app.id,
        bypassAppId,
        emails: ctx.input.emails,
        emailDomains: ctx.input.emailDomains,
        teamMembers: ctx.input.teamMembers,
        appliedHostnames: hostnames,
        appliedMemberEmails: ctx.input.teamMembers ? members : null,
      },
    };
  } catch (err) {
    await deleteCreated(token, accountId, created);
    throw fromCloudflare(err);
  }
}

/** Best-effort cleanup of applications nothing refers to. */
export async function deleteCreated(token: string, accountId: string, appIds: string[]) {
  for (const id of appIds) {
    await deleteApp(token, accountId, id).catch((e) =>
      console.error(`[access] could not delete Access application ${id}:`, e),
    );
  }
}

/** Delete a project's managed applications. Returns the ids it could not delete. */
export async function removeManagedApps(
  env: Env,
  teamId: string,
  managed: ManagedAccess,
): Promise<{ ok: true } | { ok: false; message: string; appIds: string[] }> {
  const ids = [managed.appId, managed.bypassAppId].filter((id): id is string => !!id);
  let token: string;
  try {
    token = await teamToken(env, teamId);
  } catch (err) {
    return { ok: false, message: (err as Error).message, appIds: ids };
  }
  const left: string[] = [];
  let message = "";
  for (const id of ids) {
    try {
      await deleteApp(token, managed.accountId, id);
    } catch (err) {
      left.push(id);
      message = String(err);
    }
  }
  return left.length ? { ok: false, message, appIds: left } : { ok: true };
}
