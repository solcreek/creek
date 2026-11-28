/**
 * Where a `creek deploy` invocation will actually deploy.
 *
 * One pure decision shared by the dry-run plan and the real run, which also
 * dispatches on it, so the two cannot disagree. Before this, the dry-run, the
 * signed-out `--prod` refusal and the dispatch each guessed the destination
 * on their own, and `--prod` could still end up in a sandbox (an explicit
 * directory, a template, a build-output fallback, or a signed-out run).
 *
 * The rules:
 * - `--prod` never ends in a sandbox. Signed out it is `not_authenticated`;
 *   on a path with no production support it is `prod_unsupported`.
 * - `--sandbox` never ends in production (or creekd): `--from-github` and a
 *   creekd project have no sandbox, so `--sandbox` there is
 *   `sandbox_unsupported` — agents use it as the safe flag, and a creekd
 *   deploy replaces the live self-hosted app.
 * - A creekd project deploys to creekd; it authenticates with its own token
 *   (CREEKD_TOKEN / CREEKCTL_TOKEN), never the creek.dev session.
 */

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { resolveConfig, ConfigNotFoundError } from "@solcreek/sdk";
import { AUTH_BREADCRUMBS, AGENT_SANDBOX_DEPLOY, type Breadcrumb } from "./output.js";
import { isRepoUrl, RepoUrlError, validateSubpath } from "./repo-url.js";
import { shellQuote } from "./shell-quote.js";

/** How the invocation reaches its files. Mirrors the dispatch in deploy.ts. */
export type DeployPath =
  /** `--template <name>`: clone a template, sandbox only. */
  | "template"
  /** `--from-github`: the project's GitHub connection builds production. */
  | "from-github"
  /** `creek deploy https://github.com/…`: clone, then project rules. */
  | "repo-url"
  /** `creek deploy <dir>`: upload the directory as is, sandbox only. */
  | "directory"
  /** cwd with no config but a dist/build/out folder: upload it, sandbox only. */
  | "build-output"
  /** cwd project (creek.toml, wrangler, package.json, index.html) or nothing yet. */
  | "project";

export const BUILD_OUTPUT_DIRS = ["dist", "build", "out", ".output/public"] as const;

export interface DestinationInput {
  path: DeployPath;
  /** The local config's deploy target (`project` / `directory` paths). */
  localTarget: "cf" | "creekd";
  authenticated: boolean;
  prod: boolean;
  sandbox: boolean;
  yes: boolean;
  /** The `<dir>` argument as typed (directory path), for messages. */
  dir?: string;
  /** Validated relative monorepo subdirectory from `--path <subdir>`. */
  subpath?: string;
  /** `--path` validation failure (conflicting flags, invalid subpath, missing subdir). */
  pathError?: { error: "conflicting_flags" | "invalid_path" | "not_found"; message: string };
  /** The `--template` name, for messages. */
  template?: string;
  /**
   * The local config exists but can't be read or parsed (`project` /
   * `directory` paths). Its diagnostic wins over every other decision: the
   * destination can't be known, and guessing sends the caller the wrong way.
   */
  configError?: string;
}

export type RefusalError =
  | "conflicting_flags"
  | "invalid_config"
  | "invalid_path"
  | "not_found"
  | "not_authenticated"
  | "prod_unsupported"
  | "sandbox_unsupported"
  | "creekd_dir_unsupported";

export type DeployDestination =
  | { kind: "production"; implicit: boolean; reason: string }
  | { kind: "sandbox"; reason: string }
  | { kind: "creekd"; reason: string }
  | { kind: "refused"; error: RefusalError; message: string; breadcrumbs: Breadcrumb[] };

const SANDBOX_ONLY: ReadonlySet<DeployPath> = new Set(["template", "directory", "build-output"]);

function isSafeSubpath(value: string): boolean {
  try {
    validateSubpath(value);
    return true;
  } catch {
    return false;
  }
}

function subpathDeployCmd(
  subpath: string | undefined,
  targetFlag: "--prod" | "--sandbox" | "--yes" | "--dry-run",
): string {
  return subpath
    ? `creek deploy --path ${shellQuote(subpath)} ${targetFlag} --json`
    : `creek deploy ${targetFlag} --json`;
}

function prodUnsupported(input: DestinationInput): DeployDestination {
  if (input.path === "template") {
    const name = input.template ? shellQuote(input.template) : "<name>";
    return {
      kind: "refused",
      error: "prod_unsupported",
      message: `--template deploys only to a 60-minute sandbox; it has no production path. Scaffold the template into a project, then deploy that with --prod.`,
      breadcrumbs: [
        {
          command: `npx create-creek-app my-app --template ${name}`,
          description: "Scaffold the template locally, then run `creek deploy --prod --json` in it",
        },
        {
          command: `creek deploy --template ${name} --sandbox --json`,
          description: "Preview the template in a 60-minute sandbox instead",
        },
      ],
    };
  }
  const where =
    input.path === "directory"
      ? `\`creek deploy ${input.dir ?? "<dir>"}\` uploads that directory to a 60-minute sandbox`
      : "Without a project config, the build-output folder is uploaded to a 60-minute sandbox";
  const breadcrumbs: Breadcrumb[] = [];
  if (input.path === "directory" && input.dir && isSafeSubpath(input.dir)) {
    breadcrumbs.push({
      command: `creek deploy --path ${shellQuote(input.dir)} --prod --json`,
      description:
        "If this is a monorepo project subdir, deploy it to production with --path instead",
    });
  }
  breadcrumbs.push(
    {
      command: "creek init --json",
      description:
        'In the project directory: write creek.toml (set [build] output to the built folder, and command = "" if it is prebuilt), then `creek deploy --prod --json`',
    },
    {
      command:
        input.path === "directory"
          ? `creek deploy ${input.dir ? shellQuote(input.dir) : "<dir>"} --sandbox --json`
          : input.subpath
            ? subpathDeployCmd(input.subpath, "--sandbox")
            : AGENT_SANDBOX_DEPLOY,
      description: "Deploy to a 60-minute sandbox instead",
    },
  );
  return {
    kind: "refused",
    error: "prod_unsupported",
    message: `${where}; it has no production path. Production deploys run from a project directory with a config (creek.toml, wrangler, package.json or index.html).`,
    breadcrumbs,
  };
}

/** Pure: decide the destination from the path, the local target, auth and flags. */
export function deployDestination(input: DestinationInput): DeployDestination {
  if (input.prod && input.sandbox) {
    return {
      kind: "refused",
      error: "conflicting_flags",
      message: "--prod and --sandbox are mutually exclusive. Pick one target.",
      breadcrumbs: [],
    };
  }

  if (input.pathError) {
    return {
      kind: "refused",
      error: input.pathError.error,
      message: input.pathError.message,
      breadcrumbs: [],
    };
  }

  if (input.configError !== undefined) {
    return {
      kind: "refused",
      error: "invalid_config",
      message: `Couldn't read the project config: ${input.configError}`,
      breadcrumbs: [],
    };
  }

  // A creekd project deploys to the user's own creekd.
  if (input.localTarget === "creekd") {
    if (input.path === "project") {
      if (input.sandbox) {
        // --sandbox is the "safe preview" flag; on a creekd project a deploy
        // replaces the live self-hosted app, so never treat it as a preview.
        return {
          kind: "refused",
          error: "sandbox_unsupported",
          message:
            'This project targets creekd (creek.toml target = "creekd"), which has no sandbox: a deploy replaces the live app on your creekd. Nothing was deployed. Deploy to creekd explicitly, or preview with `creek dev`.',
          breadcrumbs: [
            {
              command: subpathDeployCmd(input.subpath, "--yes"),
              description: "Deploy to your creekd",
            },
            {
              command: subpathDeployCmd(input.subpath, "--dry-run"),
              description: "Preview the plan first",
            },
          ],
        };
      }
      return {
        kind: "creekd",
        reason:
          'creek.toml sets target = "creekd": deploys to your creekd (CREEKD_TOKEN / CREEKCTL_TOKEN), not to Creek',
      };
    }
    if (input.path === "directory") {
      // `creek deploy <dir>` is a prebuilt-asset upload with no build, release
      // or app-spawn step; creekd deploys need that project pipeline, which
      // runs from the project directory. Refuse rather than make `<dir>` mean
      // two things, or publish a self-hosted project's files to a sandbox.
      const dir = input.dir ?? "<dir>";
      const breadcrumbs: Breadcrumb[] = [];
      if (input.dir && isSafeSubpath(input.dir)) {
        breadcrumbs.push({
          command: `creek deploy --path ${shellQuote(input.dir)} --yes --json`,
          description: "Deploy the monorepo subdirectory to creekd with --path",
        });
      }
      breadcrumbs.push({
        command: `cd ${input.dir ? shellQuote(input.dir) : "<dir>"} && creek deploy --yes --json`,
        description: "Deploy the project to your creekd from its directory",
      });
      return {
        kind: "refused",
        error: "creekd_dir_unsupported",
        message: `${dir} targets creekd (creek.toml target = "creekd"). creekd deploys run from the project directory, not as a directory upload.`,
        breadcrumbs,
      };
    }
  }

  if (input.path === "from-github") {
    if (input.sandbox) {
      return {
        kind: "refused",
        error: "sandbox_unsupported",
        message:
          "--from-github deploys the production branch through the project's GitHub connection; it has no sandbox. Drop --from-github to preview local files in a sandbox.",
        breadcrumbs: [
          {
            command: input.subpath
              ? subpathDeployCmd(input.subpath, "--sandbox")
              : AGENT_SANDBOX_DEPLOY,
            description: "Deploy local files to a 60-minute sandbox",
          },
        ],
      };
    }
    if (!input.authenticated) return notAuthenticated("--from-github", input.subpath);
    return {
      kind: "production",
      implicit: !input.prod,
      reason: "--from-github: the project's GitHub connection builds and deploys production",
    };
  }

  if (SANDBOX_ONLY.has(input.path)) {
    // Signing in would not help: this path has no production support at all.
    if (input.prod) return prodUnsupported(input);
    return {
      kind: "sandbox",
      reason:
        input.path === "template"
          ? "--template deploys to a 60-minute sandbox"
          : input.path === "directory"
            ? "an explicit directory is uploaded to a 60-minute sandbox"
            : "no project config: the build-output folder is uploaded to a 60-minute sandbox",
    };
  }

  // project / repo-url: production when signed in, sandbox otherwise.
  if (input.sandbox) return { kind: "sandbox", reason: "--sandbox" };
  if (!input.authenticated) {
    if (input.prod) {
      return notAuthenticated("--prod", input.path === "repo-url" ? undefined : input.subpath);
    }
    return { kind: "sandbox", reason: "not signed in: the only target without a session" };
  }
  return input.prod
    ? { kind: "production", implicit: false, reason: "--prod" }
    : {
        kind: "production",
        implicit: true,
        reason:
          "signed in without --prod: an interactive terminal confirms first; --yes / --json deploy with a deprecation warning",
      };
}

function notAuthenticated(flag: string, subpath?: string): DeployDestination {
  const sandboxCmd = subpath ? subpathDeployCmd(subpath, "--sandbox") : AGENT_SANDBOX_DEPLOY;
  return {
    kind: "refused",
    error: "not_authenticated",
    message: `${flag} publishes to your team's production slot and requires sign-in. Not signed in, so nothing was deployed. Run \`creek login --token <KEY> --json\` (or \`creek login\`), or pass --sandbox for a 60-minute preview.`,
    breadcrumbs: [
      ...AUTH_BREADCRUMBS,
      { command: sandboxCmd, description: "Deploy to a 60-minute sandbox instead" },
    ],
  };
}

/**
 * The config's target, null when there is no config at all. Only
 * ConfigNotFoundError means "no config": a config that exists but is broken
 * is reported as such, never mistaken for a config-less directory.
 */
function configTarget(dir: string): { target: "cf" | "creekd" | null; error?: string } {
  try {
    return { target: resolveConfig(dir).target === "creekd" ? "creekd" : "cf" };
  } catch (err) {
    if (err instanceof ConfigNotFoundError) return { target: null };
    return { target: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Classify the invocation the way the dispatch in deploy.ts does (reads the
 * filesystem; the decision itself is `deployDestination`).
 */
export function inspectDeployPath(
  args: { template?: unknown; "from-github"?: unknown; dir?: unknown; path?: unknown },
  cwd: string = process.cwd(),
): Pick<
  DestinationInput,
  "path" | "localTarget" | "dir" | "subpath" | "template" | "configError" | "pathError"
> {
  const template = typeof args.template === "string" ? args.template : undefined;
  const dirArg = typeof args.dir === "string" && args.dir.length > 0 ? args.dir : undefined;
  const hasPathArg = typeof args.path === "string";
  const pathArg = hasPathArg ? (args.path as string) : undefined;
  const isRemoteRepo = !!(dirArg && isRepoUrl(dirArg));

  if (args.template) {
    if (hasPathArg) {
      return {
        path: "template",
        localTarget: "cf",
        template,
        pathError: {
          error: "conflicting_flags",
          message: "--path cannot be used with --template.",
        },
      };
    }
    return { path: "template", localTarget: "cf", template };
  }

  if (dirArg && !isRemoteRepo && hasPathArg) {
    return {
      path: "project",
      localTarget: "cf",
      pathError: {
        error: "conflicting_flags",
        message:
          "--path selects a project subdirectory relative to the current directory and cannot be combined with a positional <dir>.",
      },
    };
  }

  let validatedSubpath: string | undefined;
  if (hasPathArg) {
    try {
      validateSubpath(pathArg!);
    } catch (err) {
      return {
        path: isRemoteRepo ? "repo-url" : args["from-github"] ? "from-github" : "project",
        localTarget: "cf",
        pathError: {
          error: "invalid_path",
          message: err instanceof RepoUrlError ? err.message : String(err),
        },
      };
    }
    validatedSubpath = pathArg!.replace(/\/+$/, "");
  }

  if (args["from-github"]) {
    if (validatedSubpath) {
      const targetDir = resolve(cwd, validatedSubpath);
      if (!existsSync(targetDir) || !statSync(targetDir).isDirectory()) {
        return {
          path: "from-github",
          localTarget: "cf",
          subpath: validatedSubpath,
          pathError: {
            error: "not_found",
            message: `Subdirectory not found: ${validatedSubpath}`,
          },
        };
      }
      return { path: "from-github", localTarget: "cf", subpath: validatedSubpath };
    }
    return { path: "from-github", localTarget: "cf" };
  }

  if (isRemoteRepo) {
    return {
      path: "repo-url",
      localTarget: "cf",
      ...(validatedSubpath ? { subpath: validatedSubpath } : {}),
    };
  }

  if (dirArg) {
    const found = configTarget(resolve(cwd, dirArg));
    return {
      path: "directory",
      localTarget: found.target ?? "cf",
      dir: dirArg,
      ...(found.error !== undefined ? { configError: found.error } : {}),
    };
  }

  const projectCwd = validatedSubpath ? resolve(cwd, validatedSubpath) : cwd;
  if (validatedSubpath && (!existsSync(projectCwd) || !statSync(projectCwd).isDirectory())) {
    return {
      path: "project",
      localTarget: "cf",
      subpath: validatedSubpath,
      pathError: {
        error: "not_found",
        message: `Subdirectory not found: ${validatedSubpath}`,
      },
    };
  }
  const subpathFields = validatedSubpath ? { subpath: validatedSubpath } : {};
  const found = configTarget(projectCwd);
  if (found.error !== undefined) {
    return { path: "project", localTarget: "cf", configError: found.error, ...subpathFields };
  }
  if (found.target) return { path: "project", localTarget: found.target, ...subpathFields };
  if (BUILD_OUTPUT_DIRS.some((d) => existsSync(resolve(projectCwd, d)))) {
    return { path: "build-output", localTarget: "cf", ...subpathFields };
  }
  // Nothing deployable yet: plan it as the project it is about to become.
  return { path: "project", localTarget: "cf", ...subpathFields };
}
