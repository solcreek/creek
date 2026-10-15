/**
 * Following one deployment to its result: the breadcrumbs and the human
 * printout shared by `creek deployments get`, `creek deployments wait` and
 * `creek status <deploymentId>`. The fields come from the SDK's
 * DeploymentView, which mirrors the MCP get_deployment tool.
 */

import consola from "consola";
import type { DeploymentView } from "@solcreek/sdk";
import type { Breadcrumb } from "./output.js";
import { pasteableBreadcrumbs } from "./command-context.js";

/**
 * A follow-up command for a person to paste: `--project <slug>` is added the
 * same way as in the JSON breadcrumbs, when a bare project command here
 * would act on another project.
 */
export function humanCommand(slug: string, command: string): string {
  return pasteableBreadcrumbs(slug, [{ command, description: "" }])[0].command;
}

/** The command that follows a deployment to its final status. */
export function waitCommand(deploymentId: string): string {
  return `creek deployments wait ${deploymentId} --json`;
}

/**
 * What to run next for a deployment in this state, pasteable from the cwd
 * (`--project` is added when a bare project command would not resolve to it).
 */
export function deploymentFollowCrumbs(view: DeploymentView): Breadcrumb[] {
  const id = view.deploymentId;
  const crumbs: Breadcrumb[] = [];
  if (!view.terminal) {
    crumbs.push({ command: waitCommand(id), description: "Wait for the deploy to finish" });
    crumbs.push({
      command: `creek deployments logs ${id} --json`,
      description: "Read the build log so far",
    });
  } else if (view.status === "failed") {
    crumbs.push({
      command: `creek deployments logs ${id} --json`,
      description: "Read the build log to see why it failed",
    });
  } else if (view.status === "active" && view.url) {
    crumbs.push({
      command: `creek verify ${view.url} --json`,
      description: "Confirm the URL is live",
    });
  }
  crumbs.push({
    command: "creek deployments --json",
    description: "List recent deployments",
  });
  return pasteableBreadcrumbs(view.project, crumbs);
}

function colour(status: string | null): string {
  if (status === "active") return `\x1b[32m${status}\x1b[0m`;
  if (status === "failed") return `\x1b[31m${status}\x1b[0m`;
  if (status === "cancelled") return `\x1b[33m${status}\x1b[0m`;
  return status ?? "unknown";
}

/** The human printout of one deployment. */
export function printDeployment(view: DeploymentView): void {
  const version = view.version !== null ? ` (v${view.version})` : "";
  consola.log(`\n  Deployment ${view.deploymentId}${version}`);
  consola.log(`  Project:  ${view.project}`);
  consola.log(`  Status:   ${colour(view.status)}${view.terminal ? "" : " (in progress)"}`);
  if (view.branch || view.commitSha) {
    consola.log(
      `  Commit:   ${[view.branch, view.commitSha?.slice(0, 12)].filter(Boolean).join(" @ ")}`,
    );
  }
  if (view.url) consola.log(`  URL:      ${view.url}`);
  if (view.status === "failed") {
    const code = view.errorCode ? ` [${view.errorCode}]` : "";
    consola.log(
      `  Failed:   ${view.failedStep ?? "unknown step"}${code} — ${view.errorMessage ?? "no message"}`,
    );
    if (view.errorHint) consola.log(`  Hint:     ${view.errorHint}`);
    consola.log(
      `  Log:      ${humanCommand(view.project, `creek deployments logs ${view.deploymentId}`)}`,
    );
  } else if (!view.terminal) {
    consola.log(
      `  Follow:   ${humanCommand(view.project, `creek deployments wait ${view.deploymentId}`)}`,
    );
  }
  consola.log("");
}
