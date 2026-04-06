/**
 * Agent Challenge — "reverse CAPTCHA" that proves the caller is a capable AI agent.
 *
 * Protocol:
 *   1. POST /agent-verify/start  → { challengeId, nonce, task }
 *   2. Agent fetches the specified URL, extracts data per instructions
 *   3. Agent computes SHA-256(nonce + "|" + canonicalAnswer)
 *   4. POST /agent-verify/:id/submit { digest } → { token, expiresAt }
 *
 * The token is an HMAC-signed JWT-like string bound to the caller's IP hash.
 * It grants elevated rate limits (60/hr vs 10/hr for humans, 3/hr unverified).
 */

import { Hono } from "hono";
import type { Env } from "./types.js";

type ChallengeEnv = { Bindings: Env };

const challengeRoutes = new Hono<ChallengeEnv>();

// ---------------------------------------------------------------------------
// Challenge question bank
// ---------------------------------------------------------------------------
// Each challenge asks the agent to fetch a Creek doc page and extract
// specific structured data. The canonical answer is deterministic.
//
// Questions rotate — the agent can't hardcode answers because:
//   1. Different questions ask for different fields
//   2. The nonce changes every time → different hash
//   3. Doc content may be updated over time
// ---------------------------------------------------------------------------

export interface ChallengeQuestion {
  /** Unique key for this question */
  id: string;
  /** URL the agent must fetch */
  url: string;
  /** Human-readable instruction for what to extract */
  instruction: string;
  /** How to format the extracted data */
  format: string;
  /** Function to compute the canonical answer from the page content */
  solve: (html: string) => string | null;
}

/**
 * Extract text content from HTML elements matching a CSS-like selector pattern.
 * Simplified — works with tag + class matching for our controlled doc pages.
 */
function extractTextByTag(html: string, tag: string): string[] {
  const re = new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`, "gi");
  const results: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    results.push(m[1].trim());
  }
  return results;
}

/** Extract all <code> text inside <h2> or <h3> headings */
function extractCodeFromHeadings(html: string): string[] {
  const re = /<h[23][^>]*>[^<]*<code[^>]*>([^<]+)<\/code>[^<]*<\/h[23]>/gi;
  const results: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    results.push(m[1].trim());
  }
  return results;
}

/** Extract items from <li> elements */
function extractListItems(html: string): string[] {
  const re = /<li[^>]*>\s*(?:<[^>]+>)*\s*([^<]+)/gi;
  const results: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const text = m[1].trim();
    if (text) results.push(text);
  }
  return results;
}

// The question bank — each entry is self-contained with its solver.
// We use Creek's own documentation pages as the challenge source.
const QUESTION_BANK: ChallengeQuestion[] = [
  {
    id: "cli-commands",
    url: "https://creek.dev/docs/cli",
    instruction:
      "Fetch the Creek CLI documentation page. Extract all CLI command names (the text inside <code> tags within headings). Return them sorted alphabetically, separated by commas.",
    format: "sorted,comma,separated,lowercase",
    solve(html) {
      const commands = extractCodeFromHeadings(html)
        .map((c) => c.replace(/^creek\s+/, "").toLowerCase().trim())
        .filter((c) => c.length > 0 && !c.includes(" "));
      if (commands.length === 0) return null;
      return [...new Set(commands)].sort().join(",");
    },
  },
  {
    id: "api-endpoints",
    url: "https://creek.dev/docs/api",
    instruction:
      "Fetch the Creek API documentation page. Extract all HTTP endpoint paths (strings starting with / inside <code> tags). Return them sorted alphabetically, separated by commas.",
    format: "sorted,comma,separated",
    solve(html) {
      const codeRe = /<code[^>]*>([^<]+)<\/code>/gi;
      const paths: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = codeRe.exec(html)) !== null) {
        const text = m[1].trim();
        if (text.startsWith("/") && !text.includes(" ")) {
          // Normalize: remove trailing parameters like :id → keep as-is
          paths.push(text);
        }
      }
      if (paths.length === 0) return null;
      return [...new Set(paths)].sort().join(",");
    },
  },
  {
    id: "frameworks",
    url: "https://creek.dev/docs/frameworks/supported",
    instruction:
      "Fetch the Creek supported frameworks page. Extract all framework names mentioned in headings (h2 or h3). Return them sorted alphabetically, lowercase, separated by commas.",
    format: "sorted,comma,separated,lowercase",
    solve(html) {
      const headings = [
        ...extractTextByTag(html, "h2"),
        ...extractTextByTag(html, "h3"),
      ]
        .map((h) => h.toLowerCase().trim())
        .filter((h) => h.length > 0 && h.length < 40);
      if (headings.length === 0) return null;
      return [...new Set(headings)].sort().join(",");
    },
  },
  {
    id: "getting-started-steps",
    url: "https://creek.dev/docs/getting-started",
    instruction:
      'Fetch the Creek getting-started page. Count the total number of <h2> headings on the page. Return the count as a plain number string (e.g., "5").',
    format: "number_string",
    solve(html) {
      const headings = extractTextByTag(html, "h2");
      if (headings.length === 0) return null;
      return String(headings.length);
    },
  },
  {
    id: "mcp-tools",
    url: "https://creek.dev/docs/mcp",
    instruction:
      "Fetch the Creek MCP documentation page. Extract all MCP tool names (text inside <code> tags within headings or list items). Return them sorted alphabetically, separated by commas.",
    format: "sorted,comma,separated",
    solve(html) {
      const codeInLi = /<li[^>]*>[^<]*<code[^>]*>([^<]+)<\/code>/gi;
      const codeInH = /<h[23][^>]*>[^<]*<code[^>]*>([^<]+)<\/code>/gi;
      const tools: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = codeInLi.exec(html)) !== null) tools.push(m[1].trim());
      while ((m = codeInH.exec(html)) !== null) tools.push(m[1].trim());
      // Filter to likely tool names (snake_case or single words)
      const filtered = tools.filter((t) => /^[a-z_]+$/.test(t) && t.length > 2);
      if (filtered.length === 0) return null;
      return [...new Set(filtered)].sort().join(",");
    },
  },
];

// ---------------------------------------------------------------------------
// In-memory challenge store (ephemeral — challenges expire in 5 min)
// In production on CF Workers, this lives within the isolate's lifetime.
// A challenge not completed within 5 min simply expires.
// ---------------------------------------------------------------------------

interface PendingChallenge {
  id: string;
  questionId: string;
  nonce: string;
  expectedDigest: string;
  ipHash: string;
  createdAt: number;
  used: boolean;
}

const pendingChallenges = new Map<string, PendingChallenge>();

const CHALLENGE_TTL = 5 * 60 * 1000; // 5 minutes
const TOKEN_TTL = 60 * 60 * 1000; // 1 hour

// Prune expired challenges periodically
function pruneExpired() {
  const now = Date.now();
  for (const [id, ch] of pendingChallenges) {
    if (now - ch.createdAt > CHALLENGE_TTL) pendingChallenges.delete(id);
  }
}

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

async function sha256hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Create an HMAC-signed agent token.
 * Format: `crk_agent_<payload-base64url>.<signature-base64url>`
 * Payload: { ipHash, exp, iat }
 */
async function createAgentToken(
  secret: string,
  ipHash: string,
): Promise<{ token: string; expiresAt: number }> {
  const now = Date.now();
  const exp = now + TOKEN_TTL;

  const payload = JSON.stringify({ ipHash, iat: now, exp });
  const payloadB64 = btoa(payload)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payloadB64),
  );
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  return { token: `crk_agent_${payloadB64}.${sigB64}`, expiresAt: exp };
}

/**
 * Verify an agent token. Returns the payload if valid, null otherwise.
 */
export async function verifyAgentToken(
  token: string,
  secret: string,
  ipHash: string,
): Promise<{ ipHash: string; iat: number; exp: number } | null> {
  if (!token.startsWith("crk_agent_")) return null;

  const stripped = token.slice("crk_agent_".length);
  const dotIdx = stripped.lastIndexOf(".");
  if (dotIdx === -1) return null;

  const payloadB64 = stripped.slice(0, dotIdx);
  const sigB64 = stripped.slice(dotIdx + 1);

  // Verify HMAC
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );

  // Restore base64 padding
  const sigRestored = sigB64.replace(/-/g, "+").replace(/_/g, "/");
  const sigBytes = Uint8Array.from(atob(sigRestored), (c) => c.charCodeAt(0));

  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    sigBytes,
    new TextEncoder().encode(payloadB64),
  );

  if (!valid) return null;

  // Decode payload
  const payloadRestored = payloadB64.replace(/-/g, "+").replace(/_/g, "/");
  const payload = JSON.parse(atob(payloadRestored));

  // Check expiry
  if (Date.now() > payload.exp) return null;

  // Check IP binding
  if (payload.ipHash !== ipHash) return null;

  return payload;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * Start a challenge. Returns a nonce and task for the agent to complete.
 */
challengeRoutes.post("/start", async (c) => {
  pruneExpired();

  const env = c.env;
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const ipHash = await sha256hex(ip + (env.IP_HASH_SALT || "creek-sandbox-salt"));

  // Rate limit: max 20 challenge starts per hour per IP
  const recentFromIp = [...pendingChallenges.values()].filter(
    (ch) => ch.ipHash === ipHash && Date.now() - ch.createdAt < 3600_000,
  ).length;
  if (recentFromIp >= 20) {
    return c.json({ error: "rate_limited", message: "Too many challenge requests. Try again later." }, 429);
  }

  // Pick a random question
  const question = QUESTION_BANK[Math.floor(Math.random() * QUESTION_BANK.length)];

  // Generate nonce
  const nonce = crypto.randomUUID();
  const challengeId = crypto.randomUUID().slice(0, 12);

  // Pre-compute expected answer by fetching the page ourselves
  let expectedDigest: string;
  try {
    const res = await fetch(question.url, {
      headers: { "User-Agent": "Creek-Agent-Challenge/1.0" },
    });
    if (!res.ok) {
      return c.json(
        { error: "challenge_unavailable", message: "Challenge source temporarily unavailable. Try again." },
        503,
      );
    }
    const html = await res.text();
    const answer = question.solve(html);
    if (!answer) {
      return c.json(
        { error: "challenge_unavailable", message: "Challenge source content changed. Try again." },
        503,
      );
    }
    expectedDigest = await sha256hex(nonce + "|" + answer);
  } catch {
    return c.json(
      { error: "challenge_unavailable", message: "Could not prepare challenge. Try again." },
      503,
    );
  }

  // Store pending challenge
  pendingChallenges.set(challengeId, {
    id: challengeId,
    questionId: question.id,
    nonce,
    expectedDigest,
    ipHash,
    createdAt: Date.now(),
    used: false,
  });

  return c.json({
    challengeId,
    nonce,
    task: {
      url: question.url,
      instruction: question.instruction,
      format: question.format,
    },
    expiresIn: CHALLENGE_TTL / 1000,
    tos: {
      url: "https://creek.dev/legal/terms",
      aupUrl: "https://creek.dev/legal/acceptable-use",
      note: "Include tosAccepted: true and tosVersion in your submit request.",
    },
  });
});

/**
 * Submit a challenge answer. Returns a signed agent token if correct.
 */
challengeRoutes.post("/:id/submit", async (c) => {
  const challengeId = c.req.param("id");
  const env = c.env;
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const ipHash = await sha256hex(ip + (env.IP_HASH_SALT || "creek-sandbox-salt"));

  const body = await c.req.json<{ digest?: string; tosAccepted?: boolean; tosVersion?: string }>().catch(() => ({}));
  const digest = (body as any).digest;
  const tosAccepted = (body as any).tosAccepted;
  const tosVersion = (body as any).tosVersion;

  if (!digest || typeof digest !== "string") {
    return c.json({ error: "validation", message: "Missing 'digest' field" }, 400);
  }

  if (!tosAccepted || !tosVersion) {
    return c.json({
      error: "tos_required",
      message: "You must accept the Terms of Service. Include tosAccepted: true and tosVersion in your request.",
      tosUrl: "https://creek.dev/legal/terms",
      aupUrl: "https://creek.dev/legal/acceptable-use",
    }, 400);
  }

  // Look up pending challenge
  const challenge = pendingChallenges.get(challengeId);

  if (!challenge) {
    return c.json(
      { error: "challenge_not_found", message: "Challenge not found or expired" },
      404,
    );
  }

  // Prevent replay
  if (challenge.used) {
    return c.json(
      { error: "challenge_used", message: "Challenge already submitted" },
      400,
    );
  }

  // Check IP binding (same IP that started must submit)
  if (challenge.ipHash !== ipHash) {
    return c.json(
      { error: "forbidden", message: "Challenge must be submitted from the same IP that started it" },
      403,
    );
  }

  // Check expiry
  if (Date.now() - challenge.createdAt > CHALLENGE_TTL) {
    pendingChallenges.delete(challengeId);
    return c.json(
      { error: "challenge_expired", message: "Challenge expired. Start a new one." },
      410,
    );
  }

  // Mark as used (prevent replay even if wrong)
  challenge.used = true;

  // Verify digest
  const normalizedDigest = digest.toLowerCase().trim();
  if (normalizedDigest !== challenge.expectedDigest) {
    return c.json(
      { error: "challenge_failed", message: "Incorrect answer. Start a new challenge." },
      401,
    );
  }

  // Challenge passed — issue signed token
  pendingChallenges.delete(challengeId);

  const secret = env.INTERNAL_SECRET;
  const { token, expiresAt } = await createAgentToken(secret, ipHash);

  return c.json({
    ok: true,
    token,
    expiresAt: new Date(expiresAt).toISOString(),
    expiresIn: TOKEN_TTL / 1000,
    tier: "verified_agent",
    rateLimit: 60,
  });
});

export { challengeRoutes, QUESTION_BANK };
