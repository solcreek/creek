// Reads the pricing page from disk, so it needs Node's fs; excluded from the
// package's Workers-typed `tsc` (see tsconfig.json) and run by vitest only.
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PLANS } from "./parse.js";

describe("PLANS", () => {
  // Regression: Starter was added to the pricing page without limits here.
  // Read the page itself, so a tier added there fails this test until it is
  // added to PLANS (and so PLAN_LIMITS), in the page's upgrade order.
  test("matches the tiers on the pricing page, in order", () => {
    const page = readFileSync(
      fileURLToPath(new URL("../../../apps/www/src/app/pricing/page.tsx", import.meta.url)),
      "utf8",
    );
    const tiersBlock = page.match(/const tiers = \[([\s\S]*?)\n\];/)?.[1];
    expect(tiersBlock, "pricing page no longer declares `const tiers = [...]`").toBeDefined();
    const pageTiers = [...tiersBlock!.matchAll(/^ {4}name: "([^"]+)",$/gm)].map((m) =>
      m[1]!.toLowerCase(),
    );
    expect(pageTiers.length).toBeGreaterThan(0);
    expect(pageTiers).toEqual([...PLANS]);
  });
});
