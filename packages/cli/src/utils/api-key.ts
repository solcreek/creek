/**
 * The API key the CLI is using: where it came from, and what the API says
 * about it (GET /api-keys/self). Shared by whoami, login, logout and keys.
 *
 * The CLI authenticates every request with an API key (x-api-key), never
 * with a dashboard session. Key management routes that need a session
 * (minting, listing, revoking other keys) are therefore out of its reach;
 * a key can only read and revoke itself.
 */

import {
  CreekAuthError,
  isApiKeySelfUnsupported,
  type ApiKeySelf,
  type CreekClient,
} from "@solcreek/sdk";
import type { TokenInfo } from "./config.js";

/** What `--json` output reports about a key. */
export interface KeySummary {
  id: string;
  name: string | null;
  /** The first characters of the key, to tell keys apart. */
  start: string | null;
  kind: "legacy" | "scoped";
  /** The pinned team; null for a legacy key (it acts in any of its owner's teams). */
  team: { id: string; slug: string | null } | null;
  /** Stored scopes; null for a legacy key (full access). */
  scopes: string[] | null;
  /** Scopes the owner's current team role still lets the key use; null for a legacy key. */
  effectiveScopes: string[] | null;
  role: string | null;
  access: "scoped" | "full" | "none";
  expiresAt: string | null;
  expired: boolean;
  createdAt: string | null;
  lastUsedAt: string | null;
  warning?: string;
}

/**
 * Non-secret key prefixes. Creek keys are minted with "crk_sk_live_"
 * (control-plane tenant/auth.ts, defaultPrefix), and Better Auth stores the
 * first 16 characters as `start`: that prefix plus 4 secret characters.
 */
export const KEY_PREFIXES = ["crk_sk_live_", "crk_sk_test_", "ck_"] as const;
/** Secret characters a key hint may show: as many as Better Auth's `start`. */
export const KEY_HINT_SECRET_CHARS = 4;

/**
 * The most of a key the CLI ever prints: its non-secret prefix plus at most
 * KEY_HINT_SECRET_CHARS characters (only those characters, for a key without
 * a known prefix). Also applied to the API's `start`, so a longer stored
 * start never widens it.
 */
export function keyHint(key: string): string {
  const prefix = KEY_PREFIXES.find((p) => key.startsWith(p)) ?? "";
  return key.slice(0, prefix.length + KEY_HINT_SECRET_CHARS);
}

export function keySummary(self: ApiKeySelf): KeySummary {
  return {
    id: self.id,
    name: self.name,
    start: self.start ? keyHint(self.start) : null,
    kind: self.legacy ? "legacy" : "scoped",
    team: self.team,
    scopes: self.scopes,
    effectiveScopes: self.effectiveScopes,
    role: self.role,
    access: self.access,
    expiresAt: self.expiresAt,
    expired: self.expired,
    createdAt: self.createdAt,
    lastUsedAt: self.lastUsedAt,
    ...(self.warning ? { warning: self.warning } : {}),
  };
}

export type KeyLookup =
  | { ok: true; key: KeySummary }
  | {
      ok: false;
      /** server_unsupported: the API predates /api-keys/self. */
      error: "server_unsupported" | "unauthorized" | "lookup_failed";
      message: string;
      status?: number;
    };

export const SERVER_UNSUPPORTED_MESSAGE =
  "This Creek API does not support reading API key details (GET /api-keys/self). Upgrade the control-plane, or check the key in the dashboard.";

/** GET /api-keys/self, never throwing: a failure says why. */
export async function lookupKey(client: CreekClient): Promise<KeyLookup> {
  try {
    return { ok: true, key: keySummary(await client.getApiKeySelf()) };
  } catch (err) {
    if (isApiKeySelfUnsupported(err)) {
      return { ok: false, error: "server_unsupported", message: SERVER_UNSUPPORTED_MESSAGE };
    }
    if (err instanceof CreekAuthError) {
      return { ok: false, error: "unauthorized", message: err.message, status: 401 };
    }
    const status = (err as { status?: unknown }).status;
    return {
      ok: false,
      error: "lookup_failed",
      message: err instanceof Error ? err.message : String(err),
      ...(typeof status === "number" ? { status } : {}),
    };
  }
}

export type RevokeResult =
  | { ok: true; revoked: true; keyId: string }
  /** The API already refuses the key: nothing left to revoke. */
  | { ok: true; revoked: false; reason: "already_invalid"; message: string }
  | {
      ok: false;
      error: "server_unsupported" | "revoke_failed";
      message: string;
      status?: number;
      /**
       * revoke_failed: the DELETE may have revoked the key before the
       * connection dropped or the response failed; the outcome is unknown.
       * (server_unsupported proves nothing was revoked.)
       */
      mayHaveApplied: boolean;
    };

/** Where to look when a revocation's outcome is unknown. */
export const CHECK_KEY_BREADCRUMB = {
  command: "creek whoami --json",
  description: "Check whether the key still works (session_expired means it was revoked)",
};

/**
 * DELETE /api-keys/self, never throwing. A 401 means the key is already
 * revoked, expired or unknown — the state revoking asks for — so it is a
 * success with revoked: false.
 */
export async function revokeSelf(client: CreekClient): Promise<RevokeResult> {
  try {
    const res = await client.revokeApiKeySelf();
    return { ok: true, revoked: true, keyId: res.id };
  } catch (err) {
    if (err instanceof CreekAuthError) {
      return {
        ok: true,
        revoked: false,
        reason: "already_invalid",
        message: "The API no longer accepts this key (already revoked, expired or invalid).",
      };
    }
    if (isApiKeySelfUnsupported(err)) {
      return {
        ok: false,
        error: "server_unsupported",
        message:
          "This Creek API cannot revoke a key from the CLI (no DELETE /api-keys/self). Revoke it in the dashboard.",
        mayHaveApplied: false,
      };
    }
    const status = (err as { status?: unknown }).status;
    return {
      ok: false,
      error: "revoke_failed",
      message: `The revocation could not be confirmed (${err instanceof Error ? err.message : String(err)}); the key may or may not have been revoked.`,
      ...(typeof status === "number" ? { status } : {}),
      mayHaveApplied: true,
    };
  }
}

/**
 * The warning for a stored key that CREEK_TOKEN overrides, or null. The
 * variable wins whenever it is set, even empty (then no key is sent at all).
 */
export function envOverrideWarning(info: TokenInfo): string | null {
  if (info.source !== "env:CREEK_TOKEN") return null;
  if (!info.token) {
    return "CREEK_TOKEN is set but empty: the CLI sends no API key and ignores the key saved by `creek login`. Unset CREEK_TOKEN to use the saved key.";
  }
  if (info.shadowsConfigToken) {
    return "CREEK_TOKEN is set: it overrides the key saved by `creek login` for every command. Unset CREEK_TOKEN to use the saved key.";
  }
  return null;
}

/** Human lines describing a key. */
export function keyLines(key: KeySummary): string[] {
  const lines = [
    `  Key:    ${key.name ?? "(unnamed)"} (${key.id}${key.start ? `, ${key.start}…` : ""})`,
  ];
  if (key.kind === "legacy") {
    lines.push("  Kind:   legacy (full access in every team you belong to)");
  } else {
    lines.push(`  Kind:   scoped to team ${key.team?.slug ?? key.team?.id ?? "?"}`);
    lines.push(
      `  Scopes: ${key.effectiveScopes?.length ? key.effectiveScopes.join(", ") : "none"}`,
    );
    const lost = (key.scopes ?? []).filter((s) => !key.effectiveScopes?.includes(s));
    if (lost.length > 0) lines.push(`          (not allowed by your role now: ${lost.join(", ")})`);
  }
  lines.push(
    `  Expiry: ${key.expiresAt ?? "never"}${key.expired ? " (expired)" : ""}`,
    `  Used:   ${key.lastUsedAt ?? "never"}`,
  );
  return lines;
}

export function describeTokenSource(info: TokenInfo): string {
  return info.source === "env:CREEK_TOKEN"
    ? "CREEK_TOKEN environment variable"
    : "~/.creek/config.json (creek login)";
}
