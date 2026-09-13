import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * MCP resources are wrangler-bundled copies of skills/creek/references/.
 * `pnpm --filter @solcreek/mcp-server sync-refs` recopies them. This test
 * is the maintain loop: a stale copy fails CI instead of silently teaching
 * agents the wrong `creek deploy` invocation.
 */
const here = dirname(fileURLToPath(import.meta.url));
const skillDir = join(here, "../../../skills/creek/references");
const mcpDir = join(here, "../references");

describe("mcp-server references stay in sync with skills/", () => {
  it("has the same markdown files with identical contents", () => {
    const skillFiles = readdirSync(skillDir)
      .filter((f) => f.endsWith(".md"))
      .sort();
    const mcpFiles = readdirSync(mcpDir)
      .filter((f) => f.endsWith(".md"))
      .sort();
    expect(mcpFiles).toEqual(skillFiles);
    for (const f of skillFiles) {
      expect(readFileSync(join(mcpDir, f), "utf8"), f).toBe(
        readFileSync(join(skillDir, f), "utf8"),
      );
    }
  });
});
