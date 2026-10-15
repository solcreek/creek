import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

// A command that catches a failed Creek or sandbox API call and reports it
// itself must spread apiErrorFields (or go through apiCall / exitApiFailure):
// otherwise a network failure loses api_unreachable, reason, retryable and
// mayHaveApplied (utils/api-error.ts). This finds every `try` whose block
// calls the API (`client.<method>(…)`, `fetch(…)`, or a
// utils/sandbox.ts call) and whose `catch` prints
// a JSON error, and fails when that catch never uses apiErrorFields.
//
// Not flagged: calls on a CreekdClient (a self-host daemon, not a Creek or
// sandbox API), and a catch that only prints under an `instanceof` guard (a
// CreekdApiError, a 404) and rethrows the rest — the runner then classifies
// the network failure.

const COMMANDS = join(import.meta.dirname, "commands");

/**
 * Sites other agents own right now, as `file: error code` (the first error
 * code the catch prints). Fix the catch, then delete the line.
 */
const KNOWN_MISSING = new Set<string>([]);

/** utils/sandbox.ts helpers that call the sandbox API. */
const SANDBOX_CALLS = new Set(["sandboxDeploy", "pollSandboxStatus"]);

const REPORTS = new Set(["jsonOutput", "exitError"]);
const CLASSIFIES = /\b(apiErrorFields|exitApiFailure|apiCall)\b/;

/**
 * Parse one file into a program, so an identifier resolves to the binding in
 * scope where it is used. Imports stay unresolved (noResolve): only local
 * declarations matter here.
 */
function parse(name: string, text: string): { source: ts.SourceFile; checker: ts.TypeChecker } {
  const options: ts.CompilerOptions = { noResolve: true, noLib: true, types: [] };
  const host = ts.createCompilerHost(options);
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  host.getSourceFile = (f) => (f === name ? source : undefined);
  host.fileExists = (f) => f === name;
  host.readFile = (f) => (f === name ? text : undefined);
  const program = ts.createProgram([name], options, host);
  return { source: program.getSourceFile(name)!, checker: program.getTypeChecker() };
}

/**
 * Whether `id` (a `client`) is bound to a CreekdClient: a self-host daemon,
 * not the Creek or sandbox API, with its own errors. Decided by the
 * declaration that identifier resolves to — `new CreekdClient(…)`, or a
 * variable or parameter typed CreekdClient — not by text elsewhere in the
 * file, where another function may declare its own `client`.
 */
function isCreekdClient(id: ts.Identifier, checker: ts.TypeChecker): boolean {
  const decl = checker.getSymbolAtLocation(id)?.declarations?.[0];
  if (!decl || !(ts.isVariableDeclaration(decl) || ts.isParameter(decl))) return false;
  if (decl.type && /^CreekdClient\b/.test(decl.type.getText())) return true;
  const init = decl.initializer;
  return (
    !!init &&
    ts.isNewExpression(init) &&
    ts.isIdentifier(init.expression) &&
    init.expression.text === "CreekdClient"
  );
}

function callsApi(node: ts.Node, checker: ts.TypeChecker): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (ts.isIdentifier(callee) && (callee.text === "fetch" || SANDBOX_CALLS.has(callee.text)))
        found = true;
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "client" &&
        !isCreekdClient(callee.expression, checker)
      )
        found = true;
    }
    // A nested function is its own scope: its calls are not this try's.
    if (ts.isFunctionLike(n) && n !== node) return;
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** The first error code of a report the catch makes unguarded, or null. */
function unguardedReport(block: ts.Block, source: ts.SourceFile): string | null {
  let code: string | null = null;
  const visit = (n: ts.Node, guarded: boolean) => {
    if (code !== null) return;
    if (ts.isIfStatement(n) && /\binstanceof\b/.test(n.expression.getText(source))) {
      visit(n.expression, guarded);
      visit(n.thenStatement, true);
      if (n.elseStatement) visit(n.elseStatement, guarded);
      return;
    }
    if (
      !guarded &&
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      REPORTS.has(n.expression.text)
    ) {
      const text = n.getText(source);
      code = /error: "([^"]+)"/.exec(text)?.[1] ?? /"([a-z_]+)"/.exec(text)?.[1] ?? "?";
      return;
    }
    ts.forEachChild(n, (c) => visit(c, guarded));
  };
  visit(block, false);
  return code;
}

/** The catches in one command file that report an API failure unclassified. */
function scanFile(file: string, text: string): string[] {
  const found: string[] = [];
  const { source, checker } = parse(file, text);
  const seen = new Map<string, number>();
  const visit = (n: ts.Node) => {
    if (ts.isTryStatement(n) && n.catchClause && callsApi(n.tryBlock, checker)) {
      const block = n.catchClause.block;
      const code = unguardedReport(block, source);
      if (code !== null && !CLASSIFIES.test(block.getText(source))) {
        const count = (seen.get(code) ?? 0) + 1;
        seen.set(code, count);
        found.push(`${file}: ${code}${count > 1 ? `#${count}` : ""}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(source);
  return found;
}

function scan(): string[] {
  return readdirSync(COMMANDS)
    .filter((f) => f.endsWith(".ts") && !f.includes(".test."))
    .flatMap((f) => scanFile(f, readFileSync(join(COMMANDS, f), "utf-8")));
}

describe("a command that reports a failed API call classifies it", () => {
  const found = scan();

  it("every catch that reports an API failure spreads apiErrorFields", () => {
    expect(found.filter((f) => !KNOWN_MISSING.has(f))).toEqual([]);
  });

  // A file that declares a CreekdClient `client` in one function and a
  // CreekClient `client` in another: each call is judged by its own binding.
  it.each([
    ["logs.ts", "logs_failed"],
    ["rollback.ts", "rollback_failed"],
  ])(
    "catches %s's cloud catch without apiErrorFields, despite its CreekdClient elsewhere",
    (file, code) => {
      const text = readFileSync(join(COMMANDS, file), "utf-8");
      expect(text).toMatch(/new CreekdClient\(/);
      const at = text.indexOf(`error: "${code}"`);
      expect(at).toBeGreaterThan(-1);
      const spread = text.indexOf("...apiErrorFields(err)", at);
      expect(spread).toBeGreaterThan(-1);
      const stripped = text.slice(0, spread) + text.slice(spread + "...apiErrorFields(err)".length);
      expect(scanFile(file, text)).toEqual([]);
      expect(scanFile(file, stripped)).toEqual([`${file}: ${code}`]);
    },
  );

  it("does not flag calls on a CreekdClient bound in scope", () => {
    const text = `
      async function f() {
        const client = new CreekdClient(url);
        try { await client.listApps(); }
        catch (err) { jsonOutput({ ok: false, error: "unreachable", message: "m" }, 1); }
      }`;
    expect(scanFile("x.ts", text)).toEqual([]);
    expect(
      scanFile("x.ts", text.replace("new CreekdClient(url)", "new CreekClient(url, t)")),
    ).toEqual(["x.ts: unreachable"]);
  });

  it("every allowlisted site still exists (delete the entry once fixed)", () => {
    expect([...KNOWN_MISSING].filter((k) => !found.includes(k))).toEqual([]);
  });
});
