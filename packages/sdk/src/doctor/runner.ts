/**
 * Doctor runner — wraps the rule collection with archetype detection
 * and builds the final DoctorReport.
 *
 * IO-agnostic: takes a DoctorContext in, returns a report out.
 * Callers (CLI, dashboard, tests) build the context differently.
 */

import type { DoctorContext, DoctorReport, Finding } from "./types.js";
import { BUILTIN_RULES, collectFindings } from "./rules.js";
import { isSSRFramework } from "../types/index.js";

export interface RunDoctorOptions {
  /** Override rule set. Default = BUILTIN_RULES. Used for focused tests. */
  rules?: typeof BUILTIN_RULES;
}

export function runDoctor(
  ctx: DoctorContext,
  opts: RunDoctorOptions = {},
): DoctorReport {
  const findings = collectFindings(ctx, opts.rules ?? BUILTIN_RULES);
  const summary = countBySeverity(findings);
  return {
    ok: summary.error === 0,
    findings,
    summary,
    archetype: detectArchetype(ctx),
  };
}

function countBySeverity(findings: Finding[]): DoctorReport["summary"] {
  const out = { error: 0, warn: 0, info: 0 };
  for (const f of findings) out[f.severity]++;
  return out;
}

function detectArchetype(ctx: DoctorContext): DoctorReport["archetype"] {
  if (!ctx.resolved) return "unknown";
  const framework = ctx.resolved.framework;
  const hasWorker = !!ctx.resolved.workerEntry;
  const isSSR = isSSRFramework(framework);

  if (isSSR && framework) return "ssr-framework";
  if (framework && hasWorker) return "worker+assets";
  if (framework) return "spa";
  if (hasWorker) return "worker-only";
  return "unknown";
}
