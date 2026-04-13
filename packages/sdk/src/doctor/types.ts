/**
 * Diagnostic rule types — shared between the rule implementations
 * and the CLI consumer.
 *
 * Design goals:
 * - Rules are PURE functions over a DoctorContext. No fs/network IO
 *   inside rules so tests can drive with fixtures.
 * - Findings carry a stable `code` so LLM agents can pattern-match
 *   on known issues (e.g. "apply fix for CK-SYNC-SQLITE") without
 *   parsing English.
 * - `fix` is a concrete actionable string. If it spans multiple
 *   lines or needs code, put it in the string — LLM agents will
 *   apply it verbatim.
 */

import type { ResolvedConfig } from "../config/resolved-config.js";

// Local PackageJson shape — narrow subset rules actually read.
// SDK's framework detection uses a private one; duplicating here
// keeps the doctor module decoupled from framework internals.
export interface PackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

export type Severity = "error" | "warn" | "info";

export interface Finding {
  /**
   * Stable machine-readable code. Format: `CK-<CATEGORY>-<SHORT>`.
   * Never change the code of an existing rule — downstream tooling
   * pins on it. If behavior changes, bump the code (add a new one).
   */
  code: string;
  severity: Severity;
  /** One-line headline. Shown bold in human output. */
  title: string;
  /** Longer explanation. Multi-line OK. */
  detail: string;
  /**
   * Actionable fix the user (or an LLM agent) can apply as-is.
   * Use code blocks for diff-style fixes.
   */
  fix: string;
  /** Project-relative paths that triggered this finding. */
  references?: string[];
}

export interface DoctorContext {
  /** Absolute project root. Rules should only use this for reference paths. */
  cwd: string;
  /**
   * Parsed config. `null` when resolveConfig failed — the "nothing
   * to deploy" rule catches that case explicitly.
   */
  resolved: ResolvedConfig | null;
  /** Parsed package.json. `null` if missing. */
  packageJson: PackageJson | null;
  /** Raw creek.toml text. `null` if no creek.toml on disk. */
  creekTomlRaw: string | null;
  /** Project-relative file existence check. */
  fileExists: (relPath: string) => boolean;
  /** Flattened deps+devDeps map from package.json. Empty if no pkg. */
  allDeps: Record<string, string>;
}

export type Rule = (ctx: DoctorContext) => Finding[];

export interface DoctorReport {
  /** True iff there are zero errors. Warnings don't affect ok. */
  ok: boolean;
  findings: Finding[];
  summary: { error: number; warn: number; info: number };
  /** Detected archetype, if recognized. */
  archetype?: "spa" | "ssr-framework" | "worker-only" | "worker+assets" | "unknown";
}
