/**
 * Shared --dry-run contract for mutating CLI commands.
 *
 * JSON shape matches `creek deploy --dry-run`: `wouldExecute`, `sideEffects`,
 * and a copy-pasteable `nextStep`. Commands must not POST/DELETE before
 * calling emitDryRunPlan.
 */

import consola from "consola";
import { jsonOutput } from "./output.js";

export const dryRunArg = {
  "dry-run": {
    type: "boolean" as const,
    description: "Preview the change without executing it",
    default: false,
  },
};

export function isDryRun(args: { "dry-run"?: boolean }): boolean {
  return args["dry-run"] === true;
}

export interface DryRunPlan {
  command: string;
  wouldExecute: boolean;
  sideEffects: string[];
  nextStep: string;
  [key: string]: unknown;
}

export function emitDryRunPlan(jsonMode: boolean, plan: DryRunPlan): void {
  const { command, wouldExecute, sideEffects, nextStep, ...rest } = plan;
  if (jsonMode) {
    jsonOutput(
      {
        ok: true,
        mode: "dry-run",
        supported: true,
        command,
        wouldExecute,
        sideEffects,
        nextStep,
        ...rest,
      },
      0,
    );
  }
  consola.info("Dry-run — no changes made.");
  consola.info(`  wouldExecute: ${wouldExecute}`);
  for (const s of sideEffects) consola.info(`  - ${s}`);
  consola.info(`  Next: ${nextStep}`);
}
