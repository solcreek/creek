import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OAuthGrantError,
  buildAuthorizeUrl,
  exchangeCode,
  listAccounts,
  pkceChallenge,
  randomToken,
  refreshTokens,
  revokeToken,
  type OAuthClientConfig,
} from "./oauth.js";

const config: OAuthClientConfig = {
  clientId: "creek-client",
  clientSecret: "s3cret",
  redirectUri: "https://api.creek.dev/oauth/cloudflare/callback",
  scopes: ["offline_access", "access.write", "dns.write"],
};

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("PKCE", () => {
  it("matches the RFC 7636 appendix B vector", async () => {
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("makes URL-safe, unpadded, distinct random tokens", () => {
    const a = randomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(a);
  });
});

describe("buildAuthorizeUrl", () => {
  it("asks Cloudflare for a code with S256 PKCE and the configured scopes", () => {
    const url = new URL(buildAuthorizeUrl(config, "st", "ch"));
    expect(url.origin + url.pathname).toBe("https://dash.cloudflare.com/oauth2/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "creek-client",
      redirect_uri: config.redirectUri,
      scope: "offline_access access.write dns.write",
      state: "st",
      code_challenge: "ch",
      code_challenge_method: "S256",
    });
  });
});

describe("exchangeCode", () => {
  it("posts the code and verifier with client basic auth and reads the granted scopes", async () => {
    const fetch = mockFetch(200, {
      access_token: "at",
      refresh_token: "rt",
      expires_in: 3600,
      scope: "offline_access access.write", // dns.write was declined
    });
    const before = Date.now();
    const tokens = await exchangeCode(config, "the-code", "the-verifier");

    expect(tokens.accessToken).toBe("at");
    expect(tokens.refreshToken).toBe("rt");
    expect(tokens.scopes).toEqual(["offline_access", "access.write"]);
    expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 3600_000);

    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe("https://dash.cloudflare.com/oauth2/token");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Basic ${btoa("creek-client:s3cret")}`,
    );
    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
      grant_type: "authorization_code",
      code: "the-code",
      redirect_uri: config.redirectUri,
      code_verifier: "the-verifier",
    });
  });

  it("assumes the requested scopes when the response omits scope", async () => {
    mockFetch(200, { access_token: "at" });
    const tokens = await exchangeCode(config, "c", "v");
    expect(tokens.scopes).toEqual(config.scopes);
    expect(tokens.refreshToken).toBeNull();
    expect(tokens.expiresAt).toBeNull();
  });

  it("throws OAuthGrantError with the server's error code", async () => {
    mockFetch(400, { error: "invalid_grant", error_description: "code reused" });
    await expect(exchangeCode(config, "c", "v")).rejects.toMatchObject({
      name: "OAuthGrantError",
      code: "invalid_grant",
      status: 400,
    });
  });

  it("treats a 200 without an access token as an error", async () => {
    mockFetch(200, { hello: "world" });
    await expect(exchangeCode(config, "c", "v")).rejects.toBeInstanceOf(OAuthGrantError);
  });
});

describe("refreshTokens", () => {
  it("returns the rotated refresh token", async () => {
    const fetch = mockFetch(200, { access_token: "at2", refresh_token: "rt2", expires_in: 60 });
    const tokens = await refreshTokens(config, "rt1", ["access.write"]);
    expect(tokens.refreshToken).toBe("rt2");
    expect(tokens.scopes).toEqual(["access.write"]);
    expect(Object.fromEntries(new URLSearchParams(String(fetch.mock.calls[0][1]?.body)))).toEqual({
      grant_type: "refresh_token",
      refresh_token: "rt1",
    });
  });

  it("keeps the old refresh token when the server does not rotate", async () => {
    mockFetch(200, { access_token: "at2" });
    expect((await refreshTokens(config, "rt1", [])).refreshToken).toBe("rt1");
  });
});

describe("revokeToken", () => {
  it("never throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("network down"))),
    );
    await expect(revokeToken(config, "t")).resolves.toBe(false);
  });
});

describe("listAccounts", () => {
  it("returns id and name of each granted account", async () => {
    const fetch = mockFetch(200, {
      success: true,
      result: [{ id: "a1", name: "Acme" }, { id: "a2" }, { name: "no id" }],
    });
    expect(await listAccounts("at")).toEqual([
      { id: "a1", name: "Acme" },
      { id: "a2", name: "a2" },
    ]);
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get("authorization")).toBe("Bearer at");
  });

  it("throws on an API error", async () => {
    mockFetch(403, { success: false, errors: [{ message: "nope" }] });
    await expect(listAccounts("at")).rejects.toThrow(/403/);
  });
});
