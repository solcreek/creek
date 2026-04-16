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
  console.error(`bundle-skills: source not found at ${monorepoSkills}`);
  process.exit(1);
}

await rm(dest, { recursive: true, force: true });
await mkdir(dest, { recursive: true });
await cp(monorepoSkills, dest, { recursive: true });
console.log(`bundled skills → ${dest}`);
