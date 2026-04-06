import { defineCommand } from "citty";
import consola from "consola";
import { CreekClient } from "@solcreek/sdk";
import { getToken, getApiUrl } from "../utils/config.js";
import { globalArgs, resolveJsonMode, jsonOutput, AUTH_BREADCRUMBS } from "../utils/output.js";

export const whoamiCommand = defineCommand({
  meta: {
    name: "whoami",
    description: "Show the currently authenticated user",
  },
  args: { ...globalArgs },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const token = getToken();

    if (!token) {
      if (jsonMode) jsonOutput({ ok: false, authenticated: false, error: "not_authenticated" }, 1, AUTH_BREADCRUMBS);
      consola.error("Not authenticated. Run `creek login` first.");
      process.exit(1);
    }

    const client = new CreekClient(getApiUrl(), token);
    const session = await client.getSession();

    if (!session?.user) {
      if (jsonMode) jsonOutput({ ok: false, authenticated: false, error: "session_expired" }, 1, AUTH_BREADCRUMBS);
      consola.error("Session expired or invalid. Run `creek login` to re-authenticate.");
      process.exit(1);
    }

    if (jsonMode) {
      jsonOutput({
        ok: true,
        authenticated: true,
        user: session.user.name,
        email: session.user.email,
        api: getApiUrl(),
      }, 0, [
        { command: "creek projects", description: "List your projects" },
        { command: "creek deploy", description: "Deploy current directory" },
      ]);
    }

    consola.log(`  User:  ${session.user.name}`);
    consola.log(`  Email: ${session.user.email}`);
    consola.log(`  API:   ${getApiUrl()}`);
  },
});
