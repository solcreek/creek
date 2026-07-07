import { defineCommand } from "citty";
import consola from "consola";
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join, basename } from "node:path";
import { stringify } from "smol-toml";
import { detectFramework, runDoctor, type Finding } from "@solcreek/sdk";
import { buildDoctorContext } from "../utils/doctor-context.js";
import { globalArgs, resolveJsonMode, jsonOutput, shouldAutoConfirm } from "../utils/output.js";
import {
  readHosts,
  writeHosts,
  upsertHost,
  HOSTS_SCHEMA_VERSION,
  type HostEntry,
} from "../utils/hosts.js";
import { fetchHostkey, parsePastedFingerprint, HostkeyResponseError } from "../utils/hostkey.js";
import { ensureGitignoreEntries } from "../utils/gitignore.js";

export const initCommand = defineCommand({
  meta: {
    name: "init",
    description:
      "Initialize a new Creek project — writes creek.toml (project name, build command/output, detected framework) and, if you add a database (interactive prompt or --db), a worker/index.ts example. Or register a self-host creekd via --adopt / --hostkey-fingerprint.",
  },
  args: {
    name: {
      type: "positional",
      description: "Project name (project init) OR host short-name (self-host init)",
      required: false,
    },
    db: {
      type: "boolean",
      description:
        "Add a database without prompting — writes [resources] database = true and scaffolds worker/index.ts. Required to get the database path in non-interactive runs (the prompt is skipped there).",
      default: false,
    },
    adopt: {
      type: "string",
      description:
        "TOFU-pin a creekd host at <addr> (Path B). Fetches GET /v1/hostkey, prompts to verify, writes ~/.creek/hosts.json.",
      required: false,
    },
    "hostkey-fingerprint": {
      type: "string",
      description:
        'Out-of-band fingerprint paste (Path C). "sha256:<hex>" — pasted from provider console or paper bundle. Requires --adopt for the addr.',
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

    const defaultName = basename(cwd)
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-");
    const name = args.name ?? defaultName;

    // Ask about database. --db answers without prompting; otherwise the
    // prompt only fires in interactive runs. In non-interactive runs
    // (agents, CI — jsonMode or auto-confirm) the question is skipped,
    // and we say so: silently defaulting to "no database" is how users
    // end up hand-editing creek.toml and missing [build].worker.
    let useDb = args.db === true;
    let dbPromptSkipped = false;
    if (!useDb) {
      if (!jsonMode && !shouldAutoConfirm(args)) {
        useDb = (await consola.prompt("Add a database?", {
          type: "confirm",
        })) as unknown as boolean;
      } else {
        dbPromptSkipped = true;
      }
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

    // init appends Creek + AI-agent entries to .gitignore. Capture what
    // changed so we can disclose it — a silent mutation of the user's
    // .gitignore is surprising, doubly so in agent/CI runs.
    const gitignoreAdded = ensureGitignoreEntries(cwd);

    // The scaffolded worker imports these — they are NOT installed by
    // init (and aren't in the project's package.json yet), so the very
    // next `creek deploy` fails at bundle time with "Could not resolve"
    // unless the user installs them first. Surface this as a real next
    // step in every mode (the human hint used to be the only signal, and
    // it was suppressed in the agent/CI --json path that needs it most).
    const WORKER_SCAFFOLD_DEPS = ["hono", "creek", "d1-schema"];
    let scaffoldedWorker = false;

    // Scaffold worker + d1-schema example when database enabled
    if (useDb) {
      const workerDir = join(cwd, "worker");
      const workerFile = join(workerDir, "index.ts");

      if (!existsSync(workerFile)) {
        mkdirSync(workerDir, { recursive: true });
        scaffoldedWorker = true;
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
        }
      }
    }

    const installCommand = `npm install ${WORKER_SCAFFOLD_DEPS.join(" ")}`;

    // Pre-flight: surface stack-compatibility blockers up front. This is the
    // dogfood report's biggest hidden cost — discovering only at deploy time
    // that Express / better-sqlite3 / Prisma-on-SQLite don't run on Workers,
    // after the whole app exists. Scoped to that "needs a rewrite" family on
    // purpose: the full diagnostic set belongs to `creek doctor` /
    // `creek deploy --dry-run`, and init already breadcrumbs the install step.
    const STACK_COMPAT_CODES = new Set([
      "CK-NODE-HTTP-SERVER",
      "CK-SYNC-SQLITE",
      "CK-PRISMA-SQLITE",
    ]);
    let compatBlockers: Finding[] = [];
    try {
      compatBlockers = runDoctor(buildDoctorContext(cwd)).findings.filter(
        (f) => STACK_COMPAT_CODES.has(f.code) && f.severity !== "info",
      );
    } catch {
      // Doctor is best-effort here — never let a diagnostic hiccup fail init.
    }

    if (jsonMode) {
      jsonOutput(
        {
          ok: true,
          name,
          framework: framework ?? null,
          database: useDb,
          databasePromptSkipped: dbPromptSkipped,
          path: configPath,
          gitignoreAdded,
          ...(scaffoldedWorker ? { workerDependencies: WORKER_SCAFFOLD_DEPS } : {}),
          ...(compatBlockers.length ? { compatibilityWarnings: compatBlockers } : {}),
        },
        0,
        [
          ...(dbPromptSkipped
            ? [
                {
                  command: "creek init --db",
                  description:
                    "Re-run with a database — writes [resources] and [build].worker, scaffolds worker/index.ts",
                },
              ]
            : []),
          // Install MUST come before deploy: the scaffolded worker imports
          // these and `creek deploy` fails to bundle without them.
          ...(scaffoldedWorker
            ? [
                {
                  command: installCommand,
                  description:
                    "Install the scaffolded worker's dependencies — required before deploy",
                },
              ]
            : []),
          ...(compatBlockers.length
            ? [
                {
                  command: "creek doctor",
                  description: "Review stack-compatibility warnings before building further",
                },
              ]
            : []),
          { command: "creek deploy", description: "Deploy the project" },
          { command: "creek dev", description: "Start local development server" },
        ],
      );
    }

    consola.success(`Created creek.toml for "${name}"`);

    if (!jsonMode) {
      if (gitignoreAdded.length > 0) {
        consola.info(
          `Added ${gitignoreAdded.length} entries to .gitignore (Creek + AI agent configs): ${gitignoreAdded.join(", ")}`,
        );
      }
      if (dbPromptSkipped) {
        consola.info(
          "Skipped the database prompt (non-interactive). Re-run with `creek init --db` to add one — it writes [resources] and [build].worker and scaffolds worker/index.ts.",
        );
      }
      if (compatBlockers.length > 0) {
        console.log("");
        consola.warn("Heads up — parts of your stack won't run on Cloudflare Workers:");
        for (const f of compatBlockers) {
          consola.log(`    • ${f.title}`);
        }
        consola.info(
          "    Run `creek doctor` for the fixes (porting these now avoids a rewrite later).",
        );
      }
      console.log("");
      consola.info("  Next steps:");
      if (scaffoldedWorker) {
        consola.info(`    ${installCommand}   Install worker deps (required before deploy)`);
      }
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
 *   Path B: --adopt=<addr> [<name>]
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
      if (jsonMode)
        jsonOutput({ ok: false, error: "hostkey_fetch_failed", message: e.message }, 1, []);
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
    if (jsonMode)
      jsonOutput(
        {
          ok: false,
          error: "hostkey_fingerprint_mismatch",
          message: msg,
          expected: expectFingerprint,
          got: info.fingerprint,
        },
        1,
        [],
      );
    consola.error(msg);
    consola.info(
      "Possible MITM on first-contact wire, or you pasted the wrong fingerprint. Verify against provider console before retrying.",
    );
    process.exit(1);
  }

  // Path B — no paste. Prompt the operator to verify out-of-band
  // before pinning. Auto-confirm bypass only fires in non-TTY
  // (CI / scripts that have already verified externally).
  if (!expectFingerprint && !autoConfirm) {
    consola.info(`Fingerprint from ${addr}:`);
    consola.info(`  ${info.fingerprint}`);
    consola.info("");
    consola.info(
      "Verify this matches the provider console / serial output / paper bundle BEFORE confirming.",
    );
    const ok = (await consola.prompt("Pin this host?", { type: "confirm" })) as unknown as boolean;
    if (!ok) {
      if (jsonMode)
        jsonOutput(
          { ok: false, error: "user_aborted", message: "operator declined to pin fingerprint" },
          1,
          [],
        );
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
    jsonOutput(
      {
        ok: true,
        name,
        addr,
        fingerprint: info.fingerprint,
        path: "~/.creek/hosts.json",
      },
      0,
      [{ command: `creek deploy --host ${name}`, description: "Deploy to this host" }],
    );
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
 * Operator may override via the positional name argument.
 */
function defaultHostName(addr: string): string {
  const noScheme = addr.replace(/^https?:\/\//, "").replace(/[:/].*$/, "");
  const safe = noScheme.replace(/[^a-z0-9]/gi, "-").toLowerCase();
  return `h-${safe}`;
}
