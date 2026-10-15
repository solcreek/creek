import { defineCommand } from "citty";
import consola from "consola";
import { CreekClient } from "@solcreek/sdk";
import {
  clearCliToken,
  getApiUrl,
  getDashboardUrl,
  getTokenInfo,
  readCliConfig,
} from "../utils/config.js";
import { globalArgs, resolveJsonMode, jsonOutput, type Breadcrumb } from "../utils/output.js";
import { keyHint, revokeSelf } from "../utils/api-key.js";

/**
 * `creek logout [--revoke]`.
 *
 * Without --revoke it only forgets the key saved by `creek login`; the key
 * itself stays valid on the server. With --revoke it revokes every distinct
 * key the CLI holds — CREEK_TOKEN's and the saved one — each with
 * DELETE /api-keys/self sent with that key, and forgets the saved key once
 * it is dead.
 *
 * --revoke is idempotent: a key the API already refuses (revoked, expired,
 * unknown: 401) counts as done. A key whose revocation did not happen for
 * another reason (network, an API without the endpoint) is kept, and the
 * command exits 1 so it can be retried.
 */

type KeySource = "env:CREEK_TOKEN" | "config" | "env:CREEK_TOKEN+config";

interface HeldKey {
  source: KeySource;
  token: string;
}

/** Per-key result of --revoke, as reported in `keys`. */
export interface KeyRevocation {
  source: KeySource;
  /** keyHint() plus "…": the non-secret prefix and at most 4 secret characters. */
  keyPrefix: string;
  revoked: boolean;
  /** Why it was not revoked now: already_invalid, server_unsupported, revoke_failed. */
  reason?: string;
  keyId?: string;
  message?: string;
  status?: number;
}

export function keyPrefix(token: string): string {
  return `${keyHint(token)}…`;
}

/** Every distinct non-empty key the CLI holds, CREEK_TOKEN's first. */
function heldKeys(): HeldKey[] {
  const env = process.env.CREEK_TOKEN;
  const saved = readCliConfig().token;
  const keys: HeldKey[] = [];
  if (env && saved && env === saved) return [{ source: "env:CREEK_TOKEN+config", token: env }];
  if (env) keys.push({ source: "env:CREEK_TOKEN", token: env });
  if (saved) keys.push({ source: "config", token: saved });
  return keys;
}

const SOURCE_LABEL: Record<KeySource, string> = {
  "env:CREEK_TOKEN": "CREEK_TOKEN key",
  config: "saved key",
  "env:CREEK_TOKEN+config": "key (CREEK_TOKEN and saved)",
};

async function revokeKey(key: HeldKey): Promise<KeyRevocation> {
  const result = await revokeSelf(new CreekClient(getApiUrl(), key.token));
  const base = { source: key.source, keyPrefix: keyPrefix(key.token) };
  if (!result.ok) {
    return {
      ...base,
      revoked: false,
      reason: result.error,
      message: result.message,
      ...(result.status ? { status: result.status } : {}),
    };
  }
  return result.revoked
    ? { ...base, revoked: true, keyId: result.keyId }
    : { ...base, revoked: false, reason: result.reason, message: result.message };
}

/** Revoked now, or already refused by the API: either way, dead. */
const isDead = (r: KeyRevocation) => r.revoked || r.reason === "already_invalid";

function humanLine(r: KeyRevocation): string {
  const what = `${SOURCE_LABEL[r.source]} ${r.keyPrefix}`;
  if (r.revoked) return `Revoked the ${what}${r.keyId ? ` (id ${r.keyId})` : ""}.`;
  if (r.reason === "already_invalid") return `The ${what} was already invalid.`;
  return `Could not revoke the ${what}: ${r.message ?? r.reason}`;
}

export const logoutCommand = defineCommand({
  meta: {
    name: "logout",
    description: "Forget the saved API key (--revoke also revokes the keys on the server)",
    // --revoke revokes keys on the server.
    destructive: true,
  },
  args: {
    revoke: {
      type: "boolean",
      description:
        "Revoke every API key the CLI holds (CREEK_TOKEN and saved) before forgetting it",
      default: false,
    },
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const info = getTokenInfo();
    const envKeySet = Boolean(process.env.CREEK_TOKEN);

    if (args.revoke) return revokeAndLogout(jsonMode, info.source, envKeySet);

    // Once forgotten, the saved key can no longer be revoked from the CLI:
    // only the dashboard can. CREEK_TOKEN's key stays reachable by --revoke.
    const savedToken = readCliConfig().token || undefined;
    const configCleared = clearCliToken();
    const dashboardUrl = `${getDashboardUrl()}/api-keys`;
    const warning = envKeySet
      ? "CREEK_TOKEN is still set in this environment: commands keep using it. Unset it to log out completely."
      : undefined;

    const notes: string[] = [];
    if (savedToken) {
      notes.push(
        `The saved key ${keyPrefix(savedToken)} is still valid on the server. It is no longer stored here, so revoke it in the dashboard: ${dashboardUrl}`,
      );
    }
    if (envKeySet) {
      notes.push(
        "The key in CREEK_TOKEN is still valid on the server; `creek logout --revoke` revokes it.",
      );
    }

    const breadcrumbs: Breadcrumb[] = [];
    if (envKeySet) {
      breadcrumbs.push(
        { command: "unset CREEK_TOKEN", description: "Stop using CREEK_TOKEN" },
        {
          command: "creek logout --revoke --json",
          description: "Revoke the key in CREEK_TOKEN on the server",
        },
      );
    }
    breadcrumbs.push({ command: "creek login --token <KEY> --json", description: "Log in again" });

    if (jsonMode) {
      jsonOutput(
        {
          ok: true,
          loggedOut: true,
          configCleared,
          tokenSource: info.source,
          revoked: false,
          reason: "not_requested",
          ...(notes.length > 0 ? { keyStillValid: true, message: notes.join(" ") } : {}),
          ...(savedToken ? { keyPrefix: keyPrefix(savedToken), dashboardUrl } : {}),
          ...(warning ? { warning } : {}),
        },
        0,
        breadcrumbs,
      );
    }

    consola.success(
      configCleared ? "Logged out: removed the saved API key." : "No saved API key to remove.",
    );
    for (const note of notes) consola.info(note);
    if (warning) consola.warn(warning);
  },
});

async function revokeAndLogout(
  jsonMode: boolean,
  tokenSource: string | null,
  envKeySet: boolean,
): Promise<void> {
  const held = heldKeys();
  if (held.length === 0) {
    const configCleared = clearCliToken(); // an empty token entry, if any
    if (jsonMode)
      jsonOutput(
        {
          ok: true,
          loggedOut: true,
          configCleared,
          tokenSource,
          revoked: false,
          reason: "no_key",
          message: "No API key to revoke.",
          keys: [],
        },
        0,
        [{ command: "creek login --token <KEY> --json", description: "Log in" }],
      );
    consola.info("No API key to revoke.");
    return;
  }

  // Sequential: each request carries a different key; nothing to gain from racing.
  const keys: KeyRevocation[] = [];
  for (const key of held) keys.push(await revokeKey(key));

  // The saved key goes only once it is dead; a live one stays for a retry.
  const saved = keys.find((r) => r.source !== "env:CREEK_TOKEN");
  const configCleared = saved !== undefined && isDead(saved) ? clearCliToken() : false;
  const failed = keys.filter((r) => !isDead(r));
  const envResult = keys.find((r) => r.source !== "config");
  const warning =
    envKeySet && envResult && isDead(envResult)
      ? "CREEK_TOKEN is still set in this environment and holds a revoked key; every command will fail with 401 until you unset it."
      : undefined;

  for (const r of keys) {
    if (isDead(r)) consola.success(humanLine(r));
    else consola.error(humanLine(r));
  }

  if (failed.length > 0) {
    const kept = failed.map((r) => `the ${SOURCE_LABEL[r.source]} ${r.keyPrefix}`).join(" and ");
    const dashboardUrl = `${getDashboardUrl()}/api-keys`;
    const message = `Could not revoke ${kept}; ${failed.length > 1 ? "they are" : "it is"} still valid${saved && !isDead(saved) ? " and the saved key was kept" : ""}. Retry, or revoke in the dashboard: ${dashboardUrl}`;
    if (jsonMode)
      jsonOutput(
        {
          ok: false,
          error: failed[0].reason,
          message,
          loggedOut: configCleared,
          configCleared,
          tokenSource,
          revoked: keys.some((r) => r.revoked),
          keyStillValid: true,
          keys,
          dashboardUrl,
          ...(warning ? { warning } : {}),
        },
        1,
        [{ command: "creek logout --revoke --json", description: "Retry" }],
      );
    consola.error(message);
    if (warning) consola.warn(warning);
    process.exit(1);
  }

  const breadcrumbs: Breadcrumb[] = [];
  if (envKeySet)
    breadcrumbs.push({ command: "unset CREEK_TOKEN", description: "Stop sending the revoked key" });
  breadcrumbs.push({ command: "creek login --token <KEY> --json", description: "Log in again" });

  if (jsonMode) {
    jsonOutput(
      {
        ok: true,
        loggedOut: true,
        configCleared,
        tokenSource,
        revoked: keys.some((r) => r.revoked),
        keys,
        ...(warning ? { warning } : {}),
      },
      0,
      breadcrumbs,
    );
  }
  consola.success(
    configCleared ? "Logged out: removed the saved API key." : "No saved API key to remove.",
  );
  if (warning) consola.warn(warning);
}
