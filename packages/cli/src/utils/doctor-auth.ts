import consola from "consola";
import { CreekApiError, CreekClient, resolveConfig } from "@solcreek/sdk";
import {
  describeTokenSource,
  diagnoseTokenFormat,
  isUnsendableTokenFormat,
  lookupKey,
  type KeySummary,
} from "./api-key.js";
import { apiErrorFields, apiErrorHints, isEdgeBlockedError } from "./api-error.js";
import { readDirectoryProject, type ProjectSource } from "./command-context.js";
import { getApiUrl, getToken, getTokenSource, type TokenSource } from "./config.js";
import { AUTH_BREADCRUMBS, jsonOutput, type Breadcrumb } from "./output.js";
import { validateSubpath } from "./repo-url.js";
import { shellQuote } from "./shell-quote.js";

export type AuthCheckStatus = "pass" | "warn" | "fail" | "skip";

export interface AuthCheck {
  id: "token" | "format" | "session" | "key" | "project" | "scopes";
  status: AuthCheckStatus;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface AuthDoctorOptions {
  cwd: string;
  rawPath?: string;
  project: string | undefined;
  prod: boolean;
  jsonMode: boolean;
}

interface AuthUser {
  id: string;
  email: string;
  name: string | null;
}

interface AuthProjectInfo {
  slug: string;
  id?: string;
  source: ProjectSource;
  exists: boolean | null;
  canAccess: boolean | null;
}

const COLOR = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  gray: "\x1b[90m",
};

function c(s: string, color: keyof typeof COLOR): string {
  return (process.stdout.isTTY ?? false) ? `${COLOR[color]}${s}${COLOR.reset}` : s;
}

function statusIcon(status: AuthCheckStatus): string {
  switch (status) {
    case "pass":
      return c("✓", "green");
    case "warn":
      return c("!", "yellow");
    case "fail":
      return c("✗", "red");
    case "skip":
      return c("-", "gray");
  }
}

function printHumanReport(opts: {
  target: "production" | "general";
  apiUrl: string;
  tokenSource: TokenSource | null;
  warning?: string;
  checks: AuthCheck[];
  hints?: string[];
  breadcrumbs: Breadcrumb[];
}): void {
  consola.log("");
  consola.log(
    `  ${c("⬡ creek doctor --auth", "bold")}  ${c(`(${opts.target}, ${opts.apiUrl})`, "dim")}`,
  );
  if (opts.tokenSource) {
    consola.log(`  ${c("source:", "dim")} ${describeTokenSource({ source: opts.tokenSource })}`);
  }
  if (opts.warning) {
    consola.warn(`  ${opts.warning}`);
  }
  consola.log("");

  for (const ch of opts.checks) {
    consola.log(`  ${statusIcon(ch.status)} ${ch.id.padEnd(8)} ${ch.message}`);
  }
  if (opts.hints?.length) {
    consola.log("");
    for (const h of opts.hints) consola.info(`  ${h}`);
  }
  if (opts.checks.some((ch) => ch.status === "fail") && opts.breadcrumbs.length > 0) {
    consola.log("");
    consola.log(`  ${c("next:", "dim")} ${opts.breadcrumbs[0]!.command}`);
  }
  consola.log("");
}

function failureBreadcrumbs(errorCode: string): Breadcrumb[] {
  if (
    errorCode === "edge_blocked" ||
    errorCode === "api_unreachable" ||
    errorCode === "lookup_failed" ||
    errorCode === "api_error"
  ) {
    return [];
  }
  if (errorCode === "key_unusable") {
    return [
      { command: "creek keys revoke --self --json", description: "Revoke this unusable key" },
      ...AUTH_BREADCRUMBS,
    ];
  }
  if (errorCode === "insufficient_scope" || errorCode === "insufficient_role") {
    return [
      { command: "creek keys self --json", description: "Inspect this API key's team and scopes" },
      ...AUTH_BREADCRUMBS,
    ];
  }
  return AUTH_BREADCRUMBS;
}

function buildSuccessBreadcrumbs(opts: {
  prod: boolean;
  rawPath?: string;
  project?: string;
  canDeployCheckedDir: boolean;
}): Breadcrumb[] {
  if (!opts.prod) {
    const cmd =
      opts.rawPath && opts.project
        ? `creek doctor ${shellQuote(opts.rawPath)} --project ${shellQuote(opts.project)} --auth --prod --json`
        : opts.rawPath
          ? `creek doctor ${shellQuote(opts.rawPath)} --auth --prod --json`
          : opts.project
            ? `creek doctor --project ${shellQuote(opts.project)} --auth --prod --json`
            : "creek doctor --auth --prod --json";
    return [{ command: cmd, description: "Verify production deploy scopes specifically" }];
  }
  if (!opts.canDeployCheckedDir) return [];
  if (opts.rawPath) {
    try {
      validateSubpath(opts.rawPath);
      const sub = opts.rawPath.replace(/\/+$/, "");
      return [
        {
          command: `creek deploy --path ${shellQuote(sub)} --prod --json`,
          description: "Deploy to production",
        },
      ];
    } catch {
      return [
        {
          command: `cd ${shellQuote(opts.rawPath)} && creek deploy --prod --json`,
          description: "Deploy to production from the checked directory",
        },
      ];
    }
  }
  return [{ command: "creek deploy --prod --json", description: "Deploy to production" }];
}

/**
 * Whether `creek deploy --prod` run against `cwd` would deploy `slug` to Creek Cloud
 * (as opposed to a different project, a missing/unreadable config, or a `creekd` target
 * that uses CREEKD_TOKEN / CREEKCTL_TOKEN).
 */
function checkedDirDeploysCloudProject(slug: string, cwd: string): boolean {
  try {
    const config = resolveConfig(cwd);
    return config.target === "cf" && config.projectName === slug;
  } catch {
    return false;
  }
}

/**
 * Scrub the active API key from any unexpected error message or hint so raw
 * credentials can never leak into JSON or human diagnostic output.
 */
function redactToken(text: string, token: string): string {
  if (token.length < 6) return text;
  let redacted = text.replaceAll(token, "[REDACTED]");
  const trimmed = token.trim();
  if (trimmed.length >= 6 && trimmed !== token) {
    redacted = redacted.replaceAll(trimmed, "[REDACTED]");
  }
  return redacted;
}

function redactErrorFields<T extends { message?: string }>(fields: T, token: string): T {
  if (typeof fields.message !== "string") return fields;
  return { ...fields, message: redactToken(fields.message, token) };
}

function finishAuthReport(opts: {
  doctor: AuthDoctorOptions;
  apiUrl: string;
  tokenSource: TokenSource | null;
  warning?: string;
  tokenFormatIssue?: string;
  user: AuthUser | null;
  key: KeySummary | null;
  project: AuthProjectInfo | null;
  checks: AuthCheck[];
  extraErrorFields?: Record<string, unknown>;
  overrideError?: { code: string; message: string; breadcrumbs?: Breadcrumb[] };
  successBreadcrumbs?: Breadcrumb[];
  hints?: string[];
}): never | void {
  const target = opts.doctor.prod ? "production" : "general";
  const failedCheck = opts.checks.find((ch) => ch.status === "fail");
  const errorCode = opts.overrideError?.code ?? failedCheck?.code;
  const ok = !failedCheck && !opts.overrideError;
  const message =
    opts.overrideError?.message ??
    (opts.extraErrorFields?.message as string | undefined) ??
    failedCheck?.message;

  const breadcrumbs: Breadcrumb[] = ok
    ? (opts.successBreadcrumbs ??
      buildSuccessBreadcrumbs({
        prod: opts.doctor.prod,
        rawPath: opts.doctor.rawPath,
        project: opts.doctor.project,
        canDeployCheckedDir: false,
      }))
    : (opts.overrideError?.breadcrumbs ?? failureBreadcrumbs(errorCode ?? "auth_failed"));

  if (opts.doctor.jsonMode) {
    jsonOutput(
      {
        ok,
        ...(ok
          ? {}
          : {
              error: errorCode,
              message,
              ...opts.extraErrorFields,
            }),
        mode: "auth",
        target,
        apiUrl: opts.apiUrl,
        tokenSource: opts.tokenSource,
        ...(opts.warning ? { warning: opts.warning } : {}),
        ...(opts.tokenFormatIssue ? { tokenFormatIssue: opts.tokenFormatIssue } : {}),
        user: opts.user,
        key: opts.key,
        project: opts.project,
        checks: opts.checks,
      },
      ok ? 0 : 1,
      breadcrumbs,
    );
  }

  printHumanReport({
    target,
    apiUrl: opts.apiUrl,
    tokenSource: opts.tokenSource,
    warning: opts.warning,
    checks: opts.checks,
    hints: opts.hints,
    breadcrumbs,
  });
  if (!ok) process.exit(1);
}

/**
 * Verify CLI auth readiness before deploying: token presence & format,
 * API connectivity / WAF block check, key usability & scopes, and optional
 * project access.
 */
export async function runAuthDoctor(opts: AuthDoctorOptions): Promise<void> {
  const checks: AuthCheck[] = [];
  const token = getToken();
  const tokenSourceInfo = getTokenSource();
  const apiUrl = getApiUrl();
  const warning =
    tokenSourceInfo.source === "env:CREEK_TOKEN" && tokenSourceInfo.shadowsConfigToken
      ? "CREEK_TOKEN is set: it overrides the key saved by `creek login` for every command. Unset CREEK_TOKEN to use the saved key."
      : undefined;

  if (!token) {
    const message =
      tokenSourceInfo.source === "env:CREEK_TOKEN"
        ? "CREEK_TOKEN is set but empty: the CLI sends no API key and ignores the key saved by `creek login`. Set a valid key or unset CREEK_TOKEN."
        : "Not authenticated. Set CREEK_TOKEN or run `creek login --token <KEY>`.";
    checks.push({ id: "token", status: "fail", code: "not_authenticated", message });
    finishAuthReport({
      doctor: opts,
      apiUrl,
      tokenSource: tokenSourceInfo.source,
      warning,
      user: null,
      key: null,
      project: null,
      checks,
    });
    return;
  }

  checks.push({
    id: "token",
    status: "pass",
    code: "token_present",
    message: `Using token from ${describeTokenSource(tokenSourceInfo)}`,
    details: { tokenSource: tokenSourceInfo.source },
  });

  const formatIssue = diagnoseTokenFormat(token);
  // Reject newlines, NUL bytes, control chars, and non-ByteString chars before
  // constructing any HTTP request: Node's fetch/Headers rejects them with an
  // error message that echoes the raw header value.
  if (token.includes("\0") || isUnsendableTokenFormat(formatIssue)) {
    const issue = formatIssue ?? {
      code: "contains_nul" as const,
      message:
        "The API key contains a NUL character; re-save or re-export the raw key without binary/NUL bytes.",
    };
    const base =
      tokenSourceInfo.source === "env:CREEK_TOKEN"
        ? "The API key in CREEK_TOKEN could not be sent."
        : "The saved API key could not be sent.";
    const message = `${base} ${issue.message}`;
    checks.push({
      id: "format",
      status: "fail",
      code: "invalid_token_format",
      message,
      details: { issue: issue.code },
    });
    finishAuthReport({
      doctor: opts,
      apiUrl,
      tokenSource: tokenSourceInfo.source,
      warning,
      tokenFormatIssue: issue.code,
      user: null,
      key: null,
      project: null,
      checks,
    });
    return;
  }

  if (formatIssue) {
    checks.push({
      id: "format",
      status: "warn",
      code: formatIssue.code,
      message: formatIssue.message,
      details: { issue: formatIssue.code },
    });
  } else {
    checks.push({
      id: "format",
      status: "pass",
      code: "format_valid",
      message: "Token format looks valid.",
    });
  }

  const client = new CreekClient(getApiUrl(), token);
  let session: Awaited<ReturnType<CreekClient["getSession"]>> = null;
  let sessionErr: unknown;
  try {
    session = await client.getSession();
  } catch (err) {
    sessionErr = err;
  }

  if (sessionErr !== undefined) {
    const apiFields = redactErrorFields(apiErrorFields(sessionErr), token);
    const errorCode = isEdgeBlockedError(sessionErr)
      ? "edge_blocked"
      : (apiFields.error ?? "api_error");
    const message = redactToken(
      apiFields.message ??
        (sessionErr instanceof Error ? sessionErr.message : "Failed to reach Creek API."),
      token,
    );
    checks.push({
      id: "session",
      status: "fail",
      code: errorCode,
      message,
      ...(apiFields.details ? { details: apiFields.details } : {}),
    });
    finishAuthReport({
      doctor: opts,
      apiUrl,
      tokenSource: tokenSourceInfo.source,
      warning,
      tokenFormatIssue: formatIssue?.code,
      user: null,
      key: null,
      project: null,
      checks,
      extraErrorFields: apiFields,
      overrideError: { code: errorCode, message, breadcrumbs: failureBreadcrumbs(errorCode) },
      hints: apiErrorHints(sessionErr).map((h) => redactToken(h, token)),
    });
    return;
  }

  const lookup = await lookupKey(client);
  if (!session?.user) {
    if (lookup.ok) {
      const key = lookup.key;
      const message =
        key.warning ??
        "The API recognises this key but refuses to act with it (access: none). Revoke it and use another key.";
      checks.push({ id: "session", status: "fail", code: "key_unusable", message });
      checks.push({
        id: "key",
        status: "fail",
        code: "key_unusable",
        message,
        details: { kind: key.kind, team: key.team, access: key.access, expired: key.expired },
      });
      finishAuthReport({
        doctor: opts,
        apiUrl,
        tokenSource: tokenSourceInfo.source,
        warning,
        tokenFormatIssue: formatIssue?.code,
        user: null,
        key,
        project: null,
        checks,
      });
      return;
    }

    if (lookup.error === "lookup_failed") {
      const err = lookup.cause ?? new Error(lookup.message);
      const apiFields = redactErrorFields(apiErrorFields(err), token);
      const errorCode = isEdgeBlockedError(err)
        ? "edge_blocked"
        : (apiFields.error ?? "lookup_failed");
      const message = redactToken(
        apiFields.message ?? `Could not verify API key via GET /api-keys/self: ${lookup.message}`,
        token,
      );
      checks.push({
        id: "session",
        status: "fail",
        code: "session_unverified",
        message: "Session check returned no user while API key metadata lookup failed.",
      });
      checks.push({
        id: "key",
        status: "fail",
        code: errorCode,
        message,
        ...(apiFields.details ? { details: apiFields.details } : {}),
      });
      finishAuthReport({
        doctor: opts,
        apiUrl,
        tokenSource: tokenSourceInfo.source,
        warning,
        tokenFormatIssue: formatIssue?.code,
        user: null,
        key: null,
        project: null,
        checks,
        extraErrorFields: apiFields,
        overrideError: { code: errorCode, message, breadcrumbs: failureBreadcrumbs(errorCode) },
        hints: apiErrorHints(err).map((h) => redactToken(h, token)),
      });
      return;
    }

    const base =
      tokenSourceInfo.source === "env:CREEK_TOKEN"
        ? "The API key in CREEK_TOKEN was refused (revoked, expired or invalid). Set a valid key, or unset CREEK_TOKEN to use the key saved by `creek login`."
        : "The saved API key was refused (revoked, expired or invalid). Run `creek login` to re-authenticate.";
    const message = formatIssue ? `${base} ${formatIssue.message}` : base;
    checks.push({ id: "session", status: "fail", code: "unauthorized", message });
    finishAuthReport({
      doctor: opts,
      apiUrl,
      tokenSource: tokenSourceInfo.source,
      warning,
      tokenFormatIssue: formatIssue?.code,
      user: null,
      key: null,
      project: null,
      checks,
    });
    return;
  }

  const user: AuthUser = {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name ?? null,
  };
  checks.push({
    id: "session",
    status: "pass",
    code: "authenticated",
    message: `Authenticated as ${user.email}`,
    details: { user },
  });

  let key: KeySummary | null = null;
  let keyLookupFailed = false;
  let keyErrorCode: string | undefined;
  let keyErrorFields: Record<string, unknown> | undefined;
  let keyHints: string[] | undefined;

  if (lookup.ok) {
    key = lookup.key;
    if (key.expired || key.access === "none") {
      const message =
        key.warning ?? (key.expired ? "API key is expired." : "API key cannot act (access: none).");
      checks.push({
        id: "key",
        status: "fail",
        code: "key_unusable",
        message,
        details: { kind: key.kind, team: key.team, access: key.access, expired: key.expired },
      });
    } else if (key.kind === "legacy") {
      checks.push({
        id: "key",
        status: "pass",
        code: "legacy_key",
        message: "Legacy key (unscoped; acts with your team role permissions).",
        details: { kind: key.kind, access: key.access },
      });
    } else {
      const effective = key.effectiveScopes ?? [];
      const droppedByRole = (key.scopes ?? []).filter((s) => !effective.includes(s));
      const teamLabel = key.team?.slug ?? key.team?.id ?? "unknown";
      if (droppedByRole.length > 0) {
        checks.push({
          id: "key",
          status: "warn",
          code: "role_restricted",
          message: `Scoped key for team ${teamLabel}: owner's current role drops stored scope(s): ${droppedByRole.join(", ")}.`,
          details: {
            team: key.team,
            scopes: key.scopes,
            effectiveScopes: key.effectiveScopes,
            droppedByRole,
          },
        });
      } else {
        checks.push({
          id: "key",
          status: "pass",
          code: "scoped_key",
          message: `Scoped key for team ${teamLabel} (${(key.effectiveScopes ?? []).length} effective scope(s)).`,
          details: { team: key.team, effectiveScopes: key.effectiveScopes },
        });
      }
    }
  } else if (lookup.error === "server_unsupported") {
    checks.push({ id: "key", status: "skip", code: "server_unsupported", message: lookup.message });
  } else {
    keyLookupFailed = true;
    const err = lookup.cause ?? new Error(lookup.message);
    const fields = redactErrorFields(apiErrorFields(err), token);
    keyErrorCode = isEdgeBlockedError(err) ? "edge_blocked" : (fields.error ?? lookup.error);
    const message = redactToken(
      fields.message ??
        (opts.prod
          ? `Cannot verify required production scopes because GET /api-keys/self failed: ${lookup.message}`
          : lookup.message),
      token,
    );
    if (opts.prod) {
      keyErrorFields = fields;
      keyHints = apiErrorHints(err).map((h) => redactToken(h, token));
    }
    checks.push({
      id: "key",
      status: opts.prod ? "fail" : "warn",
      code: keyErrorCode,
      message,
      details: {
        ...(lookup.status !== undefined ? { status: lookup.status } : {}),
        ...fields.details,
      },
    });
  }

  let projectInfo: AuthProjectInfo | null = null;
  let projectErrorFields: Record<string, unknown> | undefined;
  let projectHints: string[] | undefined;

  let targetProject: { slug: string; source: ProjectSource; isCreekd: boolean } | null = null;
  if (opts.project) {
    targetProject = { slug: opts.project, source: "flag", isCreekd: false };
  } else {
    const dirProject = readDirectoryProject(opts.jsonMode, opts.cwd);
    if (dirProject?.slug) {
      targetProject = {
        slug: dirProject.slug,
        source: dirProject.source,
        isCreekd: dirProject.config.target === "creekd",
      };
    }
  }

  if (!targetProject) {
    checks.push({
      id: "project",
      status: "skip",
      code: "no_project",
      message:
        "No project found in this directory; pass [path] or --project <slug> to verify project access.",
    });
  } else if (targetProject.isCreekd) {
    projectInfo = {
      slug: targetProject.slug,
      source: targetProject.source,
      exists: null,
      canAccess: null,
    };
    checks.push({
      id: "project",
      status: "skip",
      code: "creekd_target",
      message: `Project "${targetProject.slug}" targets creekd (creek.toml target = "creekd"), which uses CREEKD_TOKEN / CREEKCTL_TOKEN rather than Creek API keys.`,
      details: { slug: targetProject.slug, source: targetProject.source },
    });
  } else if (key?.kind === "scoped" && !(key.effectiveScopes ?? []).includes("project:read")) {
    projectInfo = {
      slug: targetProject.slug,
      source: targetProject.source,
      exists: null,
      canAccess: false,
    };
    checks.push({
      id: "project",
      status: "skip",
      code: "missing_project_read",
      message: `Skipped reading project "${targetProject.slug}" because the key lacks effective scope "project:read".`,
      details: { slug: targetProject.slug, source: targetProject.source },
    });
  } else {
    try {
      const proj = await client.getProject(targetProject.slug);
      projectInfo = {
        slug: proj.slug,
        id: proj.id,
        source: targetProject.source,
        exists: true,
        canAccess: true,
      };
      checks.push({
        id: "project",
        status: "pass",
        code: "project_accessible",
        message: `Project "${proj.slug}" (${targetProject.source}) exists and is accessible.`,
        details: { slug: proj.slug, id: proj.id, source: targetProject.source },
      });
    } catch (err) {
      if (err instanceof CreekApiError && err.status === 404) {
        const teamHint = key?.team?.slug ? ` in team ${key.team.slug}` : "";
        projectInfo = {
          slug: targetProject.slug,
          source: targetProject.source,
          exists: false,
          canAccess: null,
        };
        checks.push({
          id: "project",
          status: "warn",
          code: "project_not_found",
          message: `Project "${targetProject.slug}" was not found${teamHint} (a first deploy requires creating it: project:write scope and project:create team role permission).`,
          details: { slug: targetProject.slug, source: targetProject.source, status: 404 },
        });
      } else {
        const fields = redactErrorFields(apiErrorFields(err), token);
        projectErrorFields = fields;
        projectHints = apiErrorHints(err).map((h) => redactToken(h, token));
        const code = isEdgeBlockedError(err)
          ? "edge_blocked"
          : err instanceof CreekApiError &&
              (err.code === "insufficient_scope" || err.code === "insufficient_role")
            ? err.code
            : (fields.error ?? "api_error");
        const message = redactToken(
          fields.message ??
            (err instanceof Error
              ? err.message
              : `Failed to read project "${targetProject.slug}".`),
          token,
        );
        projectInfo = {
          slug: targetProject.slug,
          source: targetProject.source,
          exists: null,
          canAccess: false,
        };
        checks.push({
          id: "project",
          status: "fail",
          code,
          message,
          details: {
            slug: targetProject.slug,
            source: targetProject.source,
            ...fields.details,
          },
        });
      }
    }
  }

  if (!key) {
    checks.push({
      id: "scopes",
      status: "skip",
      code: keyLookupFailed ? "key_lookup_failed" : "key_unavailable",
      message: keyLookupFailed
        ? "Skipped scope check because GET /api-keys/self failed."
        : "Key scope details unavailable from this API.",
    });
  } else if (key.access === "none" || key.expired) {
    checks.push({
      id: "scopes",
      status: "fail",
      code: "key_unusable",
      message: "API key has no active access.",
    });
  } else if (key.kind === "legacy") {
    if (opts.prod && projectInfo?.exists === false) {
      checks.push({
        id: "scopes",
        status: "warn",
        code: "legacy_role_unverified",
        message: `Legacy key bypasses API-key scopes, not team role permissions. Project "${projectInfo.slug}" does not exist yet: creating it on first deploy requires team role permission "project:create" (admin or owner), which cannot be verified for a legacy key.`,
        details: {
          unverifiedPermissions: ["project:create"],
          reason: "legacy_key_has_no_role_metadata",
        },
      });
    } else {
      checks.push({
        id: "scopes",
        status: "pass",
        code: "legacy_key_unscoped",
        message:
          "Legacy key bypasses API-key scopes (team role permissions are still enforced by the API).",
      });
    }
  } else {
    const effective = new Set(key.effectiveScopes ?? []);
    const stored = new Set(key.scopes ?? []);
    if (opts.prod) {
      const required = ["project:read", "deploy:production"];
      if (projectInfo?.exists === false) required.push("project:write");
      const missing = required.filter((s) => !effective.has(s));
      if (missing.length > 0) {
        const dropped = missing.filter((s) => stored.has(s));
        const code = dropped.length === missing.length ? "insufficient_role" : "insufficient_scope";
        let message = `Missing required scope(s) for --prod deploy: ${missing.join(", ")}.`;
        if (dropped.length > 0) {
          message += ` (${dropped.join(", ")} stored on the key, but blocked by the owner's current team role.)`;
        }
        if (missing.includes("project:write") && projectInfo?.exists === false) {
          message += ` Project "${projectInfo.slug}" does not exist yet: create it first or use a key with "project:write".`;
        }
        checks.push({
          id: "scopes",
          status: "fail",
          code,
          message,
          details: {
            required,
            missing,
            granted: key.effectiveScopes ?? [],
            ...(dropped.length > 0 ? { droppedByRole: dropped } : {}),
          },
        });
      } else {
        checks.push({
          id: "scopes",
          status: "pass",
          code: "prod_scopes_ok",
          message: `Key holds all required production deploy scopes (${required.join(", ")}).`,
          details: { required, granted: key.effectiveScopes ?? [] },
        });
      }
    } else {
      if (effective.has("project:read") && effective.has("deploy:production")) {
        checks.push({
          id: "scopes",
          status: "pass",
          code: "deploy_scopes_ok",
          message: "Key holds project:read and deploy:production.",
          details: { granted: key.effectiveScopes ?? [] },
        });
      } else if (effective.has("project:read") && effective.has("deploy:preview")) {
        checks.push({
          id: "scopes",
          status: "pass",
          code: "preview_scopes_ok",
          message:
            "Key holds project:read and deploy:preview (pass --prod to verify production deploy scopes).",
          details: { granted: key.effectiveScopes ?? [] },
        });
      } else {
        const grantedText = key.effectiveScopes?.length ? key.effectiveScopes.join(", ") : "none";
        checks.push({
          id: "scopes",
          status: "warn",
          code: "missing_deploy_scopes",
          message: `Key is authenticated but lacks deploy scopes (needs project:read and deploy:production or deploy:preview; has: ${grantedText}).`,
          details: { granted: key.effectiveScopes ?? [] },
        });
      }
    }
  }

  const failed = checks.find((ch) => ch.status === "fail");
  const canDeployCheckedDir =
    !!targetProject &&
    !targetProject.isCreekd &&
    checkedDirDeploysCloudProject(targetProject.slug, opts.cwd);
  const successBreadcrumbs = buildSuccessBreadcrumbs({
    prod: opts.prod,
    rawPath: opts.rawPath,
    project: opts.project,
    canDeployCheckedDir,
  });

  const errorMeta =
    failed?.id === "key" && keyErrorFields
      ? {
          extraErrorFields: keyErrorFields,
          hints: keyHints,
          ...(keyErrorCode
            ? {
                overrideError: {
                  code: keyErrorCode,
                  message: failed.message,
                  breadcrumbs: failureBreadcrumbs(keyErrorCode),
                },
              }
            : {}),
        }
      : failed?.id === "project" && projectErrorFields
        ? { extraErrorFields: projectErrorFields, hints: projectHints }
        : {};

  finishAuthReport({
    doctor: opts,
    apiUrl,
    tokenSource: tokenSourceInfo.source,
    warning,
    tokenFormatIssue: formatIssue?.code,
    user,
    key,
    project: projectInfo,
    checks,
    successBreadcrumbs,
    ...errorMeta,
  });
}
