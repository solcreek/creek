import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { defineCommand } from "citty";
import { findUnknownFlags } from "./help-schema.js";
import { loginCommand } from "./commands/login.js";
import { whoamiCommand } from "./commands/whoami.js";
import { initCommand } from "./commands/init.js";
import { deployCommand } from "./commands/deploy.js";
import { claimCommand } from "./commands/claim.js";
import { envCommand } from "./commands/env.js";
import { domainsCommand } from "./commands/domains.js";
import { projectsCommand } from "./commands/projects.js";
import { deploymentsCommand } from "./commands/deployments.js";
import { statusCommand } from "./commands/status.js";
import { devCommand } from "./commands/dev.js";
import { rollbackCommand } from "./commands/rollback.js";
import { opsCommand } from "./commands/ops.js";
import { queueCommand } from "./commands/queue.js";
import { logsCommand } from "./commands/logs.js";
import { metricsCommand } from "./commands/metrics.js";
import { doctorCommand } from "./commands/doctor.js";
import { verifyCommand } from "./commands/verify.js";
import { dbCommand } from "./commands/db.js";
import { storageCommand } from "./commands/storage.js";
import { cacheCommand } from "./commands/cache.js";
import { topCommand } from "./commands/top.js";
import { restartCommand } from "./commands/restart.js";
import { stopCommand } from "./commands/stop.js";
import { dashboardCommand } from "./commands/dashboard.js";

// A breadcrumb, nextStep or hint is a command an agent pastes and runs. One
// that names a flag the command does not declare fails with unknown_flag (or,
// on an older CLI, has its flag silently dropped). This scans every string
// the CLI can print for `creek <command> …`, resolves the command against the
// real citty tree, and checks each flag is one that command declares.

// The tree index.ts runs (index.ts runs the CLI on import, so it is rebuilt
// here; a test below keeps the two in step).
const SUBCOMMANDS = {
  dev: devCommand,
  deploy: deployCommand,
  status: statusCommand,
  projects: projectsCommand,
  deployments: deploymentsCommand,
  logs: logsCommand,
  metrics: metricsCommand,
  doctor: doctorCommand,
  verify: verifyCommand,
  login: loginCommand,
  whoami: whoamiCommand,
  init: initCommand,
  claim: claimCommand,
  env: envCommand,
  queue: queueCommand,
  db: dbCommand,
  storage: storageCommand,
  cache: cacheCommand,
  domains: domainsCommand,
  rollback: rollbackCommand,
  top: topCommand,
  dashboard: dashboardCommand,
  restart: restartCommand,
  stop: stopCommand,
  ops: opsCommand,
};
const main = defineCommand({ meta: { name: "creek" }, subCommands: SUBCOMMANDS });

/**
 * Bad breadcrumbs in files other agents own right now. Each entry is
 * `file: command`, exactly as reported; fix the string, then delete the line.
 */
const KNOWN_BAD = new Set<string>([
  // `creek top` takes no app: the name is ignored (deploy --host breadcrumbs).
  "commands/deploy.ts: creek top VALUE",
  // `creek deploy` has no --host (init --adopt's next step).
  "commands/init.ts: creek deploy --host VALUE",
]);

const SRC = import.meta.dirname;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const path = join(dir, f);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return f.endsWith(".ts") && !/\.test(-d)?\.ts$/.test(f) ? [path] : [];
  });
}

/** A placeholder for an interpolated value: one opaque token. */
const VALUE = "VALUE";

/**
 * Every string the source can produce, as text, with each `${…}` replaced by
 * VALUE. The flag fragments an interpolation adds (`${pf}` is
 * ` --project x`; `${dry ? " --dry-run" : ""}`) are string literals inside
 * it: those starting with `--` are appended, so the flags they add are checked.
 */
function literals(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf-8"), ts.ScriptTarget.Latest);
  const out: string[] = [];
  const flagFragments = (node: ts.Node): string[] => {
    const found: string[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
        if (/^\s*--[a-z]/.test(n.text)) found.push(n.text.trim());
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    return found;
  };
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      out.push(node.text);
    } else if (ts.isTemplateExpression(node)) {
      let text = node.head.text;
      const extra: string[] = [];
      for (const span of node.templateSpans) {
        // `ls${pf}` is a suffix (its flags come from flagFragments); `rollback
        // ${id}` is a value.
        text += (text === "" || /\s$/.test(text) ? VALUE : "") + span.literal.text;
        extra.push(...flagFragments(span.expression));
      }
      out.push([text, ...extra].join(" "));
      // Nested templates are their own strings too.
      for (const span of node.templateSpans) visit(span.expression);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/**
 * The `creek …` commands in a string: the whole string when it is one (a
 * breadcrumb, a nextStep, a help line), and each one quoted in prose
 * (`Run \`creek login\` first.`). Unquoted prose ("Show creek top alongside")
 * is not a command. A command ends at a backtick, a line break, `&&`, or the
 * column gap before a help line's description.
 */
function commandsIn(text: string): string[] {
  const end = (s: string) => s.split(/`|\n| && |\s{2,}/)[0]!.trim();
  const found: string[] = [];
  // A help line may lead with a tree glyph or bullet (`└─ creek logs …`).
  const whole = text.replace(/^[\s└─•*-]*/, "");
  if (/^creek [a-z]/.test(whole)) found.push(end(whole));
  for (const m of text.matchAll(/`(creek [a-z][^`]*)`/g)) found.push(end(m[1]!));
  return [...new Set(found)];
}

/** Shell-ish split that keeps a quoted argument as one token. */
function tokens(command: string): string[] {
  return (command.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).slice(1);
}

type CommandLike = {
  args?: Record<string, { type?: string }>;
  subCommands?: Record<string, CommandLike>;
};

/**
 * Commands that take a bare positional through `args._` rather than a
 * declared positional (`creek db migrate <name>`: see db.ts).
 */
const POSITIONAL_FROM_ARGS = new Set(["db migrate"]);

interface Problem {
  where: string;
  command: string;
  problem: string;
}

function check(where: string, command: string): Problem | null {
  const argv = tokens(command);
  // Only the leading words name the command.
  if (!(argv[0]! in SUBCOMMANDS)) return null;
  let leaf = main as CommandLike;
  const path: string[] = [];
  while (argv.length > 0 && leaf.subCommands?.[argv[0]!]) {
    path.push(argv[0]!);
    leaf = leaf.subCommands[argv.shift()!]!;
  }
  const name = path.join(" ");
  const flags: string[] = [];
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("-") || token === "-" || /^-\d/.test(token)) {
      positionals.push(token);
      continue;
    }
    flags.push(token);
    const def = leaf.args?.[token.replace(/^--(no-)?/, "").split("=")[0]!];
    // A string flag's value is the next token, not a positional.
    if (def && def.type !== "boolean" && !token.includes("=")) i++;
  }
  const unknown = findUnknownFlags(main, [...path, ...flags]);
  if (unknown.length > 0)
    return { where, command, problem: `${name} has no ${unknown.join(", ")}` };
  const takesPositional =
    Object.values(leaf.args ?? {}).some((d) => d.type === "positional") ||
    POSITIONAL_FROM_ARGS.has(name);
  if (positionals.length > 0 && !takesPositional) {
    const sub = leaf.subCommands
      ? ` (subcommands: ${Object.keys(leaf.subCommands).join(", ")})`
      : "";
    return { where, command, problem: `${name} takes no positional ${positionals[0]}${sub}` };
  }
  return null;
}

function scan(): Problem[] {
  const problems: Problem[] = [];
  for (const file of sourceFiles(SRC)) {
    const where = relative(SRC, file);
    for (const text of literals(file)) {
      for (const command of commandsIn(text)) {
        const problem = check(where, command);
        if (problem && !KNOWN_BAD.has(`${where}: ${command}`)) problems.push(problem);
      }
    }
  }
  return problems;
}

/** Every flag token a command or any of its subcommands declares. */
function declaredFlags(cmd: CommandLike): Set<string> {
  const flags = new Set(["--help", "--json", "--version"]);
  const visit = (c: CommandLike) => {
    for (const [name, def] of Object.entries(c.args ?? {})) {
      if (def.type !== "positional") flags.add(`--${name}`).add(`--no-${name}`);
    }
    for (const child of Object.values(c.subCommands ?? {})) visit(child);
  };
  visit(cmd);
  return flags;
}

/**
 * A hint in prose ("use --deployment for …") names a flag of the command
 * printing it. In commands/<name>.ts, every `--flag` a string mentions outside
 * a `creek …` command must be one `creek <name>` (or a subcommand) declares.
 */
function scanProse(): Problem[] {
  const problems: Problem[] = [];
  for (const [name, cmd] of Object.entries(SUBCOMMANDS)) {
    const file = join(SRC, "commands", `${name}.ts`);
    const declared = declaredFlags(cmd as CommandLike);
    for (const text of literals(file)) {
      // A bare flag is an argv element, and another program's command line
      // (`git status --porcelain`) takes that program's flags: not hints.
      if (/^--[\w-]+(=\S*)?$/.test(text) || OTHER_PROGRAM.test(text)) continue;
      let prose = text;
      for (const command of commandsIn(text)) prose = prose.split(command).join(" ");
      for (const m of prose.matchAll(/(?:^|[\s(`'"])(--[a-z][\w-]*)/g)) {
        const flag = m[1]!;
        const key = `commands/${name}.ts: ${flag}`;
        if (!declared.has(flag) && !KNOWN_PROSE.has(key)) {
          problems.push({ where: `commands/${name}.ts`, command: text, problem: `no ${flag}` });
        }
      }
    }
  }
  return problems;
}

/** A string that runs, or names, another program's command line. */
const OTHER_PROGRAM = /(^|: )(git|npx|npm|pnpm|yarn|bun|node|next|wrangler) /;

/**
 * Flags a command's strings name that are not its own and that OTHER_PROGRAM
 * does not catch. `file: --flag`.
 */
const KNOWN_PROSE = new Set<string>([]);

describe("breadcrumbs name only flags their command declares", () => {
  it("every `creek …` command the CLI can print parses against the command tree", () => {
    expect(scan()).toEqual([]);
  });

  it("a hint in prose names only flags of the command printing it", () => {
    expect(scanProse()).toEqual([]);
  });

  it("finds a bad breadcrumb (the scanner works)", () => {
    expect(check("x", "creek rollback --deployment VALUE --json")).toMatchObject({
      problem: "rollback has no --deployment",
    });
    expect(check("x", "creek env ls --project VALUE --json")).toBeNull();
    expect(check("x", "creek bogus")).toBeNull();
    expect(check("x", "creek logs VALUE")).toMatchObject({
      problem: "logs takes no positional VALUE",
    });
    expect(check("x", "creek db migrate VALUE --dry-run")).toBeNull();
    expect(commandsIn("Show creek top alongside the dev server")).toEqual([]);
    expect(commandsIn("    creek dev        Local development")).toEqual(["creek dev"]);
    expect(commandsIn("Run `creek login --token <KEY>` first.")).toEqual([
      "creek login --token <KEY>",
    ]);
  });

  it("the tree above is the one index.ts runs", () => {
    const index = readFileSync(join(SRC, "index.ts"), "utf-8");
    const block = index.slice(index.indexOf("subCommands: {"));
    const names = [...block.slice(0, block.indexOf("}")).matchAll(/^\s+(\w+): \w+,$/gm)].map(
      (m) => m[1],
    );
    expect(names.sort()).toEqual(Object.keys(SUBCOMMANDS).sort());
  });
});
