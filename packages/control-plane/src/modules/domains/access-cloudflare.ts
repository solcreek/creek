/**
 * The Cloudflare Access API calls Creek makes in a team's own account, with
 * the token from its "Connect Cloudflare" grant.
 *
 * Verified against the API 2026-11-28:
 *   - an application created with inline `policies` owns them ("reusable":
 *     false); an update that sends `policies` replaces them, and they go
 *     away with the application. So Creek never creates reusable policies;
 *   - an update keeps the application's AUD;
 *   - a path bypass is a second self_hosted application on `host/path`
 *     destinations; Access applies the more specific one;
 *   - creating the Zero Trust organization without auth_domain gets a
 *     generated <name>.cloudflareaccess.com, and no plan subscription is
 *     needed for Access logins.
 * Creating the organization or an identity provider needs the
 * access-acct.write scope; applications need access.write.
 */

import { CLOUDFLARE_API_ORIGIN } from "../cloudflare-connection/oauth.js";

const TIMEOUT_MS = 15 * 1000;

export class CloudflareApiError extends Error {
  constructor(
    readonly status: number,
    readonly errors: { code?: number; message?: string }[],
    what: string,
  ) {
    const detail = errors
      .map((e) => e.message)
      .filter(Boolean)
      .join("; ");
    super(`Cloudflare ${what} failed (${status})${detail ? `: ${detail}` : ""}`);
    this.name = "CloudflareApiError";
  }
}

async function call<T>(
  token: string,
  method: string,
  path: string,
  what: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(new URL(`/client/v4${path}`, CLOUDFLARE_API_ORIGIN), {
    method,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as {
    success?: boolean;
    result?: T;
    errors?: { code?: number; message?: string }[];
  } | null;
  if (!res.ok || !json?.success) {
    throw new CloudflareApiError(res.status, json?.errors ?? [], what);
  }
  return json.result as T;
}

const accountPath = (accountId: string) => `/accounts/${encodeURIComponent(accountId)}`;

// --- Zero Trust organization and login methods ---

/** The account's Zero Trust team domain, or null when Zero Trust was never set up. */
export async function getTeamDomain(token: string, accountId: string): Promise<string | null> {
  try {
    const org = await call<{ auth_domain?: unknown } | null>(
      token,
      "GET",
      `${accountPath(accountId)}/access/organizations`,
      "reading the Zero Trust organization",
    );
    return typeof org?.auth_domain === "string" && org.auth_domain ? org.auth_domain : null;
  } catch (err) {
    if (err instanceof CloudflareApiError && err.status === 404) return null;
    throw err;
  }
}

/** Set up Zero Trust with a generated team domain; returns it. */
export async function createOrganization(
  token: string,
  accountId: string,
  name: string,
): Promise<string> {
  const org = await call<{ auth_domain?: unknown }>(
    token,
    "POST",
    `${accountPath(accountId)}/access/organizations`,
    "setting up Zero Trust",
    { name },
  );
  if (typeof org?.auth_domain !== "string" || !org.auth_domain) {
    throw new CloudflareApiError(
      200,
      [{ message: "no auth_domain returned" }],
      "setting up Zero Trust",
    );
  }
  return org.auth_domain;
}

export async function countIdentityProviders(token: string, accountId: string): Promise<number> {
  const idps = await call<unknown[]>(
    token,
    "GET",
    `${accountPath(accountId)}/access/identity_providers`,
    "listing login methods",
  );
  return Array.isArray(idps) ? idps.length : 0;
}

/** One-time PIN: a code by email. Works for any address, with nothing to configure. */
export async function createOneTimePin(token: string, accountId: string): Promise<void> {
  await call(
    token,
    "POST",
    `${accountPath(accountId)}/access/identity_providers`,
    "adding the One-time PIN login method",
    { name: "One-time PIN", type: "onetimepin", config: {} },
  );
}

// --- Applications ---

export type AccessRule = { email: { email: string } } | { email_domain: { domain: string } };

export interface AppSpec {
  name: string;
  /** host or host/path; at least one. */
  destinations: string[];
  decision: "allow" | "bypass";
  /** For "allow": who gets in. "bypass" always includes everyone. */
  include: AccessRule[];
}

function appBody(spec: AppSpec) {
  return {
    type: "self_hosted",
    name: spec.name,
    domain: spec.destinations[0],
    destinations: spec.destinations.map((uri) => ({ type: "public", uri })),
    session_duration: "24h",
    app_launcher_visible: false,
    policies: [
      {
        name: spec.decision === "bypass" ? "Creek: public paths" : "Creek: allowed people",
        decision: spec.decision,
        include: spec.decision === "bypass" ? [{ everyone: {} }] : spec.include,
      },
    ],
  };
}

export interface AccessApp {
  id: string;
  aud: string;
}

function toApp(result: { id?: unknown; aud?: unknown }, what: string): AccessApp {
  if (typeof result?.id !== "string" || typeof result.aud !== "string") {
    throw new CloudflareApiError(200, [{ message: "no id or aud returned" }], what);
  }
  return { id: result.id, aud: result.aud };
}

export async function createApp(
  token: string,
  accountId: string,
  spec: AppSpec,
): Promise<AccessApp> {
  const what = "creating the Access application";
  return toApp(
    await call(token, "POST", `${accountPath(accountId)}/access/apps`, what, appBody(spec)),
    what,
  );
}

/** Replace an application's settings and policies. Null when it no longer exists. */
export async function updateApp(
  token: string,
  accountId: string,
  appId: string,
  spec: AppSpec,
): Promise<AccessApp | null> {
  const what = "updating the Access application";
  try {
    return toApp(
      await call(
        token,
        "PUT",
        `${accountPath(accountId)}/access/apps/${encodeURIComponent(appId)}`,
        what,
        appBody(spec),
      ),
      what,
    );
  } catch (err) {
    if (err instanceof CloudflareApiError && err.status === 404) return null;
    throw err;
  }
}

/** Delete an application (and the policies it owns). One already gone counts as deleted. */
export async function deleteApp(token: string, accountId: string, appId: string): Promise<void> {
  try {
    await call(
      token,
      "DELETE",
      `${accountPath(accountId)}/access/apps/${encodeURIComponent(appId)}`,
      "deleting the Access application",
    );
  } catch (err) {
    if (err instanceof CloudflareApiError && err.status === 404) return;
    throw err;
  }
}
