export interface BindingDrift {
  bindingName: string;
  kind: string;
}

/** Minimal client surface needed here — keeps the helper unit-testable. */
export interface BindingClient {
  listBindings(projectSlug: string): Promise<{
    bindings: Array<{ bindingName: string; kind: string }>;
  }>;
}

/**
 * Resource bindings attached to a project server-side (via
 * `creek db/cache/storage attach`) whose names aren't declared in the local
 * config.
 *
 * Deploy derives the worker's bindings from creek.toml, not from server-side
 * attachments, so an attached-but-undeclared binding never reaches the
 * deployed worker — `env.X` is silently undefined at runtime with no error.
 * Surfacing the drift turns that silent failure into an actionable warning.
 *
 * Best-effort: returns `[]` on any lookup error so it never blocks a deploy
 * or status check.
 */
export async function findUndeclaredBindings(
  client: BindingClient,
  projectSlug: string,
  declaredBindingNames: string[],
): Promise<BindingDrift[]> {
  try {
    const { bindings } = await client.listBindings(projectSlug);
    const declared = new Set(declaredBindingNames);
    return bindings
      .filter((b) => !declared.has(b.bindingName))
      .map((b) => ({ bindingName: b.bindingName, kind: b.kind }));
  } catch {
    return [];
  }
}

/** One-line human summary, e.g. `SESSIONS (kv), CACHE (kv)`. */
export function formatBindingDrift(drift: BindingDrift[]): string {
  return drift.map((b) => `${b.bindingName} (${b.kind})`).join(", ");
}
