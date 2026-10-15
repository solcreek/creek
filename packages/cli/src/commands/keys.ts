import { defineCommand } from "citty";
import consola from "consola";
import { exitApiMismatch, getDashboardUrl, getTokenInfo } from "../utils/config.js";
import {
  globalArgs,
  resolveJsonMode,
  jsonOutput,
  shouldAutoConfirm,
  type Breadcrumb,
} from "../utils/output.js";
import { requireClient } from "../utils/command-context.js";
import { dryRunArg, emitDryRunPlan, isDryRun } from "../utils/dry-run.js";
import { describeTokenSource, keyLines, lookupKey, revokeSelf } from "../utils/api-key.js";

/**
 * `creek keys` — the API key the CLI is using.
 *
 * The CLI authenticates with an API key (x-api-key) and never holds a
 * dashboard session. The API lets a key read itself (GET /api-keys/self)
 * and revoke itself (DELETE /api-keys/self); minting, listing and revoking
 * other keys need a signed-in session and refuse every API key, so that a
 * leaked key cannot mint more keys or keep itself alive. `keys ls`,
 * `keys create` and `keys revoke <id>` therefore fail locally with
 * `session_required` and point at the dashboard.
 */

const SELF_BREADCRUMB: Breadcrumb = {
  command: "creek keys self --json",
  description: "Show the API key in use (team, scopes, expiry, last use)",
};

function sessionRequired(jsonMode: boolean, action: string): never {
  const url = `${getDashboardUrl()}/api-keys`;
  const message = `${action} needs a signed-in dashboard session; the CLI authenticates with an API key, and the API refuses every API key here so that a key cannot mint, list or revoke other keys. Use the dashboard: ${url}`;
  const breadcrumbs: Breadcrumb[] = [
    SELF_BREADCRUMB,
    { command: "creek keys revoke --self --json", description: "Revoke the API key in use" },
  ];
  if (jsonMode)
    jsonOutput(
      { ok: false, error: "session_required", message, dashboardUrl: url },
      1,
      breadcrumbs,
    );
  consola.error(message);
  process.exit(1);
}

const selfCommand = defineCommand({
  meta: {
    name: "self",
    description: "Show the API key in use: kind, team, scopes, expiry, last use",
    destructive: false,
  },
  args: { ...globalArgs },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const info = getTokenInfo();
    if (info.source === "config" && info.savedKeyApiMismatch)
      exitApiMismatch(jsonMode, info, "send it");
    const client = requireClient(jsonMode);
    const lookup = await lookupKey(client);
    if (!lookup.ok) {
      const breadcrumbs: Breadcrumb[] =
        lookup.error === "unauthorized"
          ? [
              {
                command: "creek login --token <KEY> --json",
                description: "Log in with a valid key",
              },
            ]
          : [{ command: "creek whoami --json", description: "Show the authenticated user" }];
      if (jsonMode)
        jsonOutput(
          {
            ok: false,
            error: lookup.error,
            message: lookup.message,
            tokenSource: info.source,
            ...(lookup.status ? { status: lookup.status } : {}),
          },
          1,
          breadcrumbs,
        );
      consola.error(lookup.message);
      process.exit(1);
    }
    if (jsonMode) {
      jsonOutput({ ok: true, tokenSource: info.source, key: lookup.key }, 0, [
        { command: "creek keys revoke --self --json", description: "Revoke this key" },
      ]);
    }
    consola.log(`  Source: ${describeTokenSource(info)}`);
    for (const line of keyLines(lookup.key)) consola.log(line);
    if (lookup.key.warning) consola.warn(lookup.key.warning);
  },
});

const lsCommand = defineCommand({
  meta: {
    name: "ls",
    description: "List your API keys (needs the dashboard; see `creek keys self`)",
    // Only answers session_required, locally.
    destructive: false,
  },
  args: {
    team: { type: "string", description: "Team id or slug", required: false },
    ...globalArgs,
  },
  run({ args }) {
    sessionRequired(resolveJsonMode(args), "Listing API keys");
  },
});

const createCommand = defineCommand({
  meta: {
    name: "create",
    description: "Create an API key (needs the dashboard)",
    // Only answers session_required, locally.
    destructive: false,
  },
  // Declared so that the natural invocation reaches session_required
  // instead of failing on an unknown flag.
  args: {
    name: { type: "string", description: "Key name", required: false },
    team: { type: "string", description: "Team id or slug", required: false },
    scopes: { type: "string", description: "Scopes or a preset name", required: false },
    "expires-in": { type: "string", description: "Lifetime in seconds", required: false },
    ...globalArgs,
  },
  run({ args }) {
    sessionRequired(resolveJsonMode(args), "Creating an API key");
  },
});

const revokeCommand = defineCommand({
  meta: {
    name: "revoke",
    description: "Revoke the API key in use (--self); other keys are revoked in the dashboard",
    destructive: true,
  },
  args: {
    id: {
      type: "positional",
      description: "Key id (needs the dashboard; use --self for the key in use)",
      required: false,
    },
    self: {
      type: "boolean",
      description: "Revoke the API key this CLI is using",
      default: false,
    },
    ...dryRunArg,
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    // Two targets: never guess which one was meant, and never revoke the
    // key in use when another key was named.
    if (args.self && args.id) {
      const message = `Pass either a key id (${String(args.id)}) or --self, not both. Nothing was revoked.`;
      if (jsonMode)
        jsonOutput({ ok: false, error: "invalid_args", message }, 1, [
          { command: "creek keys revoke --self --json", description: "Revoke the API key in use" },
          SELF_BREADCRUMB,
        ]);
      consola.error(message);
      process.exit(1);
    }
    if (!args.self) {
      if (args.id) sessionRequired(jsonMode, "Revoking another API key");
      const message = "Pass --self to revoke the API key in use.";
      if (jsonMode)
        jsonOutput({ ok: false, error: "missing_target", message }, 1, [
          { command: "creek keys revoke --self --json", description: "Revoke the API key in use" },
          SELF_BREADCRUMB,
        ]);
      consola.error(message);
      process.exit(1);
    }

    const info = getTokenInfo();
    if (info.source === "config" && info.savedKeyApiMismatch)
      exitApiMismatch(jsonMode, info, "revoke it");
    const client = requireClient(jsonMode);

    if (isDryRun(args)) {
      const lookup = await lookupKey(client);
      emitDryRunPlan(jsonMode, {
        command: "creek keys revoke --self",
        wouldExecute: true,
        sideEffects: ["DELETE /api-keys/self: the key stops working for every later request"],
        nextStep: "creek keys revoke --self --yes --json",
        tokenSource: info.source,
        key: lookup.ok ? lookup.key : null,
      });
      return;
    }

    if (!shouldAutoConfirm(args)) {
      const confirmed = await consola.prompt(
        "Revoke the API key this CLI is using? Every command using it will fail afterwards.",
        { type: "confirm", initial: false },
      );
      if (confirmed !== true) {
        consola.info("Cancelled.");
        return;
      }
    }

    const result = await revokeSelf(client);
    if (!result.ok) {
      if (jsonMode)
        jsonOutput(
          {
            ok: false,
            error: result.error,
            message: result.message,
            revoked: false,
            mayHaveApplied: true,
            ...(result.status ? { status: result.status } : {}),
            dashboardUrl: `${getDashboardUrl()}/api-keys`,
          },
          1,
          [
            {
              command: "creek keys revoke --self --json",
              description: "Re-run: answers already_invalid if the key was revoked",
            },
          ],
        );
      consola.error(result.message);
      consola.info("Re-run `creek keys revoke --self` to settle it.");
      process.exit(1);
    }

    const breadcrumbs: Breadcrumb[] = [
      info.source === "env:CREEK_TOKEN"
        ? { command: "unset CREEK_TOKEN", description: "Stop sending the revoked key" }
        : {
            command: "creek logout --json",
            description: "Forget the revoked key saved by `creek login`",
          },
      { command: "creek login --token <KEY> --json", description: "Log in with another key" },
    ];
    if (jsonMode) {
      jsonOutput(
        result.revoked
          ? { ok: true, revoked: true, keyId: result.keyId, tokenSource: info.source }
          : {
              ok: true,
              revoked: false,
              reason: result.reason,
              message: result.message,
              tokenSource: info.source,
            },
        0,
        breadcrumbs,
      );
    }
    if (result.revoked) consola.success(`Revoked API key ${result.keyId}.`);
    else consola.info(result.message);
    consola.info(
      info.source === "env:CREEK_TOKEN"
        ? "Unset CREEK_TOKEN: it still holds the revoked key."
        : "Run `creek logout` to forget the revoked key.",
    );
  },
});

export const keysCommand = defineCommand({
  meta: {
    name: "keys",
    description: "The API key in use: show it (self) or revoke it (revoke --self)",
  },
  subCommands: {
    self: selfCommand,
    ls: lsCommand,
    create: createCommand,
    revoke: revokeCommand,
  },
});
