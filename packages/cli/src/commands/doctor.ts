import { defineCommand } from "citty";
import consola from "consola";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  runDoctor,
  resolveConfig,
  ConfigNotFoundError,
  type DoctorContext,
  type DoctorReport,
  type Finding,
  type ResolvedConfig,
} from "@solcreek/sdk";

// Local shape — matches the SDK doctor's PackageJson. Duplicated
// instead of re-exported because the SDK's types/index.ts uses a
// different (richer) Package shape we don't need here.
interface PackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}
import {
  globalArgs,
  resolveJsonMode,
  jsonOutput,
} from "../utils/output.js";

/**
 * `creek doctor` — pre-deploy sanity check.
 *
 * Runs the SDK rule engine against the current project, reports
 * findings. Exits 0 if ok, 1 if any error-severity finding fires.
 *
 * This is the one command designed for LLM agents to invoke before
 * `creek deploy`. With `--json` the output is ndjson-adjacent (pretty
 * JSON, but parseable), letting an agent look up fixes by stable
 * CK-* codes and apply them without re-reading the source.
 */
export const doctorCommand = defineCommand({
  meta: {
    name: "doctor",
    description:
      "Analyze the project for pre-deploy issues — missing build output, deprecated config keys, Workers-incompatible deps, portability leaks.",
  },
  args: {
    path: {
      type: "positional",
      description: "Project directory to analyze. Defaults to cwd.",
      required: false,
    },
    ...globalArgs,
  },
  async run({ args }) {
    const cwd = resolve((args.path as string | undefined) ?? process.cwd());
    const jsonMode = resolveJsonMode(args);

    const ctx = buildContext(cwd);
    const report = runDoctor(ctx);

    if (jsonMode) {
      jsonOutput(
        {
          ok: report.ok,
          cwd,
          archetype: report.archetype,
          summary: report.summary,
          findings: report.findings,
        },
        report.ok ? 0 : 1,
      );
      return;
    }

    printHuman(cwd, report);
    if (!report.ok) process.exit(1);
  },
});

function buildContext(cwd: string): DoctorContext {
  const fileExists = (relPath: string): boolean =>
    existsSync(join(cwd, relPath));
  const creekTomlPath = join(cwd, "creek.toml");
  const creekTomlRaw = existsSync(creekTomlPath)
    ? safeRead(creekTomlPath)
    : null;
  const pkgPath = join(cwd, "package.json");
  const packageJson: PackageJson | null = existsSync(pkgPath)
    ? safeParseJson<PackageJson>(pkgPath)
    : null;
  const resolved: ResolvedConfig | null = resolveConfigSafely(cwd);
  const allDeps = {
    ...(packageJson?.dependencies ?? {}),
    ...(packageJson?.devDependencies ?? {}),
  };
  return { cwd, resolved, packageJson, creekTomlRaw, fileExists, allDeps };
}

function resolveConfigSafely(cwd: string): ResolvedConfig | null {
  try {
    return resolveConfig(cwd);
  } catch (err) {
    if (err instanceof ConfigNotFoundError) return null;
    // Other errors (parse failures) bubble as null — the rules will
    // still pick up partial info from creekTomlRaw + packageJson.
    return null;
  }
}

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function safeParseJson<T>(path: string): T | null {
  const raw = safeRead(path);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// ─── Human output ───────────────────────────────────────────────────────

const COLOR = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

function tty(): boolean {
  return process.stdout.isTTY ?? false;
}

function c(s: string, color: keyof typeof COLOR): string {
  return tty() ? `${COLOR[color]}${s}${COLOR.reset}` : s;
}

function printHuman(cwd: string, report: DoctorReport): void {
  consola.log("");
  consola.log(`  ${c("⬡ creek doctor", "bold")}  ${c(cwd, "dim")}`);
  consola.log(`  ${c("archetype:", "dim")} ${report.archetype ?? "unknown"}`);
  consola.log("");

  if (report.findings.length === 0) {
    consola.log(`  ${c("✓", "green")} No issues detected. Deploy is good to go.`);
    consola.log("");
    return;
  }

  const order: Finding["severity"][] = ["error", "warn", "info"];
  const grouped = groupBy(report.findings, (f) => f.severity);
  for (const sev of order) {
    const bucket = grouped.get(sev) ?? [];
    for (const f of bucket) {
      printFinding(f);
    }
  }

  const parts: string[] = [];
  if (report.summary.error) parts.push(c(`${report.summary.error} error${s(report.summary.error)}`, "red"));
  if (report.summary.warn) parts.push(c(`${report.summary.warn} warning${s(report.summary.warn)}`, "yellow"));
  if (report.summary.info) parts.push(c(`${report.summary.info} info`, "cyan"));
  consola.log(`  Summary: ${parts.join(", ")}`);
  consola.log("");
}

function printFinding(f: Finding): void {
  const icon =
    f.severity === "error" ? c("✗", "red")
      : f.severity === "warn" ? c("⚠", "yellow")
        : c("ℹ", "cyan");
  consola.log(`  ${icon} ${c(f.title, "bold")}  ${c(`[${f.code}]`, "gray")}`);
  for (const line of f.detail.split("\n")) {
    consola.log(`     ${c(line, "dim")}`);
  }
  consola.log(`     ${c("→ fix:", "cyan")}`);
  for (const line of f.fix.split("\n")) {
    consola.log(`       ${line}`);
  }
  if (f.references?.length) {
    consola.log(`     ${c("→ refs:", "dim")} ${f.references.join(", ")}`);
  }
  consola.log("");
}

function groupBy<T, K>(arr: T[], key: (v: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const v of arr) {
    const k = key(v);
    const bucket = out.get(k) ?? [];
    bucket.push(v);
    out.set(k, bucket);
  }
  return out;
}

function s(n: number): string {
  return n === 1 ? "" : "s";
}
