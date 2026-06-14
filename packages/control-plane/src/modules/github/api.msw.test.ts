// @ts-nocheck — uses node:crypto (generateKeyPairSync) for an RSA test key,
// same as api.test.ts. Runs under vitest (Node), not workerd; the
// control-plane tsconfig targets workers, so type-check is disabled here.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { generateKeyPairSync } from "node:crypto";
import {
  exchangeInstallationToken,
  clearTokenCache,
  createCommitStatus,
  createOrUpdatePRComment,
  findPRForBranch,
} from "./api.js";

// MSW mocks api.github.com so we can assert the GitHub App auth exchange and
// the repo operations the deploy pipeline relies on (commit status, PR
// preview comments) without real GitHub. Fabricated IDs/keys only.
const GH = "https://api.github.com";

let env;
beforeAll(() => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  env = { GITHUB_APP_ID: "123456", GITHUB_APP_PRIVATE_KEY: privateKey };
  server.listen({ onUnhandledRequest: "error" });
});

const server = setupServer();
afterEach(() => {
  clearTokenCache();
  server.resetHandlers();
});
afterAll(() => server.close());

describe("exchangeInstallationToken", () => {
  it("signs a JWT, exchanges it for an installation token, and caches it", async () => {
    let calls = 0;
    let seenAuth = "";
    server.use(
      http.post(`${GH}/app/installations/:id/access_tokens`, ({ request, params }) => {
        calls++;
        seenAuth = request.headers.get("authorization") ?? "";
        expect(params.id).toBe("999");
        return HttpResponse.json({ token: "ghs_installation_token" });
      }),
    );

    const t1 = await exchangeInstallationToken(env, 999);
    expect(t1).toBe("ghs_installation_token");
    expect(seenAuth).toMatch(/^Bearer eyJ/); // a signed JWT

    // Second call within TTL is served from cache — no second request.
    const t2 = await exchangeInstallationToken(env, 999);
    expect(t2).toBe("ghs_installation_token");
    expect(calls).toBe(1);
  });

  it("throws when GitHub rejects the exchange", async () => {
    server.use(
      http.post(`${GH}/app/installations/:id/access_tokens`, () =>
        HttpResponse.text("bad credentials", { status: 401 }),
      ),
    );
    await expect(exchangeInstallationToken(env, 1)).rejects.toThrow(/Failed to exchange installation token: 401/);
  });
});

describe("createCommitStatus", () => {
  it("POSTs the status with the default context and a truncated description", async () => {
    let body;
    server.use(
      http.post(`${GH}/repos/:owner/:repo/statuses/:sha`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ id: 1 });
      }),
    );
    await createCommitStatus("tok", "myorg", "app", "abc123", "success", {
      targetUrl: "https://x.test",
      description: "d".repeat(200),
    });
    expect(body.state).toBe("success");
    expect(body.context).toBe("Creek");
    expect(body.target_url).toBe("https://x.test");
    expect(body.description.length).toBe(140); // clamped
  });
});

describe("createOrUpdatePRComment", () => {
  it("creates a new comment when none carries the creek-preview marker", async () => {
    const posted = vi.fn();
    server.use(
      http.get(`${GH}/repos/:owner/:repo/issues/:n/comments`, () => HttpResponse.json([])),
      http.post(`${GH}/repos/:owner/:repo/issues/:n/comments`, async ({ request }) => {
        posted(await request.json());
        return HttpResponse.json({ id: 10 });
      }),
    );
    await createOrUpdatePRComment("tok", "myorg", "app", 7, "hello");
    expect(posted).toHaveBeenCalledTimes(1);
    expect(posted.mock.calls[0][0].body).toContain("<!-- creek-preview -->");
    expect(posted.mock.calls[0][0].body).toContain("hello");
  });

  it("updates the existing creek comment via PATCH instead of posting a new one", async () => {
    const patched = vi.fn();
    let postCalls = 0;
    server.use(
      http.get(`${GH}/repos/:owner/:repo/issues/:n/comments`, () =>
        HttpResponse.json([
          { id: 1, body: "unrelated", user: { login: "someone" } },
          { id: 42, body: "<!-- creek-preview -->\nold", user: { login: "creek[bot]" } },
        ]),
      ),
      http.patch(`${GH}/repos/:owner/:repo/issues/comments/:id`, async ({ request, params }) => {
        patched({ id: params.id, body: (await request.json()).body });
        return HttpResponse.json({ id: 42 });
      }),
      http.post(`${GH}/repos/:owner/:repo/issues/:n/comments`, () => {
        postCalls++;
        return HttpResponse.json({ id: 99 });
      }),
    );
    await createOrUpdatePRComment("tok", "myorg", "app", 7, "fresh");
    expect(patched).toHaveBeenCalledTimes(1);
    expect(patched.mock.calls[0][0].id).toBe("42");
    expect(patched.mock.calls[0][0].body).toContain("fresh");
    expect(postCalls).toBe(0); // did NOT create a duplicate
  });
});

describe("findPRForBranch", () => {
  it("returns the first open PR number for the branch", async () => {
    server.use(
      http.get(`${GH}/repos/:owner/:repo/pulls`, () => HttpResponse.json([{ number: 13 }])),
    );
    expect(await findPRForBranch("tok", "myorg", "app", "feature/x")).toBe(13);
  });

  it("returns null when there is no open PR", async () => {
    server.use(http.get(`${GH}/repos/:owner/:repo/pulls`, () => HttpResponse.json([])));
    expect(await findPRForBranch("tok", "myorg", "app", "main")).toBeNull();
  });
});
