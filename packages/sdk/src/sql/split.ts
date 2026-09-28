/**
 * Split SQL text into statements on the `;` that actually end them.
 *
 * A `;` ends a statement only in code: not inside a `--` line comment, a
 * `/* *\/` block comment, a single-quoted string (with `''` escapes), or a
 * `"…"`, `` `…` `` or `[…]` quoted identifier, and not inside the body of a
 * `CREATE [TEMP] TRIGGER … BEGIN … END`, whose inner statements end with `;`
 * too. Migration and seed files routinely have semicolons in comments and
 * string literals; splitting on every `;` sends D1 broken fragments
 * (solcreek/creek#71).
 *
 * Each statement is returned trimmed, starting at its first token (leading
 * comments dropped), without its terminating `;`. Fragments that hold only
 * comments or whitespace are dropped. An unterminated string or comment runs
 * to the end of the input.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  const n = sql.length;
  let i = 0;
  // Start of the current statement's first token, or -1 before one is seen.
  let codeStart = -1;
  // Leading keywords of the current statement, to recognise CREATE TRIGGER.
  let words: string[] = [];
  let isTrigger = false;
  let depth = 0;

  const markCode = (at: number) => {
    if (codeStart === -1) codeStart = at;
  };
  const endStatement = (at: number) => {
    if (codeStart !== -1) {
      const text = sql.slice(codeStart, at).trim();
      if (text) statements.push(text);
    }
    codeStart = -1;
    words = [];
    isTrigger = false;
    depth = 0;
  };

  while (i < n) {
    const c = sql[i];

    if (c === "-" && sql[i + 1] === "-") {
      const eol = sql.indexOf("\n", i);
      i = eol === -1 ? n : eol + 1;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const close = sql.indexOf("*/", i + 2);
      i = close === -1 ? n : close + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      markCode(i);
      const quote = c === "[" ? "]" : c;
      i++;
      while (i < n) {
        if (sql[i] === quote) {
          // A doubled quote is an escaped quote, not the end ('' or "").
          if (quote !== "]" && sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === ";") {
      if (isTrigger && depth > 0) {
        i++; // a statement inside the trigger body
        continue;
      }
      endStatement(i);
      i++;
      continue;
    }
    if (isWordStart(c)) {
      markCode(i);
      let j = i + 1;
      while (j < n && isWordPart(sql[j])) j++;
      const word = sql.slice(i, j).toUpperCase();
      if (words.length < 3) {
        words.push(word);
        isTrigger =
          words[0] === "CREATE" &&
          (words[1] === "TRIGGER" ||
            ((words[1] === "TEMP" || words[1] === "TEMPORARY") && words[2] === "TRIGGER"));
      }
      if (isTrigger) {
        if (word === "BEGIN" || word === "CASE") depth++;
        else if (word === "END") depth--;
      }
      i = j;
      continue;
    }
    if (!isSpace(c)) markCode(i);
    i++;
  }
  endStatement(n);
  return statements;
}

function isWordStart(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
}

function isWordPart(c: string): boolean {
  return isWordStart(c) || (c >= "0" && c <= "9") || c === "$";
}

function isSpace(c: string): boolean {
  return c === " " || c === "\n" || c === "\t" || c === "\r" || c === "\f" || c === "\v";
}
