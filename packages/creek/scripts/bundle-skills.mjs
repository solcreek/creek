#!/usr/bin/env node
// Copies the monorepo skills/ content into this package before publish
// so `npx creek` users (and the agents loaded alongside them) can
// `cat node_modules/creek/skills/creek/references/*.md` without a
// separate download. Runs on `npm publish` via the `prepack` script.

import { cp, rm, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const monorepoSkills = resolve(pkgRoot, "..", "..", "skills");
const dest = resolve(pkgRoot, "skills");

if (!existsSync(monorepoSkills)) {
  // The skills/ source was moved to a separate repo (solcreek/skills) and
  // isn't present in the publish checkout. Skip bundling rather than failing
  // the publish — `npx creek` works without the bundled skill references.
  console.warn(
    `bundle-skills: source not found at ${monorepoSkills} — skipping (skills bundling is optional).`,
  );
  process.exit(0);
}

await rm(dest, { recursive: true, force: true });
await mkdir(dest, { recursive: true });
await cp(monorepoSkills, dest, { recursive: true });
console.log(`bundled skills → ${dest}`);
