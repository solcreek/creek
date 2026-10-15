import { defineCommand } from "citty";
import consola from "consola";
import { CreekClient } from "@solcreek/sdk";
import {
  clearCliToken,
  exitApiMismatch,
  getApiUrl,
  getDashboardUrl,
  getTokenInfo,
} from "../utils/config.js";
import { globalArgs, resolveJsonMode, jsonOutput, type Breadcrumb } from "../utils/output.js";
import { keyHint, revokeSelf } from "../utils/api-key.js";

/**
 * `creek logout [--revoke]`.
 *
 * Without --revoke it only forgets the key saved by `creek login`; the key
 * itself stays valid on the server.
 *
 * With --revoke it revokes exactly one key: the active one, the key
 * `creek whoami` would use. The rules:
 *
 * - CREEK_TOKEN set (even empty) and a different saved key: which one is
 *   meant is ambiguous, so nothing is sent (ambiguous_credentials) and the
 *   user picks: unset CREEK_TOKEN to handle the saved key, or revoke the
 *   CREEK_TOKEN key with `creek keys revoke --self`.
 * - A saved key is revoked or cleared only through the API it was saved
 *   for (api_mismatch otherwise).
 * - Only a 2xx (revoked) or a 401 (already invalid) is a known outcome;
 *   anything else keeps the key and asks for a re-run (mayHaveApplied).
 * - The saved key is cleared by compare-and-clear: only if the config still
 *   holds the key that was revoked. A `creek login` that ran meanwhile is
 *   kept (configCleared: false, configReason: changed_during_logout).
 */

/** The key's non-secret prefix and at most 4 characters, then "…". */
export function keyPrefix(token: string): string {
  return `${keyHint(token)}…`;
}

export const logoutCommand = defineCommand({
  meta: {
    name: "logout",
    description: "Forget the saved API key (--revoke also revokes the active key on the server)",
    // --revoke revokes a key on the server.
    destructive: true,
  },
  args: {
    revoke: {
      type: "boolean",
      description: "Revoke the active API key (the one `creek whoami` uses) before forgetting it",
      default: false,
    },
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    if (args.revoke) return revokeAndLogout(jsonMode);
    return plainLogout(jsonMode);
  },
});

function plainLogout(jsonMode: boolean): void {
  const info = getTokenInfo();
  const envKeySet = Boolean(process.env.CREEK_TOKEN);
  const savedToken = info.savedToken;
  if (savedToken && info.savedKeyApiMismatch) exitApiMismatch(jsonMode, info, "forget it");

  // Once forgotten, the saved key can no longer be revoked from the CLI:
  // only the dashboard can. CREEK_TOKEN's key stays reachable by --revoke.
  const configCleared = savedToken ? clearCliToken(savedToken) : false;
  const dashboardUrl = `${getDashboardUrl()}/api-keys`;
  const warning =
    info.source === "env:CREEK_TOKEN"
      ? "CREEK_TOKEN is still set in this environment: commands keep using it. Unset it to log out completely."
      : undefined;

  const notes: string[] = [];
  if (savedToken && configCleared) {
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
  if (info.source === "env:CREEK_TOKEN")
    breadcrumbs.push({ command: "unset CREEK_TOKEN", description: "Stop using CREEK_TOKEN" });
  // --revoke then targets the CREEK_TOKEN key, unless another saved key
  // remains (it would answer ambiguous_credentials).
  if (envKeySet && (!savedToken || configCleared || savedToken === process.env.CREEK_TOKEN)) {
    breadcrumbs.push({
      command: "creek logout --revoke --json",
      description: "Revoke the key in CREEK_TOKEN on the server",
    });
  }
  breadcrumbs.push({ command: "creek login --token <KEY> --json", description: "Log in again" });

  if (jsonMode) {
    jsonOutput(
      {
        ok: true,
        loggedOut: true,
        configCleared,
        ...(savedToken && !configCleared ? { configReason: "changed_during_logout" } : {}),
        tokenSource: info.source,
        revoked: false,
        reason: "not_requested",
        ...(notes.length > 0 ? { keyStillValid: true, message: notes.join(" ") } : {}),
        ...(savedToken && configCleared ? { keyPrefix: keyPrefix(savedToken), dashboardUrl } : {}),
        ...(warning ? { warning } : {}),
      },
      0,
      breadcrumbs,
    );
  }

  consola.success(
    configCleared ? "Logged out: removed the saved API key." : "No saved API key removed.",
  );
  for (const note of notes) consola.info(note);
  if (warning) consola.warn(warning);
}

async function revokeAndLogout(jsonMode: boolean): Promise<void> {
  const info = getTokenInfo();
  const env = process.env.CREEK_TOKEN;
  const saved = info.savedToken;

  // Two different keys could be meant: refuse before any request.
  if (env !== undefined && saved && saved !== env) {
    const message = `${
      env
        ? `CREEK_TOKEN holds one API key (${keyPrefix(env)}) and \`creek login\` saved a different one (${keyPrefix(saved)})`
        : `CREEK_TOKEN is set but empty, and \`creek login\` saved a key (${keyPrefix(saved)})`
    }. \`logout --revoke\` revokes one key and will not guess which. Nothing was sent or changed.`;
    const breadcrumbs: Breadcrumb[] = [
      {
        command: "unset CREEK_TOKEN && creek logout --revoke --json",
        description: "Revoke the saved key and forget it",
      },
    ];
    if (env) {
      breadcrumbs.push({
        command: "creek keys revoke --self --json",
        description: "Revoke the key in CREEK_TOKEN (the saved key is left alone)",
      });
    }
    if (jsonMode)
      jsonOutput(
        {
          ok: false,
          error: "ambiguous_credentials",
          message,
          tokenSource: info.source,
          ...(env ? { envKeyPrefix: keyPrefix(env) } : {}),
          savedKeyPrefix: keyPrefix(saved),
        },
        1,
        breadcrumbs,
      );
    consola.error(message);
    for (const b of breadcrumbs) consola.info(`  ${b.command}  — ${b.description}`);
    process.exit(1);
  }

  // The one active key: CREEK_TOKEN's when set, else the saved one.
  const token = env !== undefined ? env : saved;
  if (!token) {
    if (jsonMode)
      jsonOutput(
        {
          ok: true,
          loggedOut: true,
          configCleared: false,
          tokenSource: info.source,
          revoked: false,
          reason: "no_key",
          message: "No API key to revoke.",
        },
        0,
        [{ command: "creek login --token <KEY> --json", description: "Log in" }],
      );
    consola.info("No API key to revoke.");
    return;
  }

  // The saved key (alone, or the same key as CREEK_TOKEN) is only ever
  // revoked and cleared through the API it was saved for.
  const isSaved = saved === token;
  if (isSaved && info.savedKeyApiMismatch) exitApiMismatch(jsonMode, info, "revoke or forget it");

  const source =
    env !== undefined ? (isSaved ? "env:CREEK_TOKEN+config" : "env:CREEK_TOKEN") : "config";
  const prefix = keyPrefix(token);
  const result = await revokeSelf(new CreekClient(getApiUrl(), token));

  if (!result.ok) {
    // Not a known outcome: the key may or may not be revoked. Keep it.
    const message = `The revocation of the ${describe(source)} ${prefix} could not be confirmed: it may or may not have been revoked (${result.message}). Nothing was removed locally. Re-run \`creek logout --revoke\`: a revoked key then answers already_invalid. Or revoke it in the dashboard: ${getDashboardUrl()}/api-keys`;
    if (jsonMode)
      jsonOutput(
        {
          ok: false,
          error: result.error,
          message,
          tokenSource: info.source,
          source,
          keyPrefix: prefix,
          revoked: false,
          mayHaveApplied: true,
          configCleared: false,
          ...(result.status ? { status: result.status } : {}),
          dashboardUrl: `${getDashboardUrl()}/api-keys`,
        },
        1,
        [
          {
            command: "creek logout --revoke --json",
            description: "Re-run: answers already_invalid if the key was revoked",
          },
        ],
      );
    consola.error(message);
    process.exit(1);
  }

  // Known outcome: the key is dead. Clear the saved copy only if the
  // config still holds this exact key.
  const configCleared = isSaved ? clearCliToken(token) : false;
  const configChanged = isSaved && !configCleared;
  const warning =
    env !== undefined
      ? "CREEK_TOKEN is still set in this environment and holds the revoked key; every command will fail with 401 until you unset it."
      : undefined;

  const breadcrumbs: Breadcrumb[] = [];
  if (env !== undefined)
    breadcrumbs.push({ command: "unset CREEK_TOKEN", description: "Stop sending the revoked key" });
  breadcrumbs.push({ command: "creek login --token <KEY> --json", description: "Log in again" });

  if (jsonMode) {
    jsonOutput(
      {
        ok: true,
        loggedOut: true,
        tokenSource: info.source,
        source,
        keyPrefix: prefix,
        revoked: result.revoked,
        ...(result.revoked
          ? { keyId: result.keyId }
          : { reason: result.reason, message: result.message }),
        configCleared,
        ...(configChanged ? { configReason: "changed_during_logout" } : {}),
        ...(warning ? { warning } : {}),
      },
      0,
      breadcrumbs,
    );
  }

  consola.success(
    result.revoked
      ? `Revoked the ${describe(source)} ${prefix} (id ${result.keyId}).`
      : `The ${describe(source)} ${prefix} was already invalid.`,
  );
  if (configCleared) consola.success("Logged out: removed the saved API key.");
  if (configChanged)
    consola.warn(
      "The saved key changed during logout (a new `creek login`?); it was left in place.",
    );
  if (warning) consola.warn(warning);
}

function describe(source: string): string {
  return source === "config"
    ? "saved key"
    : source === "env:CREEK_TOKEN"
      ? "CREEK_TOKEN key"
      : "key (CREEK_TOKEN and saved)";
}
