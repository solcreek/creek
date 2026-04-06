/**
 * Fix standalone output path for pnpm monorepo + Next.js 16 + @opennextjs/cloudflare.
 *
 * When outputFileTracingRoot points to the monorepo root, Next.js outputs
 * standalone files to .next/standalone/{relative-app-path}/.next/ instead of
 * .next/standalone/.next/. This breaks @opennextjs/aws's createCacheAssets
 * which hardcodes .next/standalone/.next/.
 *
 * This script moves the shifted path to where opennext expects it.
 *
 * Related issues:
 * - https://github.com/vercel/next.js/issues/88579
 * - https://github.com/opennextjs/opennextjs-cloudflare/issues/569
 */

import { existsSync, cpSync, rmSync } from "node:fs";
import { join, relative } from "node:path";

const appDir = process.cwd();
const standaloneDir = join(appDir, ".next/standalone");

if (!existsSync(standaloneDir)) {
  console.log("[fix-standalone-path] No .next/standalone/ found, skipping");
  process.exit(0);
}

// Find the shifted .next directory
// In monorepo: .next/standalone/apps/www/.next/ (relative path from monorepo root)
const expectedDotNext = join(standaloneDir, ".next");
if (existsSync(expectedDotNext)) {
  console.log("[fix-standalone-path] .next/standalone/.next/ already in correct location");
  process.exit(0);
}

// Read package.json to find the monorepo root relative path
import { readFileSync } from "node:fs";
const nextConfig = join(appDir, ".next/trace");

// Try common monorepo structures
const candidates = [
  join(standaloneDir, relative(join(appDir, "../.."), appDir), ".next"), // apps/www/.next
  join(standaloneDir, relative(join(appDir, ".."), appDir), ".next"),    // www/.next
];

let found = null;
for (const candidate of candidates) {
  if (existsSync(candidate)) {
    found = candidate;
    break;
  }
}

// If not found by heuristic, search for it
if (!found) {
  import("node:fs").then(({ readdirSync }) => {
    function findDotNext(dir, depth = 0) {
      if (depth > 4) return null;
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === ".next" && entry.isDirectory()) {
          const serverDir = join(dir, ".next/server");
          if (existsSync(serverDir)) return join(dir, ".next");
        }
        if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".next") {
          const result = findDotNext(join(dir, entry.name), depth + 1);
          if (result) return result;
        }
      }
      return null;
    }
    found = findDotNext(standaloneDir);
    if (found) moveIt(found);
    else {
      console.error("[fix-standalone-path] Could not find shifted .next directory");
      process.exit(1);
    }
  });
} else {
  moveIt(found);
}

function moveIt(shiftedDotNext) {
  console.log(`[fix-standalone-path] Found shifted path: ${relative(appDir, shiftedDotNext)}`);
  console.log(`[fix-standalone-path] Moving to: .next/standalone/.next/`);

  // Also move server.js if it exists alongside .next
  const shiftedRoot = join(shiftedDotNext, "..");
  const serverJs = join(shiftedRoot, "server.js");

  cpSync(shiftedDotNext, expectedDotNext, { recursive: true });
  if (existsSync(serverJs)) {
    cpSync(serverJs, join(standaloneDir, "server.js"));
  }

  console.log("[fix-standalone-path] Done");
}
