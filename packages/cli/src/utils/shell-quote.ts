/**
 * Quote one word for a POSIX shell, for copy-pasteable commands in
 * breadcrumbs and hints. Words made only of safe characters stay as they
 * are; anything else is single-quoted (with embedded quotes escaped), so a
 * name like "my app" stays one argument.
 */
export function shellQuote(word: string): string {
  if (word !== "" && /^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}
