/**
 * Built-in template catalog — each entry maps to a real project in
 * this monorepo's `examples/` directory. If an entry here can't be
 * scaffolded + deployed, the catalog is wrong.
 *
 * Replaced a 25-entry aspirational catalog with only templates that
 * actually exist as tested code, per the "templates are real starter
 * code, not form-fill Mad Libs" principle. New entries land here only
 * after the example passes `creek doctor` cleanly and has
 * local-dev/deploy-creek docs.
 *
 * Third-party templates (`--template github:user/repo`) bypass this
 * catalog via fetch.ts:isThirdParty. The catalog is just the
 * discoverable-via-prompt set.
 *
 * Gallery at templates.creek.dev aggregates this list + curated
 * community templates, but that layer lives outside the CLI.
 */

export interface Template {
  name: string;
  description: string;
  type: "site" | "app" | "workflow" | "connector" | "developer";
  capabilities: string[];
  trigger?: string;
}

export const TEMPLATES: Template[] = [
  // Flagship full-stack portable example. Dual-driver Drizzle:
  // better-sqlite3 locally, D1 on Workers. Zero @solcreek/* in runtime.
  {
    name: "vite-react-drizzle",
    description: "Vite + React + Hono + Drizzle — portable full-stack todo (D1)",
    type: "app",
    capabilities: ["database"],
  },
  // Minimal Vite + React SPA. Starting point for anyone who just
  // wants a static app on the edge.
  {
    name: "vite-react",
    description: "Vite + React — minimal SPA starter",
    type: "site",
    capabilities: [],
  },
  // TanStack Start SSR on Workers. Real framework-backed template.
  {
    name: "tanstack-start-ssr",
    description: "TanStack Start with SSR on Cloudflare Workers",
    type: "app",
    capabilities: [],
  },
];

export type TemplateName = (typeof TEMPLATES)[number]["name"];
export type TemplateType = Template["type"];
