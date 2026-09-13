import { defineCommand } from "citty";
import consola from "consola";
import { globalArgs, resolveJsonMode, jsonOutput, type Breadcrumb } from "../utils/output.js";
import { isHttpUrl, verifyUrl } from "../utils/verify-url.js";

/**
 * `creek verify <url>` — confirm a preview/production URL is actually live.
 *
 * Sandbox deploy JSON already attaches a `proof` field from the same
 * helper; this command exists so an agent can re-check, assert a
 * substring, or verify a URL it did not just deploy.
 */
export const verifyCommand = defineCommand({
  meta: {
    name: "verify",
    description:
      "GET a preview or production URL and report whether it is live. Pair with --json after `creek deploy --sandbox`. Optional --contains asserts a substring is present (sandbox banner HTML is ignored — assert your markup, not the whole document).",
  },
  args: {
    url: {
      type: "positional",
      description: "http(s) URL to fetch (the preview URL from `creek deploy --sandbox`)",
      required: true,
    },
    contains: {
      type: "string",
      description:
        "Substring that must appear in the response body. Repeat the flag is not supported; pass one needle. Do not assert the whole document — sandbox previews inject a banner script.",
      required: false,
    },
    "timeout-ms": {
      type: "string",
      description: "Fetch timeout in milliseconds (default 10000)",
      required: false,
    },
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);
    const url = String(args.url);

    if (!isHttpUrl(url)) {
      const message = `Not an http(s) URL: ${url}`;
      const crumbs: Breadcrumb[] = [
        {
          command: "creek deploy --sandbox --json",
          description: "Deploy a preview, then verify the returned url",
        },
      ];
      if (jsonMode) return jsonOutput({ ok: false, error: "invalid_url", message, url }, 1, crumbs);
      consola.error(message);
      process.exit(1);
    }

    const timeoutRaw = args["timeout-ms"] as string | undefined;
    const timeoutMs = timeoutRaw ? Number(timeoutRaw) : undefined;
    if (timeoutRaw !== undefined && (!Number.isFinite(timeoutMs) || (timeoutMs as number) <= 0)) {
      const message = `--timeout-ms must be a positive number, got ${timeoutRaw}`;
      if (jsonMode) return jsonOutput({ ok: false, error: "invalid_timeout", message }, 1);
      consola.error(message);
      process.exit(1);
    }

    const contains =
      typeof args.contains === "string" && args.contains.length > 0 ? [args.contains] : [];
    const result = await verifyUrl(url, { contains, timeoutMs });

    const crumbs: Breadcrumb[] = result.sandboxId
      ? [
          { command: `creek status ${result.sandboxId}`, description: "Check sandbox status" },
          {
            command: `creek claim ${result.sandboxId}`,
            description: "Claim as a permanent project",
          },
        ]
      : [{ command: "creek deploy --sandbox --json", description: "Deploy a preview" }];

    if (jsonMode) return jsonOutput({ ...result }, result.ok ? 0 : 1, crumbs);

    if (result.ok) {
      consola.success(`  Live → ${result.url}  HTTP ${result.status}  ${result.ttfbMs}ms`);
      if (result.title) consola.info(`  Title: ${result.title}`);
      for (const c of result.contains) {
        consola.info(`  Contains ${JSON.stringify(c.needle)}: yes`);
      }
      return;
    }

    consola.error(result.error ?? `Verify failed (HTTP ${result.status})`);
    if (result.status != null) consola.info(`  HTTP ${result.status} in ${result.ttfbMs}ms`);
    for (const c of result.contains.filter((x) => !x.found)) {
      consola.info(`  Missing: ${JSON.stringify(c.needle)}`);
    }
    process.exit(1);
  },
});
