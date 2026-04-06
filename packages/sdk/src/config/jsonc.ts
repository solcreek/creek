/**
 * Strip JSONC comments and trailing commas to produce valid JSON.
 * Uses a character-by-character state machine so comments inside strings are preserved.
 */
export function stripJsoncComments(input: string): string {
  let result = "";
  let i = 0;
  let inString = false;
  let escaped = false;

  while (i < input.length) {
    const ch = input[i];
    const next = input[i + 1];

    // Inside a string — only track escapes and string end
    if (inString) {
      if (escaped) {
        escaped = false;
        result += ch;
        i++;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        result += ch;
        i++;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      result += ch;
      i++;
      continue;
    }

    // Outside a string

    // Line comment: // → skip to end of line
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < input.length && input[i] !== "\n") i++;
      continue;
    }

    // Block comment: /* */ → skip to closing */
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i += 2; // skip */
      continue;
    }

    // String start
    if (ch === '"') {
      inString = true;
      result += ch;
      i++;
      continue;
    }

    result += ch;
    i++;
  }

  // Strip trailing commas before } or ] (JSONC allows them, JSON doesn't)
  return result.replace(/,(\s*[}\]])/g, "$1");
}
