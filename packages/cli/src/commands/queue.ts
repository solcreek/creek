import { defineCommand } from "citty";
import consola from "consola";
import { CreekClient, parseConfig } from "@solcreek/sdk";
import { getToken, getApiUrl } from "../utils/config.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { globalArgs, resolveJsonMode, jsonOutput } from "../utils/output.js";

function getProjectSlug(): string {
  const configPath = join(process.cwd(), "creek.toml");
  if (!existsSync(configPath)) {
    consola.error("No creek.toml found. Run `creek init` first.");
    process.exit(1);
  }
  return parseConfig(readFileSync(configPath, "utf-8")).project.name;
}

function getClient(): CreekClient {
  const token = getToken();
  if (!token) {
    consola.error("Not authenticated. Run `creek login` first.");
    process.exit(1);
  }
  return new CreekClient(getApiUrl(), token);
}

const queueSend = defineCommand({
  meta: { name: "send", description: "Send a message to the project's queue" },
  args: {
    message: {
      type: "positional",
      description: "Message body (string, or use --json for JSON content)",
      required: true,
    },
    parseJson: {
      type: "boolean",
      alias: "j",
      description: "Parse message as JSON",
      default: false,
    },
    project: {
      type: "string",
      description: "Project slug (defaults to current creek.toml)",
    },
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const client = getClient();
    const slug = (args.project as string | undefined) ?? getProjectSlug();

    let payload: unknown = args.message;
    if (args.parseJson) {
      try {
        payload = JSON.parse(args.message);
      } catch (err) {
        if (jsonMode) {
          jsonOutput(
            { ok: false, error: "invalid_json", message: err instanceof Error ? err.message : String(err) },
            1,
            [],
          );
        }
        consola.error(`Invalid JSON: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    }

    try {
      const result = await client.sendQueueMessage(slug, payload);
      if (jsonMode) {
        jsonOutput({ ok: true, project: slug, queueId: result.queueId }, 0, [
          { command: `creek deployments --project ${slug}`, description: "View deployment history" },
        ]);
      }
      consola.success(`Sent message to ${slug} queue`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (jsonMode) {
        jsonOutput({ ok: false, error: "send_failed", message: msg }, 1, [
          { command: `creek status --project ${slug}`, description: "Check project triggers" },
        ]);
      }
      consola.error(`Failed to send: ${msg}`);
      consola.info("Make sure your creek.toml has `queue = true` under [triggers] and the project is deployed.");
      process.exit(1);
    }
  },
});

export const queueCommand = defineCommand({
  meta: {
    name: "queue",
    description: "Send messages to the project's queue",
  },
  subCommands: {
    send: queueSend,
  },
});
