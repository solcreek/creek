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
        "Creek's [resources] block uses semantic names (database / cache / storage / ai), not CF service names (d1 / kv / r2). The keys you wrote are silently dropped — nothing gets provisioned, and at runtime env.DB / env.KV / env.BUCKET will be undefined.",
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

// ─── Rule: better-sqlite3 — sync API doesn't run on Workers ──────────────

const CK_SYNC_SQLITE: Rule = (ctx) => {
  if (!ctx.allDeps["better-sqlite3"]) return [];
  return [
    {
      code: "CK-SYNC-SQLITE",
      severity: "warn",
      title: "better-sqlite3 in dependencies — synchronous, won't run on Workers",
      detail:
        "better-sqlite3 is a Node native module with a synchronous API (db.prepare(...).get()). Cloudflare Workers runs workerd (no native bindings, no sync DB access). D1 — Creek's default `env.DB` — has an async API; the method signatures differ. A codemod-style rename won't work; every call site needs an `await`.",
      fix:
        "Swap to an ORM with a D1 adapter. Drizzle or Kysely are the drop-in paths — their query APIs are async-shaped regardless of backend, so the same code can run against better-sqlite3 locally and D1 in production with just a driver swap at boot.\n\nReference example: examples/vite-react-drizzle/ (zero @solcreek/* deps in the runtime).\n\nDocs: https://creek.dev/docs/cli#creek-logs",
      references: ["package.json"],
    },
  ];
};

// ─── Rule: Prisma with SQLite datasource ────────────────────────────────

const CK_PRISMA_SQLITE: Rule = (ctx) => {
  if (!ctx.allDeps["@prisma/client"] && !ctx.allDeps["prisma"]) return [];
  return [
    {
      code: "CK-PRISMA-SQLITE",
      severity: "warn",
      title: "Prisma detected — limited Workers support",
      detail:
        "Prisma on Cloudflare Workers requires Prisma Accelerate (hosted connection pool) or a D1 adapter, not the default engine. If you're using local SQLite, it won't port cleanly; if you're using Postgres, plan for Accelerate + a cold-start budget.",
      fix:
        "For new projects, consider Drizzle instead (native D1 + Postgres adapters, no hosted connection pool required). If you need to keep Prisma: use @prisma/adapter-d1 for SQLite, or Prisma Accelerate for Postgres. See https://www.prisma.io/docs/orm/overview/databases/cloudflare-d1",
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
        "If portability matters (it usually should): use platform-native APIs in your handler — `env.DB` directly, or an ORM with a standard adapter. See examples/vite-react-drizzle for the zero-lock-in pattern. Move these deps to devDependencies if only used during build/dev.",
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
      title: `Build output '${buildOutput}' not found and no worker entry — nothing to deploy yet`,
      detail: hasBuildCommand
        ? `You have a build command (${ctx.resolved.buildCommand}) but no output. Either the build hasn't run, or it writes to a different directory than [build].output says.`
        : "No build command, no build output, no worker entry.",
      fix: hasBuildCommand
        ? `Run your build (\`${ctx.resolved.buildCommand}\`) and confirm it writes to ${buildOutput}/. If your tooling writes to a different directory, update creek.toml [build].output.`
        : "Add a build script to package.json, or a [build].worker entry in creek.toml, or a static directory at the [build].output path.",
    },
  ];
};

// ─── Rule registry ──────────────────────────────────────────────────────

export const BUILTIN_RULES: Rule[] = [
  CK_NO_CONFIG,
  CK_RESOURCES_KEYS,
  CK_WORKER_MISSING,
  CK_SYNC_SQLITE,
  CK_PRISMA_SQLITE,
  CK_RUNTIME_LOCKIN,
  CK_CONFIG_OVERLAP,
  CK_NOTHING_TO_DEPLOY,
];

// Named exports for tests to target individual rules.
export const rules = {
  CK_NO_CONFIG,
  CK_RESOURCES_KEYS,
  CK_WORKER_MISSING,
  CK_SYNC_SQLITE,
  CK_PRISMA_SQLITE,
  CK_RUNTIME_LOCKIN,
  CK_CONFIG_OVERLAP,
  CK_NOTHING_TO_DEPLOY,
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
