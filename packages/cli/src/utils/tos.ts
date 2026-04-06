/**
 * Terms of Service acceptance for CLI.
 *
 * - First deploy: shows ToS notice + URL + interactive y/N prompt
 * - Stored locally in ~/.creek/tos-accepted (version + timestamp)
 * - --yes / non-TTY: implicit accept with notice printed
 * - Sends tosVersion + tosAcceptedAt in deploy requests
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import consola from "consola";
import { getConfigDir } from "./config.js";
import { isTTY } from "./output.js";

const TOS_FILE = join(getConfigDir(), "tos-accepted");

// Bump this when ToS content changes — forces re-acceptance
export const CURRENT_TOS_VERSION = "2026-03-28";

const TOS_URL = "https://creek.dev/legal/terms";
const AUP_URL = "https://creek.dev/legal/acceptable-use";

export interface TosAcceptance {
  version: string;
  acceptedAt: string; // ISO 8601
}

/** Read stored ToS acceptance, if any. */
export function readTosAcceptance(): TosAcceptance | null {
  if (!existsSync(TOS_FILE)) return null;
  try {
    const data = JSON.parse(readFileSync(TOS_FILE, "utf-8"));
    if (data.version && data.acceptedAt) return data as TosAcceptance;
    return null;
  } catch {
    return null;
  }
}

/** Store ToS acceptance locally. */
export function writeTosAcceptance(acceptance: TosAcceptance): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(TOS_FILE, JSON.stringify(acceptance, null, 2), { mode: 0o600 });
}

/** Check if current ToS version has been accepted. */
export function isTosAccepted(): boolean {
  const acceptance = readTosAcceptance();
  return acceptance?.version === CURRENT_TOS_VERSION;
}

/**
 * Ensure ToS is accepted before proceeding.
 *
 * @param autoConfirm - true if --yes flag is set
 * @returns TosAcceptance record to send with deploy request
 * @throws if user rejects ToS
 */
export async function ensureTosAccepted(autoConfirm: boolean): Promise<TosAcceptance> {
  // Already accepted current version?
  const existing = readTosAcceptance();
  if (existing?.version === CURRENT_TOS_VERSION) return existing;

  // Show ToS notice
  consola.log("");
  consola.log("  By deploying, you agree to Creek's Terms of Service");
  consola.log("  and Acceptable Use Policy:");
  consola.log(`  ${TOS_URL}`);
  consola.log(`  ${AUP_URL}`);
  consola.log("");

  if (autoConfirm || !isTTY) {
    // Non-interactive: implicit acceptance
    consola.log("  Continuing implies acceptance of the above terms.");
    consola.log("");
  } else {
    // Interactive: ask for explicit acceptance
    const readline = await import("node:readline");
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const answer = await new Promise<string>((resolve) => {
      rl.question("  Accept? [y/N] ", (ans) => {
        rl.close();
        resolve(ans.trim().toLowerCase());
      });
    });

    if (answer !== "y" && answer !== "yes") {
      consola.error("You must accept the Terms of Service to use Creek.");
      process.exit(1);
    }
  }

  const acceptance: TosAcceptance = {
    version: CURRENT_TOS_VERSION,
    acceptedAt: new Date().toISOString(),
  };

  writeTosAcceptance(acceptance);
  return acceptance;
}
