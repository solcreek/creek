/**
 * Which uploaded server file is the worker's main module.
 *
 * A bundle names it in `manifest.mainModule` when the client knows it (a
 * framework build output records its entry; Creek's own bundling names its
 * output `worker.js`). That declaration is authoritative: the file must be
 * among the uploaded modules, or the deploy fails rather than run another
 * module as the entry.
 *
 * Bundles without one — from clients that predate the field — keep the
 * name-based guess: the first uploaded file, in upload order, with one of
 * these names, else the first file. Both deploy paths share this list; the
 * control-plane's own copy lacked `entry.mjs` (Astro's adapter entry).
 *
 * `manifest.entrypoint` is not used: clients send the user's source entry
 * there (e.g. `worker/index.ts`), not the name of an uploaded module.
 */

export const GUESSED_MAIN_MODULES = [
  "worker.js",
  "server.js",
  "index.js",
  "index.mjs",
  "entry.mjs",
] as const;

export class MainModuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MainModuleError";
  }
}

/**
 * The problem with a declared main module, or null when it is usable (or
 * none is declared). Request handlers call this to reject a bundle up front.
 */
export function mainModuleProblem(
  serverFileNames: string[],
  declared: string | null | undefined,
): string | null {
  if (declared === undefined || declared === null) return null;
  if (typeof declared !== "string" || declared.length === 0) {
    return "manifest.mainModule must be a non-empty string";
  }
  if (!serverFileNames.includes(declared)) {
    return `manifest.mainModule "${declared}" is not one of the uploaded server files`;
  }
  return null;
}

/** The main module for a worker made of `serverFileNames`, in upload order. */
export function selectMainModule(serverFileNames: string[], declared?: string | null): string {
  const problem = mainModuleProblem(serverFileNames, declared);
  if (problem) throw new MainModuleError(problem);
  if (declared) return declared;
  return (
    serverFileNames.find((n) => (GUESSED_MAIN_MODULES as readonly string[]).includes(n)) ??
    serverFileNames[0]
  );
}
