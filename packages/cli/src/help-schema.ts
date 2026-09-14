/**
 * Machine-readable `creek --help --json` schema.
 *
 * Walks a citty command tree. A command is `destructive` iff it defines
 * `--dry-run` — that is the CLI convention for mutating commands.
 */

export interface HelpArg {
  name: string;
  type: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  alias?: string | string[];
}

export interface HelpCommand {
  name: string;
  description?: string;
  version?: string;
  args: HelpArg[];
  dryRun: boolean;
  destructive: boolean;
  subcommands: HelpCommand[];
}

export interface HelpSchema {
  ok: true;
  path: string[];
  command: HelpCommand;
}

type ArgDef = {
  type?: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  alias?: string | string[];
};

type CommandLike = {
  meta?: { name?: string; description?: string; version?: string };
  args?: Record<string, ArgDef>;
  subCommands?: Record<string, CommandLike>;
};

/** Boolean flags that never take a value — do not consume the next token. */
const BOOLEAN_FLAGS = new Set(["--help", "-h", "--json", "--yes", "--version"]);

type WalkedHelp =
  | { path: string[]; command: CommandLike; name: string }
  | { error: "unknown_command"; message: string };

function hasPositionalArgs(cmd: CommandLike): boolean {
  return Object.values(cmd.args ?? {}).some((def) => def.type === "positional");
}

function unknownCommand(path: string[]): WalkedHelp {
  return {
    error: "unknown_command",
    message: `Unknown command \`${path.join(" ")}\`. Run creek --help --json for the schema.`,
  };
}

/**
 * Walk known `subCommands` from argv. Global flags, option values, and
 * positionals are not path segments — `creek env set KEY --help --json`
 * is `['env','set']`. A leftover token is a positional only when the
 * current command declares one; otherwise it is `unknown_command`.
 */
function walkSubcommands(root: CommandLike, rawArgs: string[]): WalkedHelp {
  let current = root;
  let name = current.meta?.name ?? "creek";
  const path: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const token = rawArgs[i]!;
    if (BOOLEAN_FLAGS.has(token)) continue;
    if (token.startsWith("-")) {
      // `--foo bar` (no `=`) — skip the value so it cannot be walked as a command.
      if (
        token.startsWith("--") &&
        !token.includes("=") &&
        i + 1 < rawArgs.length &&
        !rawArgs[i + 1]!.startsWith("-")
      ) {
        i++;
      }
      continue;
    }
    const child = current.subCommands?.[token];
    if (child) {
      current = child;
      path.push(token);
      name = current.meta?.name ?? token;
      continue;
    }
    // Leftover is a positional only when this command declares one.
    if (hasPositionalArgs(current)) break;
    return unknownCommand([...path, token]);
  }
  return { command: current, name, path };
}

export function walkCommand(cmd: unknown, fallbackName: string): HelpCommand {
  return walkCommandDef(cmd as CommandLike, fallbackName);
}

function walkCommandDef(cmd: CommandLike, fallbackName: string): HelpCommand {
  const argsDef = cmd.args ?? {};
  const args: HelpArg[] = Object.entries(argsDef).map(([argName, def]) => {
    const arg: HelpArg = { name: argName, type: def.type ?? "string" };
    if (def.description) arg.description = def.description;
    if (def.required === true) arg.required = true;
    if (def.default !== undefined) arg.default = def.default;
    if (def.alias !== undefined) arg.alias = def.alias;
    return arg;
  });
  const dryRun = Object.prototype.hasOwnProperty.call(argsDef, "dry-run");
  const subCommands = cmd.subCommands ?? {};
  const subcommands = Object.entries(subCommands).map(([n, child]) => walkCommandDef(child, n));
  const node: HelpCommand = {
    name: stripGlyph(cmd.meta?.name ?? fallbackName),
    args,
    dryRun,
    destructive: dryRun,
    subcommands,
  };
  if (cmd.meta?.description) node.description = cmd.meta.description;
  if (cmd.meta?.version) node.version = cmd.meta.version;
  return node;
}

export function buildHelpSchema(
  root: unknown,
  rawArgs: string[],
): HelpSchema | { ok: false; error: string; message: string } {
  const resolved = walkSubcommands(root as CommandLike, rawArgs);
  if ("error" in resolved) {
    return { ok: false, error: resolved.error, message: resolved.message };
  }
  return {
    ok: true,
    path: resolved.path,
    command: walkCommand(resolved.command, resolved.name),
  };
}

function stripGlyph(name: string): string {
  // Root meta is "⬡ creek"; agents should see "creek".
  return name.replace(/^[^\w]+/, "").trim() || name;
}
