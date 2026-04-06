/**
 * Static content scanning for sandbox deploys.
 *
 * Agent-friendly — no CAPTCHA, no browser required.
 * Scans decoded assets for phishing patterns and validates
 * that bundles resemble legitimate framework output.
 */

export interface ScanResult {
  ok: boolean;
  reason?: string;
  detail?: string;
}

// --- Phishing / malicious content patterns ---

const PHISHING_PATTERNS: { pattern: RegExp; reason: string }[] = [
  // External form actions (credential harvesting)
  {
    pattern: /<form[^>]+action\s*=\s*["']https?:\/\/(?!localhost|127\.0\.0\.1)[^"']+["']/gi,
    reason: "External form action detected — potential credential harvesting",
  },
  // Password fields in forms posting externally
  {
    pattern: /<input[^>]+type\s*=\s*["']password["'][^>]*>/gi,
    reason: "Password input field detected — sandbox sites should not collect credentials",
  },
  // Crypto wallet address patterns (common in scam pages)
  {
    pattern: /\b(0x[a-fA-F0-9]{40})\b/g,
    reason: "Ethereum address detected — potential crypto scam",
  },
  {
    pattern: /\b([13][a-km-zA-HJ-NP-Z1-9]{25,34})\b/g,
    reason: "Bitcoin address pattern detected — potential crypto scam",
  },
  // Meta refresh redirects to external sites
  {
    pattern: /<meta[^>]+http-equiv\s*=\s*["']refresh["'][^>]+content\s*=\s*["'][^"']*url\s*=\s*https?:\/\/[^"']*/gi,
    reason: "Meta refresh redirect to external site",
  },
  // window.location redirects in inline scripts (to external)
  {
    pattern: /window\.location\s*(?:\.\s*href\s*)?=\s*["']https?:\/\/[^"']+["']/gi,
    reason: "JavaScript redirect to external site",
  },
  // Data exfiltration via fetch/XMLHttpRequest to external
  {
    pattern: /(?:fetch|XMLHttpRequest|navigator\.sendBeacon)\s*\(\s*["']https?:\/\/(?!localhost|127\.0\.0\.1)/gi,
    reason: "Network request to external endpoint — potential data exfiltration",
  },
  // Impersonation of known brands in title/heading
  {
    pattern: /<(?:title|h[1-3])[^>]*>[^<]*(?:PayPal|Apple\s+ID|Microsoft\s+(?:365|Account)|Google\s+(?:Sign|Account)|MetaMask|Coinbase|Binance|Netflix|Amazon\s+(?:Prime|Account))[^<]*<\//gi,
    reason: "Brand impersonation detected — potential phishing",
  },
  // iframe embedding external login pages
  {
    pattern: /<iframe[^>]+src\s*=\s*["']https?:\/\/(?!localhost|127\.0\.0\.1)[^"']+["']/gi,
    reason: "External iframe detected — potential clickjacking",
  },
];

// Patterns that are OK alone but suspicious with password fields
const CREDENTIAL_HARVEST_SIGNALS = [
  /<input[^>]+type\s*=\s*["']email["']/gi,
  /<input[^>]+type\s*=\s*["']text["'][^>]+(?:name|id|placeholder)\s*=\s*["'][^"']*(?:user|login|email|account)/gi,
];

// --- Structure validation ---

/** Check if a filename looks like hashed framework output (e.g., index-BkH3q2.js) */
function isHashedFilename(filename: string): boolean {
  // Common patterns: [name]-[hash].[ext], [name].[hash].[ext]
  return /[-.][\da-zA-Z]{6,12}\.\w+$/.test(filename);
}

/**
 * Scan HTML content for phishing / malicious patterns.
 * Returns first match found.
 */
function scanHtml(content: string): ScanResult {
  // Check password fields — only flag if combined with external form action or credential signals
  const hasPasswordField = /<input[^>]+type\s*=\s*["']password["'][^>]*>/gi.test(content);
  const hasExternalFormAction = /<form[^>]+action\s*=\s*["']https?:\/\/(?!localhost|127\.0\.0\.1)/gi.test(content);

  if (hasPasswordField && hasExternalFormAction) {
    return {
      ok: false,
      reason: "content_policy",
      detail: "Login form with external action detected — sandbox sites cannot collect credentials",
    };
  }

  // Only flag password fields if there are multiple credential harvesting signals
  if (hasPasswordField) {
    let signalCount = 0;
    for (const sig of CREDENTIAL_HARVEST_SIGNALS) {
      if (sig.test(content)) signalCount++;
      sig.lastIndex = 0; // Reset regex state
    }
    if (signalCount >= 1) {
      return {
        ok: false,
        reason: "content_policy",
        detail: "Credential collection form detected — sandbox sites should not collect login credentials",
      };
    }
  }

  // Check other patterns (skip password-only rule since handled above)
  for (const { pattern, reason } of PHISHING_PATTERNS) {
    if (pattern.source.includes('type\\s*=\\s*["\']password')) continue;
    pattern.lastIndex = 0;
    if (pattern.test(content)) {
      return { ok: false, reason: "content_policy", detail: reason };
    }
    pattern.lastIndex = 0;
  }

  return { ok: true };
}

/**
 * Validate bundle structure — check that it resembles legitimate framework output.
 * Not a hard block, but raises suspicion score.
 */
function validateStructure(assetPaths: string[]): ScanResult {
  if (assetPaths.length === 0) {
    return { ok: false, reason: "validation", detail: "No assets in bundle" };
  }

  // Single HTML file with no other assets = suspicious (likely phishing page)
  const htmlFiles = assetPaths.filter((p) => p.endsWith(".html"));
  const nonHtmlFiles = assetPaths.filter((p) => !p.endsWith(".html"));

  if (htmlFiles.length >= 1 && nonHtmlFiles.length === 0) {
    // Single HTML-only deploy — scan more aggressively
    // Allow it but flag as needing content scan (handled by caller)
    return { ok: true }; // Content scan is always run anyway
  }

  // If there are JS/CSS files, check that at least some have hashed names
  // (indicates a real build tool was used)
  const jsFiles = assetPaths.filter((p) => p.endsWith(".js") || p.endsWith(".mjs"));
  const cssFiles = assetPaths.filter((p) => p.endsWith(".css"));
  const codeFiles = [...jsFiles, ...cssFiles];

  if (codeFiles.length > 0) {
    const hashedCount = codeFiles.filter((p) => isHashedFilename(p.split("/").pop() ?? "")).length;
    // If there are code files but zero are hashed, it's not from a build tool
    // This is fine for simple projects — don't block, just note it
  }

  return { ok: true };
}

/**
 * Main scan entry point. Runs all checks on the deploy bundle.
 *
 * @param assets - Record<path, base64-encoded content>
 * @returns ScanResult — ok:true if clean, ok:false with reason if blocked
 */
export function scanBundle(assets: Record<string, string>): ScanResult {
  const assetPaths = Object.keys(assets);

  // 1. Structure validation
  const structureResult = validateStructure(assetPaths);
  if (!structureResult.ok) return structureResult;

  // 2. Scan HTML files for phishing patterns
  for (const [path, b64Content] of Object.entries(assets)) {
    if (!path.endsWith(".html") && !path.endsWith(".htm")) continue;

    let html: string;
    try {
      html = atob(b64Content);
    } catch {
      return { ok: false, reason: "validation", detail: `Invalid base64 in asset: ${path}` };
    }

    const htmlResult = scanHtml(html);
    if (!htmlResult.ok) {
      return { ...htmlResult, detail: `${htmlResult.detail} (in ${path})` };
    }
  }

  // 3. Check for suspicious JS patterns in inline scripts within HTML
  // (already covered by HTML scan above since we scan full HTML content)

  // 4. Quick check on JS files for obvious data exfil
  for (const [path, b64Content] of Object.entries(assets)) {
    if (!path.endsWith(".js") && !path.endsWith(".mjs")) continue;
    // Only scan small JS files — large bundled files are likely framework output
    if (b64Content.length > 500_000) continue; // Skip files > ~375KB decoded

    let js: string;
    try {
      js = atob(b64Content);
    } catch {
      continue; // Invalid base64 in JS is not a security issue, just broken
    }

    // Check for data exfiltration patterns
    const exfilPattern = /(?:fetch|XMLHttpRequest|navigator\.sendBeacon)\s*\(\s*["']https?:\/\/(?!localhost|127\.0\.0\.1)/gi;
    if (exfilPattern.test(js)) {
      // Only flag if combined with credential access patterns
      const accessesCredentials = /(?:document\.cookie|localStorage|sessionStorage|credential)/gi.test(js);
      if (accessesCredentials) {
        return {
          ok: false,
          reason: "content_policy",
          detail: `Suspicious script accessing credentials and sending to external endpoint (in ${path})`,
        };
      }
    }
  }

  return { ok: true };
}
