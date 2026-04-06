/**
 * Hostname validation for custom domains.
 */

const MAX_HOSTNAME_LENGTH = 253;

// Valid hostname: one or more labels separated by dots, ending with a TLD of 2+ letters.
// Each label: starts/ends with alphanumeric, may contain hyphens, max 63 chars.
const HOSTNAME_REGEX =
  /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

const IPV4_REGEX = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

// Reserved domains that cannot be registered as custom domains.
const BLOCKED_SUFFIXES = [
  ".bycreek.com",
  ".creek.dev",
  ".creeksandbox.com",
  ".localhost",
];

const BLOCKED_EXACT = ["localhost"];

export function validateHostname(
  hostname: string,
  options?: { skipReservedCheck?: boolean },
): { ok: true } | { ok: false; message: string } {
  if (!hostname) {
    return { ok: false, message: "Hostname is required" };
  }

  if (hostname.length > MAX_HOSTNAME_LENGTH) {
    return {
      ok: false,
      message: `Hostname exceeds maximum length of ${MAX_HOSTNAME_LENGTH} characters`,
    };
  }

  if (BLOCKED_EXACT.includes(hostname)) {
    return { ok: false, message: `"${hostname}" is a reserved hostname` };
  }

  if (IPV4_REGEX.test(hostname)) {
    return { ok: false, message: "IP addresses are not allowed as custom domains" };
  }

  if (!options?.skipReservedCheck) {
    for (const suffix of BLOCKED_SUFFIXES) {
      if (hostname === suffix.slice(1) || hostname.endsWith(suffix)) {
        return {
          ok: false,
          message: `Hostnames under ${suffix.slice(1)} are reserved`,
        };
      }
    }
  }

  if (!hostname.includes(".")) {
    return {
      ok: false,
      message: "Hostname must include a domain (e.g., app.example.com)",
    };
  }

  if (!HOSTNAME_REGEX.test(hostname)) {
    return {
      ok: false,
      message:
        "Invalid hostname format. Use lowercase letters, numbers, and hyphens (e.g., app.example.com)",
    };
  }

  return { ok: true };
}
