import { defineCommand } from "citty";
import consola from "consola";
import { CreekClient } from "@solcreek/sdk";
import { getTokenInfo, getApiUrl } from "../utils/config.js";
import { globalArgs, resolveJsonMode, jsonOutput, AUTH_BREADCRUMBS } from "../utils/output.js";
import {
  describeTokenSource,
  envOverrideWarning,
  exitApiMismatch,
  keyLines,
  lookupKey,
} from "../utils/api-key.js";

export const whoamiCommand = defineCommand({
  meta: {
    name: "whoami",
    description: "Show the authenticated user, the API key in use and where it comes from",
  },
  args: { ...globalArgs },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const info = getTokenInfo();
    const token = info.token;
    const warning = envOverrideWarning(info);

    if (!token) {
      const message = "Not authenticated. Run `creek login` first.";
      if (jsonMode)
        jsonOutput(
          {
            ok: false,
            authenticated: false,
            error: "not_authenticated",
            message,
            tokenSource: info.source,
            ...(warning ? { warning } : {}),
          },
          1,
          AUTH_BREADCRUMBS,
        );
      if (warning) consola.warn(warning);
      consola.error(message);
      process.exit(1);
    }

    // The saved key goes only to the API it was saved for.
    if (info.source === "config" && info.savedKeyApiMismatch)
      exitApiMismatch(jsonMode, info, "send it", { authenticated: false });

    const client = new CreekClient(getApiUrl(), token);
    // Fetched independently: /api-keys/self also answers for a key the
    // session check refuses (403: its owner left the pinned team, or its
    // stored scopes are unreadable), and says why.
    const [session, lookup] = await Promise.all([client.getSession(), lookupKey(client)]);

    if (!session?.user && lookup.ok) {
      // The API knows the key but will not let it act: explain, don't
      // blame a revoked or expired login, and don't call it usable.
      const key = lookup.key;
      const message =
        key.warning ??
        "The API recognises this key but refuses to act with it (access: none). Revoke it and use another key.";
      if (jsonMode)
        jsonOutput(
          {
            ok: false,
            authenticated: false,
            error: "key_unusable",
            message,
            tokenSource: info.source,
            key,
          },
          1,
          [
            { command: "creek keys revoke --self --json", description: "Revoke this unusable key" },
            ...AUTH_BREADCRUMBS,
          ],
        );
      consola.error(message);
      for (const line of keyLines(key)) consola.log(line);
      process.exit(1);
    }

    if (!session?.user) {
      const message =
        info.source === "env:CREEK_TOKEN"
          ? "The API key in CREEK_TOKEN was refused (revoked, expired or invalid). Set a valid key, or unset CREEK_TOKEN to use the key saved by `creek login`."
          : "The saved API key was refused (revoked, expired or invalid). Run `creek login` to re-authenticate.";
      if (jsonMode)
        jsonOutput(
          {
            ok: false,
            authenticated: false,
            error: "session_expired",
            message,
            tokenSource: info.source,
          },
          1,
          AUTH_BREADCRUMBS,
        );
      consola.error(message);
      process.exit(1);
    }

    // Key details are extra: an API without /api-keys/self, or a failed
    // lookup, never fails whoami.
    const key = lookup.ok ? lookup.key : null;
    const warnings = [warning, key?.warning].filter((w): w is string => Boolean(w));

    if (jsonMode) {
      jsonOutput(
        {
          ok: true,
          authenticated: true,
          user: session.user.name,
          email: session.user.email,
          api: getApiUrl(),
          tokenSource: info.source,
          key,
          ...(lookup.ok
            ? {}
            : {
                keyLookup: {
                  error: lookup.error,
                  message: lookup.message,
                  ...(lookup.status ? { status: lookup.status } : {}),
                },
              }),
          ...(warning ? { warning } : {}),
        },
        0,
        [
          { command: "creek projects", description: "List your projects" },
          { command: "creek deploy --sandbox --json", description: "Deploy a 60-minute preview" },
        ],
      );
    }

    consola.log(`  User:   ${session.user.name}`);
    consola.log(`  Email:  ${session.user.email}`);
    consola.log(`  API:    ${getApiUrl()}`);
    consola.log(`  Source: ${describeTokenSource(info)}`);
    if (key) for (const line of keyLines(key)) consola.log(line);
    else if (!lookup.ok) consola.log(`  Key:    details unavailable (${lookup.message})`);
    for (const w of warnings) consola.warn(w);
  },
});
