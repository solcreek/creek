import { defineCommand } from "citty";
import consola from "consola";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { stringify } from "smol-toml";
import { detectFramework } from "@solcreek/sdk";
import { globalArgs, resolveJsonMode, jsonOutput, shouldAutoConfirm } from "../utils/output.js";
import { readHosts, writeHosts, upsertHost, HOSTS_SCHEMA_VERSION, type HostEntry } from "../utils/hosts.js";
import {
  fetchHostkey,
  parsePastedFingerprint,
  HostkeyResponseError,
} from "../utils/hostkey.js";

export const initCommand = defineCommand({
  meta: {
    name: "init",
    description: "Initialize a new Creek project (or register a self-host creekd via --adopt / --hostkey-fingerprint)",
  },
  args: {
    name: {
      type: "string",
      description: "Project name (project init) OR host short-name (self-host init)",
      required: false,
    },
    adopt: {
      type: "string",
      description: "TOFU-pin a creekd host at <addr> (Path B). Fetches GET /v1/hostkey, prompts to verify, writes ~/.creek/hosts.json.",
      required: false,
    },
    "hostkey-fingerprint": {
      type: "string",
      description: "Out-of-band fingerprint paste (Path C). \"sha256:<hex>\" — pasted from provider console or paper bundle. Requires --adopt for the addr.",
      required: false,
    },
    ...globalArgs,
  },
  async run({ args }) {
    const jsonMode = resolveJsonMode(args);

    // Self-host registration path — DESIGN §"TOFU hostkey discovery".
    // Diverges from project-init entirely; mutually exclusive paths.
    if (args.adopt || args["hostkey-fingerprint"]) {
      return await initHostAdopt(
        args.adopt as string | undefined,
        args["hostkey-fingerprint"] as string | undefined,
        args.name as string | undefined,
        jsonMode,
        shouldAutoConfirm(args),
      );
    }

    const cwd = process.cwd();
    const configPath = join(cwd, "creek.toml");

    if (existsSync(configPath)) {
      if (!shouldAutoConfirm(args)) {
        consola.warn("creek.toml already exists");
        const overwrite = await consola.prompt("Overwrite?", { type: "confirm" });
        if (!overwrite) return;
      }
    }

    // Detect framework
    const pkgPath = join(cwd, "package.json");
    let framework: string | undefined;
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const detected = detectFramework(pkg);
      if (detected) {
        framework = detected;
        if (!jsonMode) consola.info(`Detected framework: ${framework}`);
      }
    }

    const defaultName = basename(cwd).toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const name = args.name ?? defaultName;

    // Ask about database
    let useDb = false;
    if (!jsonMode && !shouldAutoConfirm(args)) {
      useDb = await consola.prompt("Add a database?", { type: "confirm" }) as unknown as boolean;
    }

    const config: Record<string, unknown> = {
      project: {
        name,
        ...(framework ? { framework } : {}),
      },
      build: {
        command: "npm run build",
        output: "dist",
        ...(useDb ? { worker: "worker/index.ts" } : {}),
      },
      ...(useDb ? { resources: { database: true } } : {}),
    };

    writeFileSync(configPath, stringify(config));

    // Scaffold worker + d1-schema example when database enabled
    if (useDb) {
      const workerDir = join(cwd, "worker");
      const workerFile = join(workerDir, "index.ts");

      if (!existsSync(workerFile)) {
        mkdirSync(workerDir, { recursive: true });
        writeFileSync(
          workerFile,
          `import { Hono } from "hono";
import { db } from "creek";
import { define } from "d1-schema";

const app = new Hono();

// Define your tables — auto-created on first request
app.use("*", async (c, next) => {
  await define(c.env.DB, {
    users: {
      id: "text primary key",
      email: "text unique not null",
      name: "text not null",
      created_at: "text default (datetime('now'))",
    },
  });
  return next();
});

app.get("/api/users", async (c) => {
  const users = await db.query("SELECT * FROM users");
  return c.json(users);
});

app.post("/api/users", async (c) => {
  const { email, name } = await c.req.json();
  const id = crypto.randomUUID().slice(0, 16);
  await db.mutate("INSERT INTO users (id, email, name) VALUES (?, ?, ?)", id, email, name);
  return c.json({ id, email, name });
});

export default app;
`,
        );

        if (!jsonMode) {
          consola.success("Created worker/index.ts with database example");
          consola.info("  Install dependencies: npm install hono creek d1-schema");
        }
      }
    }

    if (jsonMode) {
      jsonOutput({ ok: true, name, framework: framework ?? null, database: useDb, path: configPath }, 0, [
        { command: "creek deploy", description: "Deploy the project" },
        { command: "creek dev", description: "Start local development server" },
      ]);
    }

    consola.success(`Created creek.toml for "${name}"`);

    if (!jsonMode) {
      console.log("");
      consola.info("  Next steps:");
      consola.info("    creek deploy    Deploy to production");
      consola.info("    creek dev       Start local development");
    }
  },
});

/**
 * Self-host adopt flow per DESIGN §"TOFU hostkey discovery".
 *
 * Two paths:
 *
 *   Path B: --adopt=<addr> [--name <name>]
 *     Fetches GET /v1/hostkey, recomputes the fingerprint from the
 *     returned publicKey, prompts the operator to verify against
 *     the provider console / paper bundle, and writes the pinned
 *     entry to ~/.creek/hosts.json. Operator MUST visually
 *     confirm — MITM on first contact is otherwise undetectable.
 *
 *   Path C: --hostkey-fingerprint=<sha256:...> --adopt=<addr>
 *     The operator has the fingerprint from out-of-band (provider
 *     console, paper bundle, etc.). We still fetch GET /v1/hostkey
 *     to capture the publicKey bytes + verify the daemon
 *     self-reports the same fingerprint, but the trust comes from
 *     the operator's paste, not from the wire.
 *
 * Path A (capstan-provisioned) is deferred — needs capstan
 * integration.
 */
async function initHostAdopt(
  addr: string | undefined,
  pastedFingerprint: string | undefined,
  hostName: string | undefined,
  jsonMode: boolean,
  autoConfirm: boolean,
): Promise<void> {
  if (!addr) {
    const msg = "--hostkey-fingerprint requires --adopt=<addr> for the daemon to talk to";
    if (jsonMode) jsonOutput({ ok: false, error: "missing_addr", message: msg }, 1, []);
    consola.error(msg);
    process.exit(1);
  }

  const name = hostName ?? defaultHostName(addr);

  // Path C — validate the pasted fingerprint shape BEFORE talking
  // to the network. If the paste is malformed there's no point
  // continuing.
  let expectFingerprint: string | undefined;
  if (pastedFingerprint) {
    try {
      expectFingerprint = parsePastedFingerprint(pastedFingerprint);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (jsonMode) jsonOutput({ ok: false, error: "bad_fingerprint_paste", message: msg }, 1, []);
      consola.error(msg);
      process.exit(1);
    }
  }

  // Fetch the daemon's hostkey. validateHostkey() inside
  // fetchHostkey recomputes the fingerprint from the returned
  // publicKey — protects against a daemon that lies about its own
  // fingerprint.
  let info;
  try {
    info = await fetchHostkey(addr);
  } catch (e) {
    if (e instanceof HostkeyResponseError) {
      if (jsonMode) jsonOutput({ ok: false, error: "hostkey_fetch_failed", message: e.message }, 1, []);
      consola.error(e.message);
      process.exit(1);
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (jsonMode) jsonOutput({ ok: false, error: "hostkey_fetch_failed", message: msg }, 1, []);
    consola.error(`failed to fetch hostkey from ${addr}: ${msg}`);
    process.exit(1);
  }

  // Path C — the paste MUST match the wire fingerprint. Mismatch
  // means either the wire is being MITM'd (the dangerous case) or
  // the paste was for a different host (the human-error case).
  // Either way refuse to pin.
  if (expectFingerprint && expectFingerprint !== info.fingerprint) {
    const msg = `fingerprint mismatch: pasted ${expectFingerprint}, daemon at ${addr} returned ${info.fingerprint}`;
    if (jsonMode) jsonOutput({ ok: false, error: "hostkey_fingerprint_mismatch", message: msg, expected: expectFingerprint, got: info.fingerprint }, 1, []);
    consola.error(msg);
    consola.info("Possible MITM on first-contact wire, or you pasted the wrong fingerprint. Verify against provider console before retrying.");
    process.exit(1);
  }

  // Path B — no paste. Prompt the operator to verify out-of-band
  // before pinning. Auto-confirm bypass only fires in non-TTY
  // (CI / scripts that have already verified externally).
  if (!expectFingerprint && !autoConfirm) {
    consola.info(`Fingerprint from ${addr}:`);
    consola.info(`  ${info.fingerprint}`);
    consola.info("");
    consola.info("Verify this matches the provider console / serial output / paper bundle BEFORE confirming.");
    const ok = (await consola.prompt("Pin this host?", { type: "confirm" })) as unknown as boolean;
    if (!ok) {
      if (jsonMode) jsonOutput({ ok: false, error: "user_aborted", message: "operator declined to pin fingerprint" }, 1, []);
      consola.warn("Aborted — host not pinned.");
      process.exit(1);
    }
  }

  // Persist. upsertHost replaces by name; the operator can re-run
  // with the same --adopt to refresh lastSeen.
  const entry: HostEntry = {
    name,
    addr,
    creekdPubkey: info.publicKey,
    fingerprint: info.fingerprint,
    lastSeen: new Date().toISOString(),
  };
  const file = readHosts();
  const next = upsertHost(file, entry);
  writeHosts(next);

  if (jsonMode) {
    jsonOutput({
      ok: true,
      name,
      addr,
      fingerprint: info.fingerprint,
      path: "~/.creek/hosts.json",
    }, 0, [
      { command: `creek deploy --host ${name}`, description: "Deploy to this host" },
    ]);
  }
  consola.success(`Pinned ${name} → ${addr}`);
  consola.info(`  fingerprint: ${info.fingerprint}`);
  console.log("");
  consola.info("  Next steps:");
  consola.info(`    creek deploy --host ${name}    Deploy to this host`);
  void HOSTS_SCHEMA_VERSION; // re-exported for tests; silence "imported but unused" guards in some setups
}

/**
 * Derive a short host name from the adopt address. e.g.
 *   --adopt=5.75.231.44:9080 → "h-5-75-231-44"
 *   --adopt=my.host.dev      → "h-my-host-dev"
 * Operator may override via --name.
 */
function defaultHostName(addr: string): string {
  const noScheme = addr.replace(/^https?:\/\//, "").replace(/[:/].*$/, "");
  const safe = noScheme.replace(/[^a-z0-9]/gi, "-").toLowerCase();
  return `h-${safe}`;
}
