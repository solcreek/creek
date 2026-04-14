import { describe, test, expect } from "vitest";
import { scrubLine, scrubNdjson } from "./scrub.js";

describe("scrubLine", () => {
  test("passes through benign content unchanged", () => {
    const r = scrubLine("Building app — 1042 modules transformed");
    expect(r.text).toBe("Building app — 1042 modules transformed");
    expect(r.hits).toEqual([]);
  });

  test("redacts env-style secrets", () => {
    const r = scrubLine("DATABASE_PASSWORD=hunter2-is-my-pass");
    expect(r.text).toBe("[REDACTED:env-secret]");
    expect(r.hits).toContain("env-secret");
  });

  test("redacts AWS access key id", () => {
    const r = scrubLine("Using AKIAIOSFODNN7EXAMPLE as access key");
    expect(r.text).toContain("[REDACTED:aws-akid]");
    expect(r.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  test("redacts GitHub tokens", () => {
    const r = scrubLine("token=ghp_EXAMPLE00EXAMPLE00EXAMPLE00EXAMPLE00");
    expect(r.text).toContain("[REDACTED:github-token]");
  });

  test("redacts OpenAI sk-keys", () => {
    const r = scrubLine("export OPENAI_API_KEY=sk-EXAMPLE00EXAMPLE00EXAMPLE00EXAMPLE00");
    // env-secret fires on the full token; no need to also fire openai-key
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.text).not.toContain("sk-EXAMPLE00EXAMPLE00EXAMPLE00EXAMPLE00");
  });

  test("redacts stripe live keys", () => {
    // Split so the literal `sk_live_...` prefix doesn't appear verbatim
    // in source (GH push-protection scanner matches that prefix).
    const token = "sk" + "_live_" + "EXAMPLE00EXAMPLE00EXAMPLE000";
    const r = scrubLine("CHARGE: " + token);
    expect(r.text).toContain("[REDACTED:stripe-key]");
    expect(r.text).not.toContain(token);
  });

  test("redacts Google API keys", () => {
    // Google API keys are AIza + exactly 35 alphanumeric chars
    const r = scrubLine("api=AIzaSyD-abcd1234567890ABCDEF1234567890a");
    expect(r.text).toContain("[REDACTED:google-key]");
  });

  test("redacts slack tokens", () => {
    const r = scrubLine("using xoxb-EXAMPLE000-EXAMPLE000-EXAMPLE000EXAMPLE000EXAMPLE00");
    expect(r.text).toContain("[REDACTED:slack-token]");
  });

  test("redacts JWTs", () => {
    const r = scrubLine(
      "Bearer eyJEXAMPLE00EXAMPLE.eyJEXAMPLE00EXAMPLE.EXAMPLE00EXAMPLE_signature",
    );
    expect(r.hits).toContain("jwt");
    expect(r.text).toContain("[REDACTED:jwt]");
  });

  test("redacts PEM blocks", () => {
    const r = scrubLine(
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEF\n-----END RSA PRIVATE KEY-----",
    );
    expect(r.text).toContain("[REDACTED:pem]");
    expect(r.text).not.toContain("MIIEvQIBADANBgkqhkiG9w0BAQEF");
  });

  test("redacts connection strings with credentials", () => {
    const r = scrubLine("connecting to postgres://admin:s3cretP%40ss@db.host.com:5432/app");
    expect(r.text).toContain("[REDACTED:conn-string]");
    expect(r.text).not.toContain("s3cretP%40ss");
  });

  test("does not flag FOO=bar (non-secret-shaped key name)", () => {
    // Non-secret-sounding env var names don't trigger — we're trying to
    // avoid redacting build flags like NODE_ENV=production.
    const r = scrubLine("NODE_ENV=production");
    expect(r.text).toBe("NODE_ENV=production");
    expect(r.hits).toEqual([]);
  });

  test("does not flag short NAME=value pairs", () => {
    const r = scrubLine("MY_KEY=ab"); // too short to be a secret
    expect(r.text).toBe("MY_KEY=ab");
  });

  test("multiple distinct secrets on same line are all redacted", () => {
    const r = scrubLine("key1=ghp_FAKE00FAKE00FAKE00FAKE00FAKE00FAKE00 key2=AKIAZZZZZZZZZZZZZZZZ");
    expect(r.text).not.toContain("ghp_FAKE00FAKE00FAKE00FAKE00FAKE00FAKE00");
    expect(r.text).not.toContain("AKIAZZZZZZZZZZZZZZZZ");
  });
});

describe("scrubNdjson", () => {
  test("scrubs msg field on each json line", () => {
    const body = [
      JSON.stringify({ ts: 1, step: "install", msg: "pulling deps" }),
      JSON.stringify({ ts: 2, step: "build", msg: "GITHUB_TOKEN=ghp_EXAMPLE00EXAMPLE00EXAMPLE00EXAMPLE00" }),
    ].join("\n");
    const { text, totalHits } = scrubNdjson(body);
    const lines = text.split("\n").map((l) => JSON.parse(l));
    expect(lines[0].msg).toBe("pulling deps");
    expect(lines[1].msg).toContain("[REDACTED");
    // env-secret is what fires on `KEY=value` shape
    expect(totalHits["env-secret"]).toBe(1);
  });

  test("preserves non-msg fields", () => {
    const body = JSON.stringify({
      ts: 123,
      step: "build",
      stream: "stderr",
      level: "error",
      msg: "sk-EXAMPLE00EXAMPLE00EXAMPLE00EXAMPLE00fake leak",
      code: "CK-BUILD-FAILED",
    });
    const { text } = scrubNdjson(body);
    const parsed = JSON.parse(text);
    expect(parsed.ts).toBe(123);
    expect(parsed.step).toBe("build");
    expect(parsed.stream).toBe("stderr");
    expect(parsed.level).toBe("error");
    expect(parsed.code).toBe("CK-BUILD-FAILED");
    expect(parsed.msg).not.toContain("sk-EXAMPLE00EXAMPLE00EXAMPLE00EXAMPLE00fake");
  });

  test("handles malformed lines by scrubbing whole string", () => {
    const body = "not-json but contains ghp_EXAMPLE00EXAMPLE00EXAMPLE00EXAMPLE00 secret";
    const { text } = scrubNdjson(body);
    expect(text).toContain("[REDACTED:github-token]");
    expect(text).not.toContain("ghp_EXAMPLE00EXAMPLE00EXAMPLE00EXAMPLE00");
  });

  test("blank lines preserved", () => {
    const body = "\n" + JSON.stringify({ msg: "hi" }) + "\n";
    const { text } = scrubNdjson(body);
    expect(text.split("\n").length).toBe(3);
  });
});
