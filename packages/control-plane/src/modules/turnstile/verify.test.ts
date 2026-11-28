import { describe, test, expect, beforeAll, afterEach, afterAll } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { app } from "../../index.js";
import { createLocalTestEnv, type LocalTestEnv } from "../../local/test-env.js";
import { SITEVERIFY_URL, TURNSTILE_HEADER, verifyTurnstileToken } from "./verify.js";
import type { Env } from "../../types.js";

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());

const testEnvs: LocalTestEnv[] = [];

afterEach(() => {
  server.resetHandlers();
  for (const te of testEnvs) te.cleanup();
  testEnvs.length = 0;
});

function makeAppEnv(overrides: Partial<Env> = {}): Env {
  const te = createLocalTestEnv({ applyMigrations: true });
  testEnvs.push(te);
  return {
    ...te.env,
    BETTER_AUTH_URL: "https://api.creek.dev",
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    GITHUB_CLIENT_ID: "gh",
    GITHUB_CLIENT_SECRET: "gh",
    GOOGLE_CLIENT_ID: "gg",
    GOOGLE_CLIENT_SECRET: "gg",
    TURNSTILE_DASHBOARD_SECRET: "dashboard-secret",
    TURNSTILE_DASHBOARD_HOSTNAMES: "app.creek.dev",
    TURNSTILE_WWW_SECRET: "www-secret",
    TURNSTILE_WWW_HOSTNAMES: "creek.dev",
    ...overrides,
  } as Env;
}

describe("verifyTurnstileToken", () => {
  test("passes when unconfigured in local dev (http, no secret or hostnames)", async () => {
    const res = await verifyTurnstileToken({
      token: undefined,
      expectedAction: "login",
      failClosedWhenUnconfigured: false,
    });
    expect(res).toEqual({ ok: true, skipped: true });
  });

  test("fails closed when enforced but secret or hostnames is missing", async () => {
    const missingSecret = await verifyTurnstileToken({
      secret: "",
      hostnames: "app.creek.dev",
      token: "valid-token",
      expectedAction: "login",
    });
    expect(missingSecret).toEqual({ ok: false, reason: "misconfigured" });

    const missingHostnames = await verifyTurnstileToken({
      secret: "secret",
      hostnames: "",
      token: "valid-token",
      expectedAction: "login",
    });
    expect(missingHostnames).toEqual({ ok: false, reason: "misconfigured" });

    const prodUnconfigured = await verifyTurnstileToken({
      token: "valid-token",
      expectedAction: "login",
      failClosedWhenUnconfigured: true,
    });
    expect(prodUnconfigured).toEqual({ ok: false, reason: "misconfigured" });
  });

  test("rejects missing, empty, or overlong tokens without calling siteverify", async () => {
    let called = false;
    server.use(
      http.post(SITEVERIFY_URL, () => {
        called = true;
        return HttpResponse.json({ success: true });
      }),
    );

    for (const token of [undefined, "", "x".repeat(2049)]) {
      const res = await verifyTurnstileToken({
        secret: "sec",
        hostnames: "app.creek.dev",
        token,
        expectedAction: "login",
      });
      expect(res).toEqual({ ok: false, reason: "missing_token" });
    }
    expect(called).toBe(false);
  });

  test("posts canonical form-urlencoded payload and accepts matching action + hostname", async () => {
    let capturedContentType = "";
    const capturedParams = new URLSearchParams();

    server.use(
      http.post(SITEVERIFY_URL, async ({ request }) => {
        capturedContentType = request.headers.get("content-type") ?? "";
        for (const [k, v] of new URLSearchParams(await request.text())) {
          capturedParams.set(k, v);
        }
        return HttpResponse.json({
          success: true,
          action: "signup",
          hostname: "app.creek.dev",
        });
      }),
    );

    const res = await verifyTurnstileToken({
      secret: "sec-123",
      hostnames: "app.creek.dev, preview.app.creek.dev",
      token: "tok-abc",
      expectedAction: "signup",
      remoteIp: "203.0.113.10",
    });

    expect(res).toEqual({ ok: true });
    expect(capturedContentType).toContain("application/x-www-form-urlencoded");
    expect(capturedParams.get("secret")).toBe("sec-123");
    expect(capturedParams.get("response")).toBe("tok-abc");
    expect(capturedParams.get("remoteip")).toBe("203.0.113.10");
  });

  test("rejects success: false", async () => {
    server.use(
      http.post(SITEVERIFY_URL, () =>
        HttpResponse.json({ success: false, "error-codes": ["invalid-input-response"] }),
      ),
    );

    const res = await verifyTurnstileToken({
      secret: "sec",
      hostnames: "app.creek.dev",
      token: "bad-tok",
      expectedAction: "login",
    });
    expect(res).toEqual({ ok: false, reason: "verification_failed" });
  });

  test("rejects action mismatch", async () => {
    server.use(
      http.post(SITEVERIFY_URL, () =>
        HttpResponse.json({
          success: true,
          action: "login",
          hostname: "app.creek.dev",
        }),
      ),
    );

    const res = await verifyTurnstileToken({
      secret: "sec",
      hostnames: "app.creek.dev",
      token: "tok",
      expectedAction: "signup",
    });
    expect(res).toEqual({ ok: false, reason: "action_mismatch" });
  });

  test("rejects disallowed hostname such as localhost in production", async () => {
    server.use(
      http.post(SITEVERIFY_URL, () =>
        HttpResponse.json({
          success: true,
          action: "login",
          hostname: "localhost",
        }),
      ),
    );

    const res = await verifyTurnstileToken({
      secret: "sec",
      hostnames: "app.creek.dev",
      token: "tok",
      expectedAction: "login",
    });
    expect(res).toEqual({ ok: false, reason: "hostname_mismatch" });
  });

  test("fails closed on siteverify HTTP 500, network error, or invalid JSON", async () => {
    server.use(http.post(SITEVERIFY_URL, () => new HttpResponse("boom", { status: 500 })));
    expect(
      await verifyTurnstileToken({
        secret: "sec",
        hostnames: "app.creek.dev",
        token: "tok",
        expectedAction: "login",
      }),
    ).toEqual({ ok: false, reason: "siteverify_error" });

    server.use(http.post(SITEVERIFY_URL, () => HttpResponse.error()));
    expect(
      await verifyTurnstileToken({
        secret: "sec",
        hostnames: "app.creek.dev",
        token: "tok",
        expectedAction: "login",
      }),
    ).toEqual({ ok: false, reason: "siteverify_error" });

    server.use(http.post(SITEVERIFY_URL, () => new HttpResponse("not-json", { status: 200 })));
    expect(
      await verifyTurnstileToken({
        secret: "sec",
        hostnames: "app.creek.dev",
        token: "tok",
        expectedAction: "login",
      }),
    ).toEqual({ ok: false, reason: "siteverify_error" });
  });
});

describe("control-plane Turnstile route enforcement", () => {
  test("POST /api/auth/sign-up/email rejects missing token with 403 and accepts valid signup token", async () => {
    const env = makeAppEnv();

    const denied = await app.request(
      "/api/auth/sign-up/email",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://app.creek.dev",
        },
        body: JSON.stringify({
          name: "Alice",
          email: "alice@example.com",
          password: "password123",
        }),
      },
      env,
    );
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: "turnstile_failed" });

    server.use(
      http.post(SITEVERIFY_URL, async ({ request }) => {
        const params = new URLSearchParams(await request.text());
        expect(params.get("secret")).toBe("dashboard-secret");
        expect(params.get("response")).toBe("valid-signup-token");
        return HttpResponse.json({
          success: true,
          action: "signup",
          hostname: "app.creek.dev",
        });
      }),
    );

    const allowed = await app.request(
      "/api/auth/sign-up/email",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://app.creek.dev",
          [TURNSTILE_HEADER]: "valid-signup-token",
        },
        body: JSON.stringify({
          name: "Alice",
          email: "alice@example.com",
          password: "password123",
        }),
      },
      env,
    );
    expect(allowed.status).toBe(200);
  });

  test("POST /api/auth/sign-up/email// trailing/double slash still enforces Turnstile", async () => {
    const env = makeAppEnv();

    const denied = await app.request(
      "/api/auth/sign-up//email/",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://app.creek.dev",
        },
        body: JSON.stringify({
          name: "Alice",
          email: "alice@example.com",
          password: "password123",
        }),
      },
      env,
    );
    expect(denied.status).toBe(403);
  });

  test("POST /api/auth/sign-in/email rejects login token from signup action and accepts login action", async () => {
    const env = makeAppEnv();

    server.use(
      http.post(SITEVERIFY_URL, () =>
        HttpResponse.json({
          success: true,
          action: "signup",
          hostname: "app.creek.dev",
        }),
      ),
    );

    const wrongAction = await app.request(
      "/api/auth/sign-in/email",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://app.creek.dev",
          [TURNSTILE_HEADER]: "tok",
        },
        body: JSON.stringify({ email: "alice@example.com", password: "password123" }),
      },
      env,
    );
    expect(wrongAction.status).toBe(403);

    // First sign up a user with signup action, then sign in with login action
    server.use(
      http.post(SITEVERIFY_URL, async ({ request }) => {
        const params = new URLSearchParams(await request.text());
        const tok = params.get("response");
        return HttpResponse.json({
          success: true,
          action: tok === "signup-tok" ? "signup" : "login",
          hostname: "app.creek.dev",
        });
      }),
    );

    const signedUp = await app.request(
      "/api/auth/sign-up/email",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://app.creek.dev",
          [TURNSTILE_HEADER]: "signup-tok",
        },
        body: JSON.stringify({
          name: "Bob",
          email: "bob@example.com",
          password: "password123",
        }),
      },
      env,
    );
    expect(signedUp.status).toBe(200);

    const signedIn = await app.request(
      "/api/auth/sign-in/email",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://app.creek.dev",
          [TURNSTILE_HEADER]: "login-tok",
        },
        body: JSON.stringify({ email: "bob@example.com", password: "password123" }),
      },
      env,
    );
    expect(signedIn.status).toBe(200);
  });

  test("POST /web-deploy enforces Turnstile with www secret + creek.dev hostname + web-deploy action", async () => {
    const env = makeAppEnv();

    const missing = await app.request(
      "/web-deploy",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://creek.dev",
        },
        body: JSON.stringify({ type: "template", template: "landing" }),
      },
      env,
    );
    expect(missing.status).toBe(403);
    expect(await missing.json()).toMatchObject({ error: "turnstile_failed" });

    // Token minted for dashboard widget (app.creek.dev) must be rejected on /web-deploy
    server.use(
      http.post(SITEVERIFY_URL, () =>
        HttpResponse.json({
          success: true,
          action: "web-deploy",
          hostname: "app.creek.dev",
        }),
      ),
    );

    const wrongHost = await app.request(
      "/web-deploy",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://creek.dev",
          [TURNSTILE_HEADER]: "tok",
        },
        body: JSON.stringify({ type: "template", template: "landing" }),
      },
      env,
    );
    expect(wrongHost.status).toBe(403);

    // Valid token for creek.dev + web-deploy succeeds with 202
    server.use(
      http.post(SITEVERIFY_URL, async ({ request }) => {
        const params = new URLSearchParams(await request.text());
        expect(params.get("secret")).toBe("www-secret");
        return HttpResponse.json({
          success: true,
          action: "web-deploy",
          hostname: "creek.dev",
        });
      }),
    );

    const accepted = await app.request(
      "/web-deploy",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://creek.dev",
          [TURNSTILE_HEADER]: "www-tok",
        },
        body: JSON.stringify({ type: "template", template: "landing" }),
      },
      env,
    );
    expect(accepted.status).toBe(202);
  });
});
