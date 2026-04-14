/**
 * Secret scrubber for build log lines.
 *
 * Build-container stdout can contain whatever the tenant's build script
 * writes. That includes accidental `echo $API_KEY`, dotenv dumps,
 * private keys pasted into error messages, etc. We scrub at WRITE time
 * because the R2 object is immutable — once a secret lands in a log
 * object, it's there forever.
 *
 * Design:
 *   - Pure function, no I/O. Call per-line.
 *   - Patterns are additive: we'd rather over-redact than miss a secret.
 *   - Replacement is `[REDACTED:<tag>]` so readers can see WHY something
 *     was masked (helps users verify we're not eating their content).
 *   - This is the ONLY gate between tenant build output and R2 storage.
 */

export interface ScrubResult {
  /** The line with secrets replaced by `[REDACTED:tag]` markers. */
  text: string;
  /** Tags fired on this line (empty = no redaction). Useful for metrics. */
  hits: string[];
}

interface Pattern {
  tag: string;
  re: RegExp;
}

// Ordered by specificity — long-form multi-line patterns first so they
// match before per-token rules fire on parts of them.
const PATTERNS: Pattern[] = [
  // PEM blocks — single line after concatenation
  {
    tag: "pem",
    re: /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g,
  },
  // Generic KEY=SECRET form (`AWS_SECRET_ACCESS_KEY=...`, `DATABASE_URL=postgres://...`)
  // Trigger on common secret-shaped key names to avoid nuking every `FOO=bar`
  {
    tag: "env-secret",
    re: /\b([A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|DSN|CREDENTIAL|AUTH|PRIVATE))\s*=\s*[^\s"']{8,}/g,
  },
  // Connection strings with embedded credentials (postgres://user:pass@host)
  {
    tag: "conn-string",
    re: /\b(?:postgres|postgresql|mongodb|mongodb\+srv|mysql|redis|rediss|amqp|amqps|ftp|ftps):\/\/[^:\s]+:[^@\s]+@[^\s"']+/g,
  },
  // GitHub tokens
  { tag: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  // OpenAI-style sk-keys
  { tag: "openai-key", re: /\bsk-[A-Za-z0-9_-]{32,}\b/g },
  // Stripe keys
  { tag: "stripe-key", re: /\b(?:sk|pk|rk)_(?:test|live)_[A-Za-z0-9]{16,}\b/g },
  // Slack tokens
  { tag: "slack-token", re: /\bxox[bpars]-[A-Za-z0-9-]{10,}\b/g },
  // Google API keys (AIza...)
  { tag: "google-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // Cloudflare API tokens (opaque 40-char base62)
  // Narrow: require it to look like a token context to avoid false hits
  {
    tag: "cf-token",
    re: /\b(?:Bearer|api[_-]?token|CF[_-]?TOKEN|CLOUDFLARE[_-]?API[_-]?TOKEN)[\s:=]+[A-Za-z0-9_-]{40,}\b/gi,
  },
  // JWTs — three base64-url segments separated by dots, min sizes avoid false hits
  {
    tag: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  // AWS Access Key IDs
  { tag: "aws-akid", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
];

/**
 * Scrub a single log line. Returns the line with replacements plus a
 * list of tags that fired, so the caller can track redaction rates per
 * build.
 */
export function scrubLine(line: string): ScrubResult {
  let text = line;
  const hits: string[] = [];
  for (const p of PATTERNS) {
    let matched = false;
    text = text.replace(p.re, () => {
      matched = true;
      return `[REDACTED:${p.tag}]`;
    });
    if (matched) hits.push(p.tag);
  }
  return { text, hits };
}

/**
 * Convenience wrapper over an ndjson buffer. Preserves line boundaries
 * and only scrubs the `msg` field of each parsed entry — leaves `ts`,
 * `step`, etc. alone so structural fields can't be accidentally masked.
 * Malformed lines pass through scrubbed whole-line.
 */
export function scrubNdjson(body: string): { text: string; totalHits: Record<string, number> } {
  const totalHits: Record<string, number> = {};
  const out: string[] = [];
  for (const raw of body.split("\n")) {
    if (!raw) {
      out.push("");
      continue;
    }
    try {
      const entry = JSON.parse(raw) as Record<string, unknown>;
      if (typeof entry.msg === "string") {
        const { text: scrubbed, hits } = scrubLine(entry.msg);
        entry.msg = scrubbed;
        for (const h of hits) totalHits[h] = (totalHits[h] ?? 0) + 1;
      }
      out.push(JSON.stringify(entry));
    } catch {
      // Non-JSON line — scrub it as a free-form string and keep as-is.
      const { text: scrubbed, hits } = scrubLine(raw);
      for (const h of hits) totalHits[h] = (totalHits[h] ?? 0) + 1;
      out.push(scrubbed);
    }
  }
  return { text: out.join("\n"), totalHits };
}
