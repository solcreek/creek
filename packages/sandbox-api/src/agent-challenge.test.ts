import { describe, test, expect, vi, beforeEach } from "vitest";
import { verifyAgentToken, QUESTION_BANK } from "./agent-challenge.js";

// ---------------------------------------------------------------------------
// Crypto helpers (mirror the module's internal helpers for test assertions)
// ---------------------------------------------------------------------------

async function sha256hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function createTestToken(
  secret: string,
  ipHash: string,
  overrides?: { exp?: number; iat?: number },
): Promise<string> {
  const now = Date.now();
  const payload = JSON.stringify({
    ipHash,
    iat: overrides?.iat ?? now,
    exp: overrides?.exp ?? now + 3600_000,
  });
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

  return `crk_agent_${payloadB64}.${sigB64}`;
}

const TEST_SECRET = "test-secret-for-agent-challenge";
const TEST_IP_HASH = "abc123def456";

// ---------------------------------------------------------------------------
// Question bank tests
// ---------------------------------------------------------------------------

describe("QUESTION_BANK", () => {
  test("has at least 3 questions", () => {
    expect(QUESTION_BANK.length).toBeGreaterThanOrEqual(3);
  });

  test("each question has required fields", () => {
    for (const q of QUESTION_BANK) {
      expect(q.id).toBeTruthy();
      expect(q.url).toMatch(/^https:\/\//);
      expect(q.instruction).toBeTruthy();
      expect(q.format).toBeTruthy();
      expect(typeof q.solve).toBe("function");
    }
  });

  test("question IDs are unique", () => {
    const ids = QUESTION_BANK.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("cli-commands solver extracts commands from HTML", () => {
    const q = QUESTION_BANK.find((q) => q.id === "cli-commands");
    expect(q).toBeDefined();

    const fakeHtml = `
      <h2><code>creek deploy</code></h2>
      <h2><code>creek login</code></h2>
      <h3><code>creek status</code></h3>
      <h2><code>creek init</code></h2>
    `;
    const answer = q!.solve(fakeHtml);
    expect(answer).toBe("deploy,init,login,status");
  });

  test("getting-started-steps solver counts h2 headings", () => {
    const q = QUESTION_BANK.find((q) => q.id === "getting-started-steps");
    expect(q).toBeDefined();

    const fakeHtml = `
      <h2>Step 1: Install</h2>
      <h2>Step 2: Configure</h2>
      <h2>Step 3: Deploy</h2>
    `;
    const answer = q!.solve(fakeHtml);
    expect(answer).toBe("3");
  });

  test("api-endpoints solver extracts paths from code tags", () => {
    const q = QUESTION_BANK.find((q) => q.id === "api-endpoints");
    expect(q).toBeDefined();

    const fakeHtml = `
      <code>/projects</code>
      <code>/projects/:id</code>
      <code>/deployments</code>
      <code>creek deploy</code>
      <code>/projects</code>
    `;
    const answer = q!.solve(fakeHtml);
    // Should be sorted, deduplicated, no non-path strings
    expect(answer).toBe("/deployments,/projects,/projects/:id");
  });

  test("solver returns null for empty/unmatched HTML", () => {
    const q = QUESTION_BANK.find((q) => q.id === "cli-commands");
    expect(q!.solve("<html><body>Nothing here</body></html>")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Token verification tests
// ---------------------------------------------------------------------------

describe("verifyAgentToken", () => {
  test("valid token returns payload", async () => {
    const token = await createTestToken(TEST_SECRET, TEST_IP_HASH);
    const payload = await verifyAgentToken(token, TEST_SECRET, TEST_IP_HASH);
    expect(payload).not.toBeNull();
    expect(payload!.ipHash).toBe(TEST_IP_HASH);
    expect(payload!.exp).toBeGreaterThan(Date.now());
  });

  test("rejects token with wrong secret", async () => {
    const token = await createTestToken(TEST_SECRET, TEST_IP_HASH);
    const payload = await verifyAgentToken(token, "wrong-secret", TEST_IP_HASH);
    expect(payload).toBeNull();
  });

  test("rejects token with wrong IP hash", async () => {
    const token = await createTestToken(TEST_SECRET, TEST_IP_HASH);
    const payload = await verifyAgentToken(token, TEST_SECRET, "different-ip-hash");
    expect(payload).toBeNull();
  });

  test("rejects expired token", async () => {
    const token = await createTestToken(TEST_SECRET, TEST_IP_HASH, {
      exp: Date.now() - 1000, // expired 1 second ago
    });
    const payload = await verifyAgentToken(token, TEST_SECRET, TEST_IP_HASH);
    expect(payload).toBeNull();
  });

  test("rejects token without crk_agent_ prefix", async () => {
    const payload = await verifyAgentToken("invalid_token_format", TEST_SECRET, TEST_IP_HASH);
    expect(payload).toBeNull();
  });

  test("rejects token with missing dot separator", async () => {
    const payload = await verifyAgentToken("crk_agent_nodot", TEST_SECRET, TEST_IP_HASH);
    expect(payload).toBeNull();
  });

  test("rejects tampered payload", async () => {
    const token = await createTestToken(TEST_SECRET, TEST_IP_HASH);
    // Tamper with payload (change a character)
    const parts = token.split(".");
    const tamperedPayload = parts[0].slice(0, -1) + "X";
    const tampered = tamperedPayload + "." + parts[1];
    const payload = await verifyAgentToken(tampered, TEST_SECRET, TEST_IP_HASH);
    expect(payload).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SHA-256 challenge digest tests
// ---------------------------------------------------------------------------

describe("challenge digest computation", () => {
  test("SHA-256(nonce|answer) produces consistent 64-char hex", async () => {
    const nonce = "test-nonce-123";
    const answer = "deploy,init,login,status";
    const digest = await sha256hex(nonce + "|" + answer);

    expect(digest).toHaveLength(64);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);

    // Same input → same output (deterministic)
    const digest2 = await sha256hex(nonce + "|" + answer);
    expect(digest2).toBe(digest);
  });

  test("different nonce → different digest", async () => {
    const answer = "deploy,init,login,status";
    const d1 = await sha256hex("nonce-a|" + answer);
    const d2 = await sha256hex("nonce-b|" + answer);
    expect(d1).not.toBe(d2);
  });

  test("different answer → different digest", async () => {
    const nonce = "same-nonce";
    const d1 = await sha256hex(nonce + "|" + "answer-a");
    const d2 = await sha256hex(nonce + "|" + "answer-b");
    expect(d1).not.toBe(d2);
  });
});
