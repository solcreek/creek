import consola from "consola";
import { TEMPLATES } from "./templates.js";

/**
 * Interactive template picker — used when no --template flag is given.
 */
export async function promptTemplate(): Promise<string> {
  // The first template in the list is the recommended default — the
  // select prompt pre-selects it. `vite-react-drizzle` is the flagship
  // portable-pattern example and should stay in slot 0.
  const choices = TEMPLATES.map((t, i) => ({
    label: i === 0 ? `${t.name} (recommended) — ${t.description}` : `${t.name} — ${t.description}`,
    value: t.name,
    hint: t.capabilities.length ? t.capabilities.join(", ") : undefined,
  }));

  const selected = await consola.prompt("Select a template:", {
    type: "select",
    options: choices,
  });

  // consola.prompt returns the value string for select type
  return selected as unknown as string;
}

/**
 * Prompt for project directory name.
 */
export async function promptDir(): Promise<string> {
  const dir = await consola.prompt("Project name:", {
    type: "text",
    default: "my-creek-app",
    placeholder: "my-creek-app",
  });

  return dir as unknown as string;
}
