import { describe, test, expect, beforeAll, vi } from "vitest";
import {
  type AccessConfig,
  type KeyLookup,
  createKeyLookup,
  isBypassPath,
  isBypassed,
  parseAccessConfig,
  verifyAccessJwt,
} from "./access.js";
import {
  AUD,
  KID,
  TEAM,
  type TestSigner,
  createSigner,
  validClaims,
} from "./access-test-helpers.js";

let signer: TestSigner;
let other: TestSigner;
const config: AccessConfig = { teamDomain: TEAM, aud: AUD, bypassPaths: [] };
const keys: KeyLookup = async (team, kid) =>
  team === TEAM && kid === KID ? signer.publicKey : null;

beforeAll(async () => {
  signer = await createSigner();
  other = await createSigner();
});

describe("verifyAccessJwt", () => {
  test("accepts a token from the team for the application, and returns its email", async () => {
    const token = await signer.sign(validClaims());
    expect(await verifyAccessJwt(token, config, keys)).toEqual({
      ok: true,
      email: "visitor@example.com",
    });
  });

  test("accepts aud given as a string", async () => {
    const token = await signer.sign({ ...validClaims(), aud: AUD });
    expect((await verifyAccessJwt(token, config, keys)).ok).toBe(true);
  });

  test.each([
    ["no token", null, "missing"],
    ["empty token", "", "missing"],
    ["two segments", "abc.def", "malformed"],
    ["non-base64url characters", "a.b+c.d", "malformed"],
    ["header not JSON", "bm90anNvbg.e30.c2ln", "malformed"],
    ["oversized", `${"a".repeat(17000)}.b.c`, "malformed"],
  ])("refuses %s", async (_name, token, reason) => {
    expect(await verifyAccessJwt(token, config, keys)).toEqual({ ok: false, reason });
  });

  test("refuses a token signed by a key the team doesn't publish", async () => {
    const token = await other.sign(validClaims());
    expect(await verifyAccessJwt(token, config, keys)).toEqual({ ok: false, reason: "signature" });
  });

  test("refuses a token whose claims were edited after signing", async () => {
    const token = await signer.sign(validClaims());
    const [h, , s] = token.split(".");
    const forged = btoa(JSON.stringify({ ...validClaims(), email: "admin@example.com" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(await verifyAccessJwt(`${h}.${forged}.${s}`, config, keys)).toEqual({
      ok: false,
      reason: "signature",
    });
  });

  test("refuses an unknown kid", async () => {
    const token = await signer.sign(validClaims(), { kid: "rotated-away" });
    expect(await verifyAccessJwt(token, config, keys)).toEqual({
      ok: false,
      reason: "unknown_key",
    });
  });

  test.each(["none", "HS256", "RS512"])("refuses alg %s", async (alg) => {
    const token = await signer.sign(validClaims(), { alg });
    expect(await verifyAccessJwt(token, config, keys)).toEqual({ ok: false, reason: "algorithm" });
  });

  test("refuses another team's token, even for the same AUD", async () => {
    const token = await signer.sign({ ...validClaims(), iss: "https://evil.cloudflareaccess.com" });
    expect(await verifyAccessJwt(token, config, keys)).toEqual({ ok: false, reason: "issuer" });
  });

  test("refuses a token for another application of the same team", async () => {
    const token = await signer.sign({ ...validClaims(), aud: ["b".repeat(64)] });
    expect(await verifyAccessJwt(token, config, keys)).toEqual({ ok: false, reason: "audience" });
  });

  test("refuses an expired token, allowing 60 s of skew", async () => {
    const now = 1_800_000_000;
    const token = await signer.sign({ ...validClaims(now), exp: now - 30 });
    expect((await verifyAccessJwt(token, config, keys, now)).ok).toBe(true);
    expect(await verifyAccessJwt(token, config, keys, now + 31)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  test("refuses a token without exp", async () => {
    const { exp: _exp, ...claims } = validClaims();
    const token = await signer.sign(claims);
    expect(await verifyAccessJwt(token, config, keys)).toEqual({ ok: false, reason: "expired" });
  });

  test("refuses a token not yet valid", async () => {
    const now = 1_800_000_000;
    const token = await signer.sign({ ...validClaims(now), nbf: now + 120 });
    expect(await verifyAccessJwt(token, config, keys, now)).toEqual({
      ok: false,
      reason: "not_yet_valid",
    });
  });

  test.each([
    ["a team domain outside cloudflareaccess.com", { teamDomain: "evil.example.com" }],
    ["an empty team domain", { teamDomain: "" }],
    ["an AUD that isn't 64 hex", { aud: "abc" }],
  ])("refuses everything under %s, without fetching keys", async (_name, patch) => {
    const lookup = vi.fn(keys);
    const token = await signer.sign(validClaims());
    expect(await verifyAccessJwt(token, { ...config, ...patch }, lookup)).toEqual({
      ok: false,
      reason: "config",
    });
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("bypass paths", () => {
  test.each([
    ["/health", "/health", true],
    ["/health", "/health/live", true],
    ["/health", "/healthz", false],
    ["/health", "/", false],
    ["/health/", "/health", true],
    ["/api/webhooks/*", "/api/webhooks/github", true],
    ["/api/webhooks/*", "/api/webhooks", true],
    ["/api/webhooks/*", "/api/webhooksx", false],
    ["/Health", "/health", false],
  ])("%s against %s → %s", (entry, path, expected) => {
    expect(isBypassed(path, [entry])).toBe(expected);
  });

  test.each([
    "/",
    "/*",
    "//",
    "//x",
    "health",
    "/a?b",
    "/a#b",
    "/a*b",
    "/a/*/b",
    "/a/../b",
    "/a b",
    "",
  ])("%j is not a valid entry and bypasses nothing", (entry) => {
    expect(isBypassPath(entry)).toBe(false);
    expect(isBypassed("/", [entry])).toBe(false);
    expect(isBypassed("/anything", [entry])).toBe(false);
  });
});

describe("parseAccessConfig", () => {
  test("no settings: not protected", () => {
    expect(parseAccessConfig({})).toBeNull();
    expect(parseAccessConfig({ accessTeamDomain: null, accessAud: null })).toBeNull();
  });

  test("full settings", () => {
    expect(
      parseAccessConfig({
        accessTeamDomain: TEAM,
        accessAud: AUD,
        accessBypassPaths: '["/health","/"]',
      }),
    ).toEqual({ teamDomain: TEAM, aud: AUD, bypassPaths: ["/health"] });
  });

  test("half a setting stays protected, with a config no token can satisfy", async () => {
    const half = parseAccessConfig({ accessTeamDomain: TEAM, accessAud: null });
    expect(half).not.toBeNull();
    const token = await signer.sign(validClaims());
    expect(await verifyAccessJwt(token, half!, keys)).toEqual({ ok: false, reason: "config" });
  });

  test.each([
    ["only a bypass list", { accessBypassPaths: '["/health"]' }],
    ["empty strings", { accessTeamDomain: "", accessAud: "", accessBypassPaths: null }],
    ["an empty team domain", { accessTeamDomain: "", accessAud: AUD }],
    [
      "a team domain off cloudflareaccess.com, with bypass paths",
      { accessTeamDomain: "evil.example.com", accessAud: AUD, accessBypassPaths: '["/health"]' },
    ],
    [
      "a bad AUD, with bypass paths",
      { accessTeamDomain: TEAM, accessAud: "nope", accessBypassPaths: '["/health"]' },
    ],
  ])("%s: protected, unsatisfiable, and nothing bypasses", async (_name, row) => {
    const config = parseAccessConfig(row);
    expect(config).not.toBeNull();
    expect(config!.bypassPaths).toEqual([]);
    const token = await signer.sign(validClaims());
    expect(await verifyAccessJwt(token, config!, keys)).toEqual({ ok: false, reason: "config" });
  });

  test("an unreadable bypass list means no bypass", () => {
    expect(
      parseAccessConfig({ accessTeamDomain: TEAM, accessAud: AUD, accessBypassPaths: "{not json" })
        ?.bypassPaths,
    ).toEqual([]);
  });
});

describe("createKeyLookup", () => {
  function certsFetcher() {
    const calls: string[] = [];
    let body: unknown = signer.certs;
    let status = 200;
    const fetcher = (async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return {
      fetcher,
      calls,
      setBody: (b: unknown) => (body = b),
      setStatus: (s: number) => (status = s),
    };
  }

  test("fetches the team's certs once and reuses them", async () => {
    const f = certsFetcher();
    const lookup = createKeyLookup(f.fetcher);
    expect(await lookup(TEAM, KID)).not.toBeNull();
    expect(await lookup(TEAM, KID)).not.toBeNull();
    expect(f.calls).toEqual([`https://${TEAM}/cdn-cgi/access/certs`]);
  });

  test("concurrent lookups share one fetch", async () => {
    const f = certsFetcher();
    const lookup = createKeyLookup(f.fetcher);
    await Promise.all([lookup(TEAM, KID), lookup(TEAM, KID), lookup(TEAM, KID)]);
    expect(f.calls).toHaveLength(1);
  });

  test("an unknown kid refetches (key rotation), at most once a minute", async () => {
    let now = 0;
    const f = certsFetcher();
    const lookup = createKeyLookup(f.fetcher, () => now);
    await lookup(TEAM, KID);
    now = 10_000;
    expect(await lookup(TEAM, "made-up")).toBeNull();
    expect(f.calls).toHaveLength(1);
    now = 61_000;
    f.setBody({ keys: [...other.certs.keys.map((k) => ({ ...k, kid: "made-up" }))] });
    expect(await lookup(TEAM, "made-up")).not.toBeNull();
    expect(f.calls).toHaveLength(2);
  });

  test("refetches after an hour, and keeps serving old keys if that fails", async () => {
    let now = 0;
    const f = certsFetcher();
    const lookup = createKeyLookup(f.fetcher, () => now);
    await lookup(TEAM, KID);
    now = 60 * 60 * 1000;
    f.setStatus(500);
    expect(await lookup(TEAM, KID)).not.toBeNull();
    expect(f.calls).toHaveLength(2);
  });

  test("with no keys yet, a failed fetch throws (the caller answers 503)", async () => {
    const f = certsFetcher();
    f.setStatus(404);
    const lookup = createKeyLookup(f.fetcher);
    await expect(lookup(TEAM, KID)).rejects.toThrow(/HTTP 404/);
  });

  test.each([
    ["no keys", { keys: [] }],
    ["only non-RSA keys", { keys: [{ kty: "EC", kid: KID, crv: "P-256", x: "x", y: "y" }] }],
    ["no keys field", {}],
  ])("a 200 with %s is a failed fetch: cold, it throws (503)", async (_name, body) => {
    const f = certsFetcher();
    f.setBody(body);
    const lookup = createKeyLookup(f.fetcher);
    await expect(lookup(TEAM, KID)).rejects.toThrow(/no usable RSA keys/);
  });

  test("an empty key set on refresh keeps the keys that still work", async () => {
    let now = 0;
    const f = certsFetcher();
    const lookup = createKeyLookup(f.fetcher, () => now);
    await lookup(TEAM, KID);
    now = 60 * 60 * 1000;
    f.setBody({ keys: [] });
    expect(await lookup(TEAM, KID)).not.toBeNull();
    expect(f.calls).toHaveLength(2);
  });

  test("after a failed refresh, old keys serve without refetching until the cooldown ends", async () => {
    let now = 0;
    const f = certsFetcher();
    const lookup = createKeyLookup(f.fetcher, () => now);
    await lookup(TEAM, KID);
    now = 60 * 60 * 1000;
    f.setStatus(500);
    await lookup(TEAM, KID);
    expect(f.calls).toHaveLength(2);
    for (let i = 0; i < 5; i++) {
      now += 1000;
      expect(await lookup(TEAM, KID)).not.toBeNull();
      // Possibly a rotated key we can't fetch now: 503, not 403.
      await expect(lookup(TEAM, `made-up-${i}`)).rejects.toThrow(/recent fetch failed/);
    }
    expect(f.calls).toHaveLength(2);
    now += 30 * 1000;
    f.setStatus(200);
    await lookup(TEAM, KID);
    expect(f.calls).toHaveLength(3);
  });

  test("with no keys, a failed fetch is not retried by every request during the cooldown", async () => {
    let now = 0;
    const f = certsFetcher();
    f.setStatus(503);
    const lookup = createKeyLookup(f.fetcher, () => now);
    await expect(lookup(TEAM, KID)).rejects.toThrow(/HTTP 503/);
    now = 10_000;
    await expect(lookup(TEAM, KID)).rejects.toThrow(/recent fetch failed/);
    await expect(lookup(TEAM, KID)).rejects.toThrow(/recent fetch failed/);
    expect(f.calls).toHaveLength(1);
    now = 31_000;
    f.setStatus(200);
    expect(await lookup(TEAM, KID)).not.toBeNull();
    expect(f.calls).toHaveLength(2);
  });

  test("keys are per team", async () => {
    const f = certsFetcher();
    const lookup = createKeyLookup(f.fetcher);
    await lookup(TEAM, KID);
    await lookup("other-team.cloudflareaccess.com", KID);
    expect(f.calls).toEqual([
      `https://${TEAM}/cdn-cgi/access/certs`,
      "https://other-team.cloudflareaccess.com/cdn-cgi/access/certs",
    ]);
  });
});
