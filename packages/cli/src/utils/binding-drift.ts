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
 * The control-plane binds a provisioned server-side attachment at deploy time,
 * but it lives outside the local config — a fresh clone or a teammate wouldn't
 * recreate it. Surfacing the drift flags that reproducibility gap (declare it
 * in config, or detach).
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

/**
 * One-line human summary, e.g. `SESSIONS (cache), DATA (database)`.
 * `kind` is the semantic resource kind from the API (database/storage/cache/ai),
 * not the CF-native type.
 */
export function formatBindingDrift(drift: BindingDrift[]): string {
  return drift.map((b) => `${b.bindingName} (${b.kind})`).join(", ");
}
