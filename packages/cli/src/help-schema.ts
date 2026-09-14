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

export function helpPath(rawArgs: string[]): string[] {
  return rawArgs.filter((a) => !a.startsWith("-"));
}

export function resolveHelpCommand(
  root: unknown,
  path: string[],
): { command: CommandLike; name: string } | { error: "unknown_command"; message: string } {
  const asCmd = (value: unknown): CommandLike => value as CommandLike;
  let current = asCmd(root);
  let name = current.meta?.name ?? "creek";
  for (const segment of path) {
    const child = current.subCommands?.[segment];
    if (!child) {
      return {
        error: "unknown_command",
        message: `Unknown command \`${path.join(" ")}\`. Run creek --help --json for the schema.`,
      };
    }
    current = asCmd(child);
    name = current.meta?.name ?? segment;
  }
  return { command: current, name };
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
  const path = helpPath(rawArgs);
  const resolved = resolveHelpCommand(root, path);
  if ("error" in resolved) {
    return { ok: false, error: resolved.error, message: resolved.message };
  }
  return {
    ok: true,
    path,
    command: walkCommand(resolved.command, resolved.name),
  };
}

function stripGlyph(name: string): string {
  // Root meta is "⬡ creek"; agents should see "creek".
  return name.replace(/^[^\w]+/, "").trim() || name;
}
