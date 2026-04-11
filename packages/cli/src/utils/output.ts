/**
 * Shared output utilities for agent-friendly CLI.
 *
 * --json flag + non-TTY auto-detection ensures every command
 * can produce structured output for agents, CI/CD, and pipes.
 */

export const isTTY = process.stdout.isTTY ?? false;

/** A suggested next command for agents to follow. */
export interface Breadcrumb {
  command: string;
  description: string;
}

/** Output structured JSON and exit. */
export function jsonOutput(data: Record<string, unknown>, exitCode = 0, breadcrumbs?: Breadcrumb[]): never {
  const output = breadcrumbs?.length ? { ...data, breadcrumbs } : data;
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
  process.exit(exitCode);
}

/** Resolve JSON mode: explicit --json flag OR non-TTY environment. */
export function resolveJsonMode(args: { json?: boolean }): boolean {
  return args.json === true || !isTTY;
}

/**
 * Common --json and --yes args to spread into any command's args definition.
 *
 * Usage:
 *   args: { ...globalArgs, myArg: { ... } }
 */
export const globalArgs = {
  json: {
    type: "boolean" as const,
    description: "Output results as JSON (auto-enabled in CI/CD and pipes)",
    default: false,
  },
  yes: {
    type: "boolean" as const,
    description: "Skip confirmation prompts (auto-enabled in non-TTY)",
    default: false,
  },
};

/** Should we skip interactive prompts? */
export function shouldAutoConfirm(args: { yes?: boolean }): boolean {
  return args.yes === true || !isTTY;
}

/** Output an error in the appropriate format and exit. */
export function exitError(jsonMode: boolean, error: string, message: string, exitCode = 1, breadcrumbs?: Breadcrumb[]): never {
  if (jsonMode) jsonOutput({ ok: false, error, message }, exitCode, breadcrumbs);
  return process.exit(exitCode);
}

/** Reusable breadcrumbs for common error states. */
export const AUTH_BREADCRUMBS: Breadcrumb[] = [
  { command: "creek login", description: "Authenticate interactively" },
  { command: "creek login --token <KEY>", description: "Authenticate with API key (CI/CD)" },
];

export const NO_PROJECT_BREADCRUMBS: Breadcrumb[] = [
  { command: "creek init", description: "Initialize creek.toml in current directory" },
  { command: "creek deploy --template landing", description: "Start from a ready-made Vite + React landing page" },
];
