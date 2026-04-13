/**
 * Post-deploy UI hints — small pieces of metadata Creek emits alongside
 * a successful deploy so the preview page can guide the user to
 * framework-specific next steps.
 *
 * Kept deliberately lightweight:
 *   - no build-time effects
 *   - no runtime effects on the deployed Worker
 *   - pure UI copy + URL helpers
 *
 * If a framework needs deeper integration (SSR bundle layout, adapter
 * injection, DB migrations, etc.), that belongs in the specific
 * detection helpers (`getSSRServerDir`, `detectAstroCloudflareBuild`,
 * etc.) or in dedicated build-pipeline logic. Hints are the **shallow**
 * layer: "you deployed X, here's where to click next."
 *
 * When we accumulate 3+ frameworks needing hints, revisit whether a
 * generic profile registry is warranted. Today (2026-04-12) EmDash is
 * the first.
 */

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface DeployHint {
  /** Absolute path on the deployed site that takes the user to the admin/setup UI. */
  adminPath?: string;
  /** Short label for the admin CTA. */
  adminLabel?: string;
  /** Zero or more warnings/explanations shown alongside the CTA. */
  warnings?: string[];
}

/**
 * EmDash is an Astro-based CMS (https://emdashcms.com). Schema
 * migrations run automatically on first request to the deployed
 * Worker — no setup step needed. But the **seed content** (pages,
 * posts, settings from `seed/seed.json`) is deliberately opt-in:
 * EmDash doesn't assume the user wants the demo content.
 *
 * That means a fresh deploy has a fully working admin at
 * `/_emdash/admin` but `/` shows a 404 loop until the user either:
 *   - runs `emdash seed seed/seed.json` locally against a remote D1, OR
 *   - creates their first page through the admin UI.
 *
 * Surface both the admin link and an honest one-liner so users aren't
 * surprised.
 */
export function detectEmdash(pkg: PackageJson): DeployHint | null {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const hasEmdash =
    "emdash" in deps ||
    Object.keys(deps).some((k) => k.startsWith("@emdash-cms/"));
  if (!hasEmdash) return null;
  return {
    adminPath: "/_emdash/admin",
    adminLabel: "Set up your CMS",
    warnings: [
      "The site root will 404 until you create your first page. Open the admin to start.",
    ],
  };
}

/**
 * Resolve a deploy hint from the target's package.json. Returns the
 * first matching framework's hint, or null when nothing matches.
 * Detection order runs most-specific first so, e.g., EmDash wins over
 * plain Astro.
 */
export function resolveDeployHint(pkg: PackageJson): DeployHint | null {
  return detectEmdash(pkg);
  // Add further detectors here when more frameworks ship hints.
}
