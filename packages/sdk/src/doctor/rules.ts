/**
 * Diagnostic rule set for `creek doctor`.
 *
 * Each rule is a pure function over DoctorContext. Rules should be
 * cheap (no IO) since every `creek doctor` invocation runs all of
 * them. Table-tested in `rules.test.ts` — add a test row before
 * adding a rule.
 *
 * Guiding principle: rules catch the PRE-DEPLOY mistakes that
 * reliably waste user time. If a rule has a >20% false-positive
 * rate or would confuse a first-time user, it doesn't belong here.
 */

import type { DoctorContext, Finding, Rule } from "./types.js";
import { isSSRFramework } from "../types/index.js";
import { isPrebundledWorker } from "../framework/deploy-plan.js";

// ─── Rule: no config at all ──────────────────────────────────────────────

const CK_NO_CONFIG: Rule = (ctx) => {
  if (ctx.resolved) return [];
  return [
    {
      code: "CK-NO-CONFIG",
      severity: "error",
      title: "No project config found",
      detail:
        "creek.toml, wrangler.jsonc/json/toml, package.json, and index.html were all absent or unparseable. Creek has nothing to deploy.",
      fix: "Run `creek init` to scaffold a creek.toml, OR run `creek deploy` in a directory that contains one of: creek.toml, wrangler.*, package.json, index.html.",
    },
  ];
};

// ─── Rule: deprecated [resources] keys (d1/kv/r2) ───────────────────────

const CK_RESOURCES_KEYS: Rule = (ctx) => {
  if (!ctx.creekTomlRaw) return [];
  // Scan for CF-native keys at the start of a line under [resources].
  // We don't do a full TOML parse here — the parser strips unknown
  // keys so they'd never reach `resolved`. Look at the raw text.
  const inResources = /\[resources\]([\s\S]*?)(?=\n\[|$)/i.exec(ctx.creekTomlRaw);
  if (!inResources) return [];
  const section = inResources[1];
  const offenders: string[] = [];
  for (const [cf, semantic] of [
    ["d1", "database"],
    ["kv", "cache"],
    ["r2", "storage"],
  ] as const) {
    if (new RegExp(`^\\s*${cf}\\s*=\\s*(true|false)`, "m").test(section)) {
      offenders.push(`${cf} → ${semantic}`);
    }
  }
  if (offenders.length === 0) return [];
  return [
    {
      code: "CK-RESOURCES-KEYS",
      severity: "error",
      title: "[resources] uses CF-native key names (ignored by Creek)",
      detail:
        "Creek's [resources] block uses semantic names (database / cache / storage / ai), not CF service names (d1 / kv / r2). The keys you wrote are silently dropped — nothing gets provisioned, and at runtime env.DATABASE / env.CACHE / env.STORAGE will be undefined.",
      fix:
        "Rename in creek.toml:\n" +
        offenders.map((o) => `  ${o}`).join("\n") +
        "\n\nExample:\n  [resources]\n  database = true   # was d1 = true\n  cache = false     # was kv = false\n  storage = false   # was r2 = false",
      references: ["creek.toml"],
    },
  ];
};

// ─── Rule: worker entry declared but missing ────────────────────────────

const CK_WORKER_MISSING: Rule = (ctx) => {
  const worker = ctx.resolved?.workerEntry;
  if (!worker) return [];
  if (ctx.fileExists(worker)) return [];
  return [
    {
      code: "CK-WORKER-MISSING",
      severity: "error",
      title: `[build].worker points at a file that doesn't exist: ${worker}`,
      detail:
        "The deploy pipeline will fail with `worker entry not found`. Either the file hasn't been built yet, or the path in creek.toml is wrong.",
      fix: `Check that ${worker} exists after your build step runs, or fix the path in creek.toml [build].worker.\n\nCommon shapes:\n  worker = "worker/index.ts"        # TS source (Creek bundles via esbuild)\n  worker = "dist/_worker.mjs"       # pre-bundled by your own build script`,
      references: ["creek.toml"],
    },
  ];
};

// ─── Rule: resources declared but no worker entry ───────────────────────

// Binding types that come from [resources] (or wrangler resource
// arrays). durable_object / analytics_engine imply hand-written
// wrangler config and aren't the "declared a DB, forgot the worker"
// shape this rule targets.
const RESOURCE_BINDING_TYPES = new Set(["d1", "r2", "kv", "ai"]);

const CK_RESOURCES_NO_WORKER: Rule = (ctx) => {
  const resolved = ctx.resolved;
  if (!resolved) return [];
  if (resolved.workerEntry) return [];
  const resourceBindings = resolved.bindings.filter((b) =>
    RESOURCE_BINDING_TYPES.has(b.type),
  );
  if (resourceBindings.length === 0) return [];
  // SSR frameworks produce their own server bundle at deploy time — a
  // null workerEntry is the normal shape there, and the bindings are
  // reachable from the framework's server code. Same for Astro with
  // the CF adapter (not covered by isSSRFramework; detected via dep).
  if (isSSRFramework(resolved.framework)) return [];
  if (ctx.allDeps["@astrojs/cloudflare"]) return [];
  const names = resourceBindings
    .map((b) => `${b.type} (env.${b.name})`)
    .join(", ");
  return [
    {
      code: "CK-RESOURCES-NO-WORKER",
      severity: "warn",
      title: "Resources declared but no worker entry — deploy will be a static SPA",
      detail:
        `Your config declares ${names} but no worker entry. The deploy still provisions and binds the resources, but renderMode will be "spa": there is no server code, so every request — including /api/* — serves static assets, and unknown paths fall back to index.html. If you have API routes, they will silently return your frontend HTML instead of running.`,
      fix:
        'Point creek.toml at your server code:\n  [build]\n  worker = "worker/index.ts"\n\n(wrangler-based projects: set `main` instead.)\n\nNo server code yet? Scaffold it with `creek init --db`. Purely static site? Remove the [resources] block.',
      references: [resolved.source],
    },
  ];
};

// ─── Rule: worker file on disk but not declared ─────────────────────────

// The inverse of CK-WORKER-MISSING: code exists, config doesn't point
// at it. Common when an agent hand-writes worker/ after a non-DB init
// and forgets [build].worker — the deploy then ships a static SPA and
// the worker never runs.
const WORKER_CANDIDATE_PATHS = [
  "worker/index.ts",
  "worker/index.js",
  "src/worker.ts",
  "server/worker.ts",
];

const CK_WORKER_UNDECLARED: Rule = (ctx) => {
  const resolved = ctx.resolved;
  if (!resolved) return [];
  if (resolved.workerEntry) return [];
  // SSR frameworks bundle their own server — a worker-shaped file in
  // src/ or server/ belongs to the framework build, not to
  // [build].worker.
  if (isSSRFramework(resolved.framework)) return [];
  if (ctx.allDeps["@astrojs/cloudflare"]) return [];
  const found = WORKER_CANDIDATE_PATHS.find((p) => ctx.fileExists(p));
  if (!found) return [];
  return [
    {
      code: "CK-WORKER-UNDECLARED",
      severity: "info",
      title: `${found} exists but no worker entry is declared — it will not be deployed`,
      detail:
        `A worker-shaped file exists at ${found}, but the config has no worker entry, so the deploy treats the project as a static SPA and never bundles or runs that file.`,
      fix: `If ${found} is your server code, declare it in creek.toml:\n  [build]\n  worker = "${found}"\n\n(wrangler-based projects: set \`main\` instead.) If the file is unused, delete it to silence this notice.`,
      references: [found],
    },
  ];
};

// ─── Rule: better-sqlite3 — sync API doesn't run on Workers ──────────────

const CK_SYNC_SQLITE: Rule = (ctx) => {
  if (!ctx.allDeps["better-sqlite3"]) return [];
  // If a dual-driver ORM is also installed AND better-sqlite3 is
  // devDep-only, the project is using the 'local sync / prod async'
  // pattern deliberately. Downgrade the finding — it's a feature,
  // not a bug.
  const hasDualDriverOrm =
    !!ctx.allDeps["drizzle-orm"] || !!ctx.allDeps["kysely"];
  const devOnly =
    !!ctx.packageJson?.devDependencies?.["better-sqlite3"] &&
    !ctx.packageJson?.dependencies?.["better-sqlite3"];

  const workerEntry = ctx.resolved?.workerEntry;
  if (hasDualDriverOrm && devOnly) {
    return [
      {
        code: "CK-SYNC-SQLITE",
        severity: "info",
        title: "better-sqlite3 (devDep) + dual-driver ORM — local-sync / prod-async pattern",
        detail:
          "better-sqlite3 is in devDependencies and an ORM with a D1 adapter (Drizzle/Kysely) is also present. This is the recommended dual-driver shape: the same Hono routes run locally against a SQLite file and on Workers against env.DB.",
        fix:
          "No action needed. The dual-driver shape: your dev/Node entry imports from `drizzle-orm/better-sqlite3` (or `kysely`'s SQLite dialect), while your Workers entry" +
          (workerEntry ? ` (${workerEntry})` : "") +
          " imports from `drizzle-orm/d1`. Reference: https://github.com/solcreek/creek/tree/main/examples/vite-react-drizzle",
        references: workerEntry ? [workerEntry, "package.json"] : ["package.json"],
      },
    ];
  }

  const alsoPrisma = !!ctx.allDeps["@prisma/client"] || !!ctx.allDeps["prisma"];
  return [
    {
      code: "CK-SYNC-SQLITE",
      severity: "warn",
      title: "better-sqlite3 in dependencies — synchronous, won't run on Workers",
      detail:
        "better-sqlite3 is a Node native module with a synchronous API (db.prepare(...).get()). Cloudflare Workers runs workerd (no native bindings, no sync DB access). D1 — Creek's default `env.DB` — has an async API; the method signatures differ. A codemod-style rename won't work; every call site needs an `await`." +
        (alsoPrisma
          ? "\n\nPrisma is also in your dependencies (see CK-PRISMA-SQLITE) — these two findings are the same underlying issue (sync/Node SQLite doesn't run on Workers), not separate problems. Settle on one ORM and one migration path."
          : ""),
      fix:
        "Swap to an ORM with a D1 adapter. Drizzle or Kysely are the drop-in paths — their query APIs are async-shaped regardless of backend, so the same code can run against better-sqlite3 locally and D1 in production with just a driver swap at boot.\n\nReference example (zero @solcreek/* deps in the runtime): https://github.com/solcreek/creek/tree/main/examples/vite-react-drizzle",
      references: ["package.json"],
    },
  ];
};

// ─── Rule: Prisma with SQLite datasource ────────────────────────────────

const CK_PRISMA_SQLITE: Rule = (ctx) => {
  if (!ctx.allDeps["@prisma/client"] && !ctx.allDeps["prisma"]) return [];
  const alsoBetterSqlite = !!ctx.allDeps["better-sqlite3"];
  return [
    {
      code: "CK-PRISMA-SQLITE",
      severity: "warn",
      title: "Prisma detected — limited Workers support",
      detail:
        "Prisma on Cloudflare Workers requires Prisma Accelerate (hosted connection pool) or a D1 adapter, not the default engine. If you're using local SQLite, it won't port cleanly; if you're using Postgres, plan for Accelerate + a cold-start budget." +
        (alsoBetterSqlite
          ? "\n\nbetter-sqlite3 is also in your dependencies (see CK-SYNC-SQLITE) — both findings point at the same Workers SQLite migration, not separate problems. Settle on one ORM and one path."
          : ""),
      fix:
        "For new projects, consider Drizzle instead (native D1 + Postgres adapters, no hosted connection pool required). If you need to keep Prisma: use @prisma/adapter-d1 for SQLite, or Prisma Accelerate for Postgres. See https://www.prisma.io/docs/orm/overview/databases/cloudflare-d1",
      references: ["package.json"],
    },
  ];
};

// ─── Rule: Node HTTP-server framework — doesn't run on Workers ──────────
//
// Express/Fastify/Koa/etc. are Node HTTP servers built on node:net + the
// `http` server API. workerd has no listening sockets — a Worker is a
// `fetch(request)` handler, not a server you `.listen()` on. This is the
// stack-mismatch wall the dogfood report hit: it's only discovered at
// deploy/build time, after the app is written. Surfacing it from `creek
// init` / `creek doctor` up front saves a from-scratch rewrite. Fire on
// production `dependencies` only — a dev-only Express (local mock, test
// harness) is fine and shouldn't nag.

const NODE_HTTP_SERVERS: Array<{ pkg: string; name: string }> = [
  { pkg: "express", name: "Express" },
  { pkg: "fastify", name: "Fastify" },
  { pkg: "koa", name: "Koa" },
  { pkg: "@hapi/hapi", name: "hapi" },
  { pkg: "restify", name: "restify" },
];

const CK_NODE_HTTP_SERVER: Rule = (ctx) => {
  const deps = ctx.packageJson?.dependencies ?? {};
  const offenders = NODE_HTTP_SERVERS.filter((s) => deps[s.pkg]);
  if (offenders.length === 0) return [];
  const names = offenders.map((o) => o.name).join(", ");
  const pkgs = offenders.map((o) => o.pkg).join(", ");
  const hasHono = !!ctx.allDeps["hono"];
  return [
    {
      code: "CK-NODE-HTTP-SERVER",
      severity: "warn",
      title: `${names} won't run on Cloudflare Workers`,
      detail:
        `${names} (${pkgs}) ${offenders.length === 1 ? "is a" : "are"} Node HTTP server framework${offenders.length === 1 ? "" : "s"} built on \`node:net\`/\`http.createServer().listen()\`. workerd has no listening sockets — a Worker is a \`fetch(request)\` handler, not a server. \`creek deploy\` will bundle it and fail (or the routes simply never run). This is a build-first-then-rewrite trap, so it's flagged here up front.` +
        (hasHono
          ? "\n\nHono is already installed — porting the routes to it is the path. Hono runs on both Node (@hono/node-server) and Workers from one codebase."
          : ""),
      fix:
        "Port your routes to Hono — its `fetch`-based API runs unchanged on Node (`@hono/node-server`) and Workers, so you keep local dev and gain a Workers-deployable app. Express middleware/route handlers map almost 1:1. If the server is dev-only tooling, move it to devDependencies to silence this.",
      references: ["package.json"],
    },
  ];
};

// ─── Rule: @solcreek/* imports in user runtime code (portability leak) ──

const CK_RUNTIME_LOCKIN: Rule = (ctx) => {
  // Check the single user-facing dep we'd expect to leak:
  // direct `creek` or `@solcreek/runtime` in `dependencies` (NOT
  // devDependencies — CLI usage is fine).
  const runtime = ctx.packageJson?.dependencies ?? {};
  const offenders: string[] = [];
  if (runtime["creek"]) offenders.push("creek");
  if (runtime["@solcreek/runtime"]) offenders.push("@solcreek/runtime");
  if (runtime["@solcreek/sdk"]) offenders.push("@solcreek/sdk");
  if (offenders.length === 0) return [];
  return [
    {
      code: "CK-RUNTIME-LOCKIN",
      severity: "info",
      title: "Runtime dependency on @solcreek/* — reduces portability",
      detail:
        `Your production dependencies include: ${offenders.join(", ")}. These aren't wrong per se — the Creek runtime helpers (db, kv, room) work — but they bind your app's code to Creek. Plain Cloudflare Workers, wrangler deploy, Vercel, etc. can't run this code without the Creek runtime.`,
      fix:
        // NOTE: do NOT advise moving `creek` to devDependencies. When the
        // worker is Creek-bundled (esbuild-bundle strategy), the generated
        // .creek/__worker_entry.js imports `creek` at bundle time, so it
        // MUST stay in dependencies — demoting it breaks the next deploy
        // (esbuild: Could not resolve "creek"). See CK-RUNTIME-DEP-MISSING.
        (offenders.includes("creek")
          ? "`creek` must stay in `dependencies` if you deploy a Creek-bundled worker — the generated wrapper imports it. To reduce lock-in, migrate your handler to platform-native APIs (`env.DB` directly, or an ORM with a standard adapter), and only then drop the dep. See https://github.com/solcreek/creek/tree/main/examples/vite-react-drizzle for the zero-lock-in pattern."
          : "If portability matters (it usually should): use platform-native APIs in your handler — `env.DB` directly, or an ORM with a standard adapter. See https://github.com/solcreek/creek/tree/main/examples/vite-react-drizzle for the zero-lock-in pattern."),
      references: ["package.json"],
    },
  ];
};

// ─── Rule: wrangler.* + creek.toml both present (possibly conflicting) ──

const CK_CONFIG_OVERLAP: Rule = (ctx) => {
  const hasCreek = !!ctx.creekTomlRaw;
  const hasWrangler =
    ctx.fileExists("wrangler.jsonc") ||
    ctx.fileExists("wrangler.json") ||
    ctx.fileExists("wrangler.toml");
  if (!(hasCreek && hasWrangler)) return [];
  return [
    {
      code: "CK-CONFIG-OVERLAP",
      severity: "info",
      title: "Both creek.toml and wrangler.* are present",
      detail:
        "Creek can read either, but having both risks silent drift — compatibility_date, bindings, main — if you update one and forget the other. The deploy pipeline prefers creek.toml when both exist.",
      fix:
        "Pick one as the source of truth:\n  - creek.toml: recommended for projects that target Creek primarily\n  - wrangler.*: recommended if you also deploy to your own CF account via `wrangler deploy`\n\nIf you're keeping both intentionally (platform-portable build), at least diff them and align the overlapping fields.",
      references: ["creek.toml", "wrangler.jsonc"],
    },
  ];
};

// ─── Rule: no build output AND no worker entry ──────────────────────────

const CK_NOTHING_TO_DEPLOY: Rule = (ctx) => {
  if (!ctx.resolved) return []; // CK-NO-CONFIG already fires

  // Next.js: the Workers build output is produced by `creek deploy` itself
  // (the Creek adapter writes to .creek/adapter-output; the legacy path to
  // .open-next), NOT by the user's `next build`. So a missing output before
  // the first deploy is expected, and the generic "run your build" message
  // would be actively wrong — it tells the user to run `next build`, which
  // never creates those directories. Surface a Next.js-specific note instead.
  if (ctx.allDeps["next"]) {
    if (ctx.fileExists(".creek/adapter-output") || ctx.fileExists(".open-next")) {
      return [];
    }
    return [
      {
        code: "CK-NOTHING-TO-DEPLOY",
        severity: "info",
        title: "No Workers build output yet — Creek produces it at deploy time",
        detail:
          "Next.js apps don't ship `.next/` directly. `creek deploy` runs the build through the Creek adapter (@solcreek/adapter-creek, auto-installed on first use) and writes the Workers output to `.creek/adapter-output/`. That directory being absent before your first deploy is expected — a plain `next build` will not create it.",
        fix:
          "Run `creek deploy` — it builds and deploys in one step. You do NOT need to install @opennextjs/cloudflare or any adapter yourself; Creek manages that. Preview first with `creek deploy --dry-run`.",
        references: ["package.json"],
      },
    ];
  }

  const buildOutput = ctx.resolved.buildOutput || "dist";
  const hasBuildOutput = ctx.fileExists(buildOutput);
  const hasWorker =
    ctx.resolved.workerEntry && ctx.fileExists(ctx.resolved.workerEntry);
  if (hasBuildOutput || hasWorker) return [];
  const hasBuildCommand = !!ctx.resolved.buildCommand;
  return [
    {
      code: "CK-NOTHING-TO-DEPLOY",
      severity: "warn",
      title: `No build output ('${buildOutput}') and no worker entry — nothing to deploy yet`,
      detail:
        (hasBuildCommand
          ? `You have a build command (${ctx.resolved.buildCommand}) but no output. Either the build hasn't run, or it writes to a different directory than [build].output says.`
          : "No build command, no build output, no worker entry.") +
        " These are two separate inputs: [build].output is the static frontend, [build].worker is the server code. Running the build only produces the first — if this project has API routes, the worker entry must be declared too.",
      fix: hasBuildCommand
        ? `Static frontend: run your build (\`${ctx.resolved.buildCommand}\`) and confirm it writes to ${buildOutput}/; if your tooling writes elsewhere, update creek.toml [build].output.\n\nServer code / API routes: also declare the entry:\n  [build]\n  worker = "worker/index.ts"`
        : `Static frontend: add a build script to package.json, or put files at ${buildOutput}/.\n\nServer code / API routes: declare the entry:\n  [build]\n  worker = "worker/index.ts"`,
    },
  ];
};

// ─── Rule: auth framework needs a runtime secret set via `creek env set` ──
//
// The deploy-then-500 trap: an auth library (Better Auth, Auth.js) builds
// fine and ships, but at runtime its handler throws because a required
// secret env var isn't set on the deployed project. There is NO build
// error — the worker activates, every page that touches auth (login,
// get-session) returns 500, and the user has no breadcrumb pointing at the
// missing env. Build-time config can't carry these (a secret in the bundle
// would be a leak); they must be set with `creek env set`, which is easy to
// forget after a fresh deploy or an account claim. This rule surfaces the
// requirement before the 500 does.
//
// We can't verify the secret is actually set (it lives in the project's
// remote encrypted env store, not anything on disk), so this is a `warn`
// reminder keyed purely on the dependency — cheap to dismiss when already
// set, and the one thing that turns a silent 500 into an obvious fix.

interface SecretRequirement {
  /** package.json dependency that signals the framework. */
  dep: string;
  /** Human label for the framework. */
  label: string;
  /** Required runtime secret env var names. */
  envVars: string[];
}

const SECRET_REQUIRING_DEPS: SecretRequirement[] = [
  { dep: "better-auth", label: "Better Auth", envVars: ["BETTER_AUTH_SECRET"] },
  { dep: "next-auth", label: "Auth.js (NextAuth)", envVars: ["AUTH_SECRET"] },
  { dep: "@auth/core", label: "Auth.js", envVars: ["AUTH_SECRET"] },
];

const CK_AUTH_SECRET: Rule = (ctx) => {
  const hits = SECRET_REQUIRING_DEPS.filter((r) => ctx.allDeps[r.dep]);
  if (hits.length === 0) return [];
  const label = hits[0].label;
  // Dedupe env vars across matched libs (e.g. next-auth + @auth/core).
  const envVars = [...new Set(hits.flatMap((h) => h.envVars))];
  const setLines = envVars
    .map((v) =>
      v === "BETTER_AUTH_SECRET" || v === "AUTH_SECRET"
        ? `  creek env set ${v} "$(openssl rand -base64 32)"`
        : `  creek env set ${v} <value>`,
    )
    .join("\n");
  return [
    {
      code: "CK-AUTH-SECRET",
      severity: "warn",
      title: `${label} detected — set its runtime secret(s) with \`creek env set\``,
      detail:
        `${label} requires ${envVars.join(", ")} at runtime. This is NOT part of your build — a secret can't ship in the bundle — so it lives in the project's deployed env, set with \`creek env set\`. If it's missing, the deploy still succeeds and the worker activates, but every request through the auth handler (login, get-session, OAuth callback) returns 500 with no build error and no log breadcrumb. Setting up a fresh project or claiming a sandbox into production is the common moment this gets forgotten. If you also use an OAuth provider, its client ID/secret env vars are required too.`,
      fix:
        `Set the secret on the deployed project, then redeploy:\n${setLines}\n  creek deploy\n\nCheck what's already set with \`creek env ls\`. (Already set? You can ignore this.)`,
      references: ["package.json"],
    },
  ];
};

// ─── Rule: split db.local.ts + db.prod.ts (or equivalents) ──────────────
//
// Agents frequently propose this pattern to work around perceived
// incompatibility between SQLite and D1. The portable driver in
// `@solcreek/runtime/db` and the `vite-react-drizzle` example both
// ship a single `server/db.ts` that works in both environments — so
// the split is extra code without benefit. Emit an info-level
// pointer, not a warning, because the split isn't actively broken,
// just unnecessary.

const DUAL_DRIVER_PAIRS: Array<[string, string]> = [
  ["server/db.local.ts", "server/db.prod.ts"],
  ["server/db.local.ts", "server/db.worker.ts"],
  ["server/db.dev.ts", "server/db.prod.ts"],
  ["src/db.local.ts", "src/db.prod.ts"],
  ["src/db/local.ts", "src/db/prod.ts"],
  ["db.local.ts", "db.prod.ts"],
];

const CK_DB_DUAL_DRIVER_SPLIT: Rule = (ctx) => {
  const hit = DUAL_DRIVER_PAIRS.find(
    ([a, b]) => ctx.fileExists(a) && ctx.fileExists(b),
  );
  if (!hit) return [];
  return [
    {
      code: "CK-DB-DUAL-DRIVER-SPLIT",
      severity: "info",
      title: `Split database driver files detected (${hit[0]} + ${hit[1]})`,
      detail:
        `You have two database setup files (${hit[0]} + ${hit[1]}). The ` +
        "recommended Creek pattern keeps **schema and query code shared** and " +
        "splits only the **boot files**: shared routes + schema run unchanged in " +
        "both environments, while a dev boot file (better-sqlite3) and a Workers " +
        "boot file (D1) handle driver setup. A db.local/db.prod split often " +
        "signals duplicated schema or queries, which drifts over time. Reference: " +
        "https://github.com/solcreek/creek/tree/main/examples/vite-react-drizzle",
      fix:
        "Extract schema and queries into driver-agnostic shared modules (e.g. " +
        "`schema.ts` + `routes.ts`). Keep one dev boot file (Node + better-" +
        "sqlite3) and one Workers boot file (CF Worker + D1); each imports the " +
        `shared schema/routes. Delete the two old files (${hit[0]} and ` +
        `${hit[1]}) once the shared modules are in place.`,
      references: [hit[0], hit[1]],
    },
  ];
};

// ─── Rule: worker entry imports packages that aren't installed ──────────
//
// The false-green-light bug: a worker entry (typically from `creek init
// --db`) imports packages that are neither in package.json nor installed
// — e.g. the scaffold imports hono, creek, d1-schema but init installs
// none of them. `creek deploy` bundles the worker with esbuild and dies
// with "Could not resolve" before anything ships, yet doctor used to
// report ok:true because no rule looked at the worker's imports. This
// rule statically scans the single declared worker file and flags bare
// import specifiers whose package isn't a declared dependency.

// Node builtins that resolve without a package.json entry. (Whether they
// run on Workers is CK-SYNC-SQLITE / patchBareNodeImports territory —
// here we only care about resolvability, so they're never "missing".)
const NODE_BUILTINS = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console",
  "constants", "crypto", "dgram", "diagnostics_channel", "dns", "domain",
  "events", "fs", "http", "http2", "https", "inspector", "module", "net",
  "os", "path", "perf_hooks", "process", "punycode", "querystring",
  "readline", "repl", "stream", "string_decoder", "sys", "timers", "tls",
  "trace_events", "tty", "url", "util", "v8", "vm", "wasi", "worker_threads",
  "zlib",
]);

/**
 * Extract bare module specifiers from import/export/require/dynamic-import
 * statements. Regex-based — good enough for the small, conventional worker
 * files this rule targets, not a full parser.
 */
export function extractImportSpecifiers(src: string): string[] {
  const specs = new Set<string>();
  const patterns = [
    /\bimport\s+[^"';]*?\bfrom\s*["']([^"']+)["']/g, // import X from "y"
    /\bimport\s*["']([^"']+)["']/g, //                  import "y"
    /\bexport\s+[^"';]*?\bfrom\s*["']([^"']+)["']/g, // export X from "y"
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g, //        require("y")
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, //         import("y")
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) specs.add(m[1]);
  }
  return [...specs];
}

/** Map a specifier to its installable package name (handles scopes + subpaths). */
function packageNameOf(spec: string): string {
  if (spec.startsWith("@")) return spec.split("/").slice(0, 2).join("/");
  return spec.split("/")[0];
}

const CK_WORKER_UNRESOLVED_IMPORTS: Rule = (ctx) => {
  const worker = ctx.resolved?.workerEntry;
  if (!worker) return [];
  // Only scan source files we can read + statically inspect.
  if (!/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(worker)) return [];
  // Pre-bundled worker outputs (e.g. dist/_worker.mjs) are out of scope —
  // a build inlines their deps, so bare imports there aren't a package.json
  // gap. Skip anything under a known build-output directory.
  const BUILD_OUTPUT_PREFIXES = [
    "dist/", "build/", "out/", ".output/", ".creek/", ".next/",
    ".svelte-kit/", ".vercel/", ".open-next/",
  ];
  const buildOut = ctx.resolved?.buildOutput
    ? ctx.resolved.buildOutput.replace(/\/?$/, "/")
    : null;
  if (
    BUILD_OUTPUT_PREFIXES.some((p) => worker.startsWith(p)) ||
    (buildOut && worker.startsWith(buildOut))
  ) {
    return [];
  }
  // Without a package.json there's no dependency set to check against —
  // flagging everything would be noise. CK-NO-CONFIG / install guidance
  // covers that case.
  if (!ctx.packageJson) return [];
  const src = ctx.readFile(worker);
  if (src === null) return []; // CK-WORKER-MISSING already covers absent files

  const missing: string[] = [];
  const seen = new Set<string>();
  for (const spec of extractImportSpecifiers(src)) {
    if (spec.startsWith(".") || spec.startsWith("/")) continue; // relative / absolute
    if (spec.startsWith("node:")) continue; // explicit builtin
    const pkg = packageNameOf(spec);
    if (NODE_BUILTINS.has(pkg)) continue; // bare builtin (fs, crypto, …)
    if (ctx.allDeps[pkg]) continue; // declared in deps or devDeps
    if (seen.has(pkg)) continue;
    seen.add(pkg);
    missing.push(pkg);
  }
  if (missing.length === 0) return [];

  const one = missing.length === 1;
  return [
    {
      code: "CK-WORKER-UNRESOLVED-IMPORTS",
      severity: "error",
      title: `Worker imports ${one ? "a package" : "packages"} not in package.json: ${missing.join(", ")}`,
      detail:
        `${worker} imports ${missing.join(", ")}, but ${one ? "it is" : "they are"} not listed in dependencies or devDependencies. \`creek deploy\` bundles the worker with esbuild and will fail with "Could not resolve" before anything is uploaded. This is exactly the gap a fresh \`creek init --db\` scaffold leaves: the example worker imports hono, creek, and d1-schema, none of which init installs.`,
      fix:
        `Install the missing ${one ? "package" : "packages"}:\n  npm install ${missing.join(" ")}\n\nThen re-run \`creek doctor\` to confirm. If a name is a typo or an intended path alias, fix the import in ${worker} instead.`,
      references: [worker, "package.json"],
    },
  ];
};

// ─── Rule: `creek` runtime missing for a Creek-bundled worker ───────────
//
// CK_WORKER_UNRESOLVED_IMPORTS scans the USER's worker source. But when
// Creek bundles a TS/JSX worker (the "esbuild-bundle" strategy), it also
// generates .creek/__worker_entry.js with an injected
// `import { _runRequest, generateWsToken } from "creek"`. That import is
// invisible to the source scan, so a project whose own code never imports
// `creek` (e.g. a dual-driver Drizzle worker) passes every other rule yet
// fails the real deploy with esbuild: Could not resolve "creek". This is
// the dogfood "dry-run false green" gap — dry-run runs doctor, so surfacing
// it here makes the plan honest. Pre-bundled workers (.js/.mjs/.cjs) are
// uploaded as-is with no wrapper, so they're out of scope.

const CK_RUNTIME_DEP_MISSING: Rule = (ctx) => {
  const resolved = ctx.resolved;
  const worker = resolved?.workerEntry;
  if (!resolved || !worker) return [];
  // Only the esbuild-bundle path injects the wrapper. A worker is uploaded
  // as-is (no wrapper) ONLY when it's a pre-bundled JS file INSIDE the build
  // output — not merely by extension: a `.js` source worker outside the
  // build output is still esbuild-bundled. Reuse deploy-plan's predicate so
  // the two never drift.
  if (isPrebundledWorker(worker, resolved.buildOutput)) return [];
  // No package.json → CK-NO-CONFIG / install guidance owns that case.
  if (!ctx.packageJson) return [];
  // `creek` resolvable from deps or devDeps satisfies esbuild at bundle
  // time — either is fine for resolution.
  if (ctx.allDeps["creek"]) return [];
  return [
    {
      code: "CK-RUNTIME-DEP-MISSING",
      severity: "error",
      title: "Worker bundle needs the `creek` runtime, but it isn't installed",
      detail:
        `Creek bundles ${worker} and injects a wrapper (.creek/__worker_entry.js) that imports the runtime: \`import { _runRequest, generateWsToken } from "creek"\`. \`creek\` is not in your package.json, so \`creek deploy\` will fail at esbuild with \`Could not resolve "creek"\` — even though \`creek deploy --dry-run\` reports wouldDeploy. Your own worker code doesn't have to import \`creek\` for this to bite: the wrapper always does.`,
      fix:
        "Install the runtime in `dependencies`:\n  npm install creek\n\nKeep it in `dependencies` (not devDependencies) — the generated wrapper imports it at bundle time. Re-run `creek doctor` to confirm.",
      references: ["package.json", "creek.toml"],
    },
  ];
};

// ─── Rule: sibling service directory that the deploy won't ship ─────────
//
// The multi-service blind spot: a repo has a root frontend (Vite SPA)
// plus a separate backend in server/ (a Bun/Hono process) and/or an
// mcp/ server. Creek deploys ONE worker entry + static assets, so a
// standalone backend process is silently left behind — doctor reported
// archetype:"spa", ok:true and never hinted that server/ won't ship.
// This rule warns when such a service directory exists but no worker
// entry is wired to carry that code into the deploy.

const SERVICE_DIRS: Array<{ dir: string; entries: string[] }> = [
  {
    dir: "server",
    entries: [
      "server/index.ts", "server/index.js", "server/main.ts",
      "server/app.ts", "server/server.ts", "server/package.json",
    ],
  },
  {
    dir: "mcp",
    entries: [
      "mcp/index.ts", "mcp/index.js", "mcp/server.ts",
      "mcp/main.ts", "mcp/package.json",
    ],
  },
  {
    dir: "backend",
    entries: [
      "backend/index.ts", "backend/main.ts", "backend/server.ts",
      "backend/app.ts", "backend/package.json",
    ],
  },
];

const CK_UNDEPLOYED_SERVICES: Rule = (ctx) => {
  const resolved = ctx.resolved;
  if (!resolved) return [];
  // A declared worker entry means the user has wired server code into the
  // deploy — server/ files are reachable from it, nothing is orphaned.
  if (resolved.workerEntry) return [];
  // SSR frameworks (and Astro's CF adapter) bundle their own server; a
  // server-shaped directory there belongs to the framework build.
  if (isSSRFramework(resolved.framework)) return [];
  if (ctx.allDeps["@astrojs/cloudflare"]) return [];

  const found = SERVICE_DIRS
    .filter(({ entries }) => entries.some((p) => ctx.fileExists(p)))
    .map(({ dir }) => dir);
  if (found.length === 0) return [];

  const list = found.map((d) => `${d}/`).join(", ");
  const one = found.length === 1;
  return [
    {
      code: "CK-UNDEPLOYED-SERVICES",
      severity: "warn",
      title: `Found ${one ? "a service directory" : "service directories"} that the deploy won't ship: ${list}`,
      detail:
        `Creek deploys a single worker entry plus static assets — it does not run a separate backend process. ${list} ${one ? "looks like a standalone service" : "look like standalone services"} (its own entrypoint or package.json), but with no [build].worker declared this project deploys as a static SPA, so ${one ? "that service" : "those services"} never ${one ? "ships" : "ship"}. Any same-origin /api/* calls the frontend makes will hit static-asset fallback (index.html), not your backend.`,
      fix:
        `Port the backend into a single same-origin worker — one Hono app that serves both /api/* and the SPA — and declare it:\n  [build]\n  worker = "worker/index.ts"\n\nThe worker handles API routes; unmatched paths fall back to the static build. (Genuinely deploying the service elsewhere? You can ignore this.)`,
      references: found,
    },
  ];
};

// ─── Rule registry ──────────────────────────────────────────────────────

export const BUILTIN_RULES: Rule[] = [
  CK_NO_CONFIG,
  CK_RESOURCES_KEYS,
  CK_WORKER_MISSING,
  CK_WORKER_UNRESOLVED_IMPORTS,
  CK_RUNTIME_DEP_MISSING,
  CK_RESOURCES_NO_WORKER,
  CK_WORKER_UNDECLARED,
  CK_UNDEPLOYED_SERVICES,
  CK_SYNC_SQLITE,
  CK_PRISMA_SQLITE,
  CK_NODE_HTTP_SERVER,
  CK_RUNTIME_LOCKIN,
  CK_CONFIG_OVERLAP,
  CK_NOTHING_TO_DEPLOY,
  CK_DB_DUAL_DRIVER_SPLIT,
  CK_AUTH_SECRET,
];

// Named exports for tests to target individual rules.
export const rules = {
  CK_NO_CONFIG,
  CK_RESOURCES_KEYS,
  CK_WORKER_MISSING,
  CK_WORKER_UNRESOLVED_IMPORTS,
  CK_RUNTIME_DEP_MISSING,
  CK_RESOURCES_NO_WORKER,
  CK_WORKER_UNDECLARED,
  CK_UNDEPLOYED_SERVICES,
  CK_SYNC_SQLITE,
  CK_PRISMA_SQLITE,
  CK_NODE_HTTP_SERVER,
  CK_RUNTIME_LOCKIN,
  CK_CONFIG_OVERLAP,
  CK_NOTHING_TO_DEPLOY,
  CK_DB_DUAL_DRIVER_SPLIT,
  CK_AUTH_SECRET,
} satisfies Record<string, Rule>;

// Helper used by the runner so rules don't have to normalize inputs.
export function collectFindings(
  ctx: DoctorContext,
  ruleSet: Rule[] = BUILTIN_RULES,
): Finding[] {
  const out: Finding[] = [];
  for (const rule of ruleSet) {
    out.push(...rule(ctx));
  }
  return out;
}
