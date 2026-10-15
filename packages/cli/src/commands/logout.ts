import { defineCommand } from "citty";
import consola from "consola";
import { CreekClient } from "@solcreek/sdk";
import { clearCliToken, getApiUrl, getDashboardUrl, getTokenInfo } from "../utils/config.js";
import { globalArgs, resolveJsonMode, jsonOutput, type Breadcrumb } from "../utils/output.js";
import { revokeSelf } from "../utils/api-key.js";

/**
 * `creek logout [--revoke]`.
 *
 * Without --revoke it only forgets the key saved by `creek login`; the key
 * itself stays valid on the server. With --revoke it first revokes the key
 * in use (DELETE /api-keys/self — the same key `creek whoami` shows, so
 * CREEK_TOKEN's when that is set), then forgets the saved key.
 *
 * --revoke is idempotent: a key the API already refuses (revoked, expired,
 * unknown: 401) counts as done and the local key is still removed. A
 * revocation that did not happen for another reason (network, an API
 * without the endpoint) keeps the saved key, so the command can be retried.
 */
export const logoutCommand = defineCommand({
  meta: {
    name: "logout",
    description: "Forget the saved API key (--revoke also revokes it on the server)",
  },
  args: {
    revoke: {
      type: "boolean",
      description: "Revoke the API key in use on the server before forgetting it",
      default: false,
    },
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const info = getTokenInfo();
    const fromEnv = info.source === "env:CREEK_TOKEN";

    let revocation: Record<string, unknown>;
    if (!args.revoke) {
      revocation = {
        revoked: false,
        reason: "not_requested",
        ...(info.token
          ? {
              keyStillValid: true,
              message:
                "The API key is still valid on the server. Run `creek logout --revoke` to revoke it too, or revoke it in the dashboard.",
            }
          : {}),
      };
    } else if (!info.token) {
      revocation = { revoked: false, reason: "no_key", message: "No API key to revoke." };
    } else {
      const result = await revokeSelf(new CreekClient(getApiUrl(), info.token));
      if (!result.ok) {
        // Not revoked, and not known to be dead: keep the saved key so the
        // user can retry, and say the key is still live.
        const message = `${result.message} Nothing was removed locally; the API key is still valid.`;
        if (jsonMode)
          jsonOutput(
            {
              ok: false,
              error: result.error,
              message,
              revoked: false,
              keyStillValid: true,
              configCleared: false,
              tokenSource: info.source,
              ...(result.status ? { status: result.status } : {}),
            },
            1,
            [
              { command: "creek logout --revoke --json", description: "Retry" },
              {
                command: `open ${getDashboardUrl()}/api-keys`,
                description: "Revoke the key in the dashboard",
              },
            ],
          );
        consola.error(message);
        process.exit(1);
      }
      revocation = result.revoked
        ? { revoked: true, keyId: result.keyId }
        : { revoked: false, reason: result.reason, message: result.message };
    }

    const configCleared = clearCliToken();
    const warning = fromEnv
      ? args.revoke && revocation.revoked
        ? "CREEK_TOKEN is still set in this environment and holds the revoked key; every command will fail with 401 until you unset it."
        : "CREEK_TOKEN is still set in this environment: commands keep using it. Unset it to log out completely."
      : undefined;

    const breadcrumbs: Breadcrumb[] = [];
    if (fromEnv)
      breadcrumbs.push({ command: "unset CREEK_TOKEN", description: "Stop using CREEK_TOKEN" });
    if (!args.revoke && info.token) {
      breadcrumbs.push(
        {
          command: "creek logout --revoke --json",
          description: fromEnv
            ? "Revoke the key in CREEK_TOKEN on the server"
            : "Next time, revoke the key on the server as you log out",
        },
        {
          command: `open ${getDashboardUrl()}/api-keys`,
          description: "Revoke keys in the dashboard",
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
          ...revocation,
          // CREEK_TOKEN's key was the one in use; the different key saved
          // by `creek login` was only forgotten, never revoked.
          ...(info.shadowsConfigToken && configCleared ? { savedKeyStillValid: true } : {}),
          ...(warning ? { warning } : {}),
        },
        0,
        breadcrumbs,
      );
    }

    if (revocation.revoked) consola.success(`Revoked API key ${String(revocation.keyId)}.`);
    else if (args.revoke) consola.info(String(revocation.message));
    consola.success(
      configCleared ? "Logged out: removed the saved API key." : "No saved API key to remove.",
    );
    if (!args.revoke && info.token) {
      consola.info("The key is still valid on the server; `creek logout --revoke` revokes it too.");
    }
    if (warning) consola.warn(warning);
  },
});
