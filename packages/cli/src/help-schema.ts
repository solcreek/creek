/**
 * Machine-readable `creek --help --json` schema, derived from the citty
 * command definitions:
 *
 * - `destructive` is the command's own `meta.destructive`, set by hand in
 *   its definition (see `CommandMeta` below). It is not inferred.
 * - `dryRun` is whether the command declares `--dry-run`.
 * - A command registered under several names (`env rm` / `env unset`) is
 *   listed once, under its `meta.name`, with the other names as `aliases`.
 * - An arg's `enum` (its allowed values) comes from the arg definition.
 */

declare module "citty" {
  interface CommandMeta {
    /**
     * Whether running the command may delete or overwrite existing data,
     * or change what is live (deploy to production, roll back, stop an
     * app): what an agent should confirm first. Additive and read-only
     * commands are `false`. Every runnable command sets it; the help
     * schema test checks each against a reviewed list.
     */
    destructive?: boolean;
  }
}

export interface HelpArg {
  name: string;
  type: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  alias?: string | string[];
  /** The values the arg accepts, when it accepts only a fixed set. */
  enum?: string[];
}

export interface HelpCommand {
  name: string;
  description?: string;
  version?: string;
  /** Other names that run this same command (`unset` for `env rm`). */
  aliases?: string[];
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
  /** Allowed values. citty does not read it; the command validates. */
  enum?: readonly string[];
};

type CommandLike = {
  meta?: { name?: string; description?: string; version?: string; destructive?: boolean };
  args?: Record<string, ArgDef>;
  subCommands?: Record<string, CommandLike>;
  run?: unknown;
};

/** Boolean flags that never take a value — do not consume the next token. */
const BOOLEAN_FLAGS = new Set(["--help", "-h", "--json", "--yes", "-y", "--version"]);

/**
 * Runner-level flags only. `--yes` / `-y` are NOT here: they are accepted
 * only when the leaf command spreads `globalArgs` (via `flagTokensForArg`).
 * Putting them in this set would let citty/mri drop `--yes` on a command
 * that never declared it — the silent-flag hole this check exists to close.
 */
const GLOBAL_FLAG_TOKENS = new Set(["--help", "-h", "--json", "--version"]);

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

/**
 * `meta.destructive` as the command set it. A runnable command that never
 * set it reads as destructive, so an unreviewed command errs toward a
 * confirmation; a group that only holds subcommands runs nothing.
 */
export function isDestructive(cmd: unknown): boolean {
  const c = cmd as CommandLike;
  if (typeof c.meta?.destructive === "boolean") return c.meta.destructive;
  return typeof c.run === "function";
}

/**
 * Subcommands with each command object once: under the key that matches
 * its `meta.name` (else its first key), the other keys as aliases.
 */
function groupAliases(
  subCommands: Record<string, CommandLike>,
): { key: string; command: CommandLike; aliases: string[] }[] {
  const byCommand = new Map<CommandLike, string[]>();
  for (const [key, child] of Object.entries(subCommands)) {
    const keys = byCommand.get(child);
    if (keys) keys.push(key);
    else byCommand.set(child, [key]);
  }
  return [...byCommand].map(([command, keys]) => {
    const key = keys.find((k) => k === command.meta?.name) ?? keys[0]!;
    return { key, command, aliases: keys.filter((k) => k !== key) };
  });
}

function walkCommandDef(cmd: CommandLike, fallbackName: string): HelpCommand {
  const argsDef = cmd.args ?? {};
  const args: HelpArg[] = Object.entries(argsDef).map(([argName, def]) => {
    const arg: HelpArg = { name: argName, type: def.type ?? "string" };
    if (def.description) arg.description = def.description;
    if (def.required === true) arg.required = true;
    if (def.default !== undefined) arg.default = def.default;
    if (def.alias !== undefined) arg.alias = def.alias;
    if (def.enum) arg.enum = [...def.enum];
    return arg;
  });
  const dryRun = Object.prototype.hasOwnProperty.call(argsDef, "dry-run");
  const subcommands = groupAliases(cmd.subCommands ?? {}).map(({ key, command, aliases }) => {
    const node = walkCommandDef(command, key);
    if (aliases.length > 0) node.aliases = aliases;
    return node;
  });
  const node: HelpCommand = {
    name: stripGlyph(cmd.meta?.name ?? fallbackName),
    args,
    dryRun,
    destructive: isDestructive(cmd),
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

function flagTokensForArg(name: string, def: ArgDef): string[] {
  const tokens = [`--${name}`];
  if (def.type === "boolean" || def.type === undefined) {
    tokens.push(`--no-${name}`);
  }
  const aliases = def.alias == null ? [] : Array.isArray(def.alias) ? def.alias : [def.alias];
  for (const alias of aliases) {
    if (alias.length === 1) tokens.push(`-${alias}`);
    else if (alias.startsWith("-")) tokens.push(alias);
    else tokens.push(`--${alias}`);
  }
  return tokens;
}

function declaredFlagTokens(cmd: CommandLike): Set<string> {
  const tokens = new Set(GLOBAL_FLAG_TOKENS);
  for (const [name, def] of Object.entries(cmd.args ?? {})) {
    if (def.type === "positional") continue;
    for (const token of flagTokensForArg(name, def)) tokens.add(token);
  }
  return tokens;
}

/**
 * Flags on argv that the resolved command did not declare.
 *
 * citty/mri silently drops unknown flags. Older CLIs therefore treated
 * `creek rollback --dry-run` as `creek rollback` and mutated production.
 * Refuse instead — agents must not confuse an ignored preview flag with a plan.
 */
export function findUnknownFlags(root: unknown, rawArgs: string[]): string[] {
  const resolved = walkSubcommands(root as CommandLike, rawArgs);
  if ("error" in resolved) return [];
  const declared = declaredFlagTokens(resolved.command);
  const unknown: string[] = [];
  for (const token of rawArgs) {
    if (token === "--") break;
    if (!token.startsWith("-") || token === "-") continue;
    const flag = token.split("=")[0]!;
    if (!declared.has(flag) && !unknown.includes(flag)) unknown.push(flag);
  }
  return unknown;
}

export function unknownFlagMessage(flags: string[], path: string[]): string {
  const shown = flags.map((f) => `\`${f}\``).join(", ");
  const cmd = ["creek", ...path].join(" ") || "creek";
  const dryRun = flags.includes("--dry-run");
  if (dryRun) {
    return (
      `Unknown flag ${shown}. ${cmd} does not support --dry-run ` +
      `(commands that do report dryRun: true in --help --json). ` +
      `Older CLIs silently dropped --dry-run and could execute the mutation.`
    );
  }
  return `Unknown flag ${shown}. Run \`${cmd} --help --json\` for the accepted args.`;
}

function stripGlyph(name: string): string {
  // Root meta is "⬡ creek"; agents should see "creek".
  return name.replace(/^[^\w]+/, "").trim() || name;
}
