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
const KNOWN_MISSING = new Set([
  // Sandbox deploy status polling (deploy.ts is being edited elsewhere).
  "deploy.ts: deploy_failed",
  "deploy.ts: deploy_failed#2",
]);

/** utils/sandbox.ts helpers that call the sandbox API. */
const SANDBOX_CALLS = new Set(["sandboxDeploy", "pollSandboxStatus"]);

const REPORTS = new Set(["jsonOutput", "exitError"]);
const CLASSIFIES = /\b(apiErrorFields|exitApiFailure|apiCall)\b/;

/**
 * Whether `client` in the code around `node` is a CreekdClient: a self-host
 * daemon, not the Creek or sandbox API, with its own errors.
 */
function creekdClientInScope(node: ts.Node, source: ts.SourceFile): boolean {
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    if (ts.isFunctionLike(n) || ts.isSourceFile(n)) {
      const text = n.getText(source);
      if (/\bclient\b[^=\n;]*=\s*new CreekdClient\b|\bclient:\s*CreekdClient\b/.test(text))
        return true;
    }
  }
  return false;
}

function callsApi(node: ts.Node, source: ts.SourceFile): boolean {
  const creekd = creekdClientInScope(node, source);
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
        !creekd
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

function scan(): string[] {
  const found: string[] = [];
  for (const file of readdirSync(COMMANDS)) {
    if (!file.endsWith(".ts") || file.includes(".test.")) continue;
    const text = readFileSync(join(COMMANDS, file), "utf-8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const seen = new Map<string, number>();
    const visit = (n: ts.Node) => {
      if (ts.isTryStatement(n) && n.catchClause && callsApi(n.tryBlock, source)) {
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
  }
  return found;
}

describe("a command that reports a failed API call classifies it", () => {
  const found = scan();

  it("every catch that reports an API failure spreads apiErrorFields", () => {
    expect(found.filter((f) => !KNOWN_MISSING.has(f))).toEqual([]);
  });

  it("every allowlisted site still exists (delete the entry once fixed)", () => {
    expect([...KNOWN_MISSING].filter((k) => !found.includes(k))).toEqual([]);
  });
});
