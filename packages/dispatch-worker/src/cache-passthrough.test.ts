/**
 * Regression suite locking in the invariant that production
 * dispatch-worker NEVER tampers with the user worker's response
 * cache/cookie semantics.
 *
 * This is the production counterpart to sandbox-dispatch's
 * Cache-Control safety tests. The bug that broke EmDash login on
 * sandbox (sandbox-dispatch unconditionally rewrote Cache-Control to
 * `public`, causing CF to strip Set-Cookie from auth responses) MUST
 * NOT be reintroduced on the production path.
 *
 * Production is more conservative on purpose: tenants own their cache
 * policy, so we forward whatever they set verbatim. The only
 * mutations dispatch-worker is allowed to make on a successful
 * response are:
 *   - inferring `Content-Type` when WfP Static Assets omitted it
 *
 * Anything else — Cache-Control, Set-Cookie, Vary, etc. — must
 * round-trip unchanged.
 */

import { describe, test, expect } from "vitest";
import worker from "./index.js";

interface OrgRow {
  slug: string;
  plan: string;
  id?: string;
}

interface ProjectRow {
  productionDeploymentId: string | null;
}

function createMockD1(opts: {
  orgs?: OrgRow[];
  productionDeployments?: Record<string, ProjectRow>;
}) {
  const orgs = opts.orgs ?? [];
  const productionDeployments = opts.productionDeployments ?? {};

  return {
    prepare(sql: string) {
      let boundArgs: unknown[] = [];
      const exec = {
        bind(...args: unknown[]) {
          boundArgs = args;
          return exec;
        },
        async first<T>(): Promise<T | null> {
          // production deployment lookup uses (project_slug, team_slug)
          if (sql.includes("p.productionDeploymentId")) {
            const [project, team] = boundArgs as [string, string];
            return (productionDeployments[`${project}|${team}`] ?? null) as T | null;
          }
          return null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          if (sql.includes("FROM organization")) {
            return { results: orgs as unknown as T[] };
          }
          return { results: [] };
        },
      };
      return exec;
    },
  } as unknown as D1Database;
}

function createMockDispatcher(
  scriptHandlers: Record<string, (req: Request) => Promise<Response>>,
) {
  return {
    get(name: string) {
      return {
        async fetch(req: Request): Promise<Response> {
          const handler = scriptHandlers[name];
          if (!handler) throw new Error(`Worker not found: ${name}`);
          return handler(req);
        },
      };
    },
  };
}

function createEnv(opts: {
  orgs?: OrgRow[];
  productionDeployments?: Record<string, ProjectRow>;
  scriptHandlers: Record<string, (req: Request) => Promise<Response>>;
}) {
  return {
    DISPATCHER: createMockDispatcher(opts.scriptHandlers),
    DB: createMockD1({
      orgs: opts.orgs,
      productionDeployments: opts.productionDeployments,
    }),
    CREEK_DOMAIN: "bycreek.com",
  } as unknown as Parameters<typeof worker.fetch>[1];
}

/**
 * Exercise dispatch-worker for `<project>-<team>.bycreek.com` with the
 * given user-worker response, then return the response we forwarded.
 *
 * `omitContentType: true` strips the Content-Type the Response
 * constructor auto-applies, simulating WfP Static Assets's actual
 * behaviour of not setting Content-Type at all.
 */
async function dispatchProduction(opts: {
  pathname: string;
  method?: string;
  responseHeaders?: HeadersInit;
  responseStatus?: number;
  body?: string;
  omitContentType?: boolean;
}) {
  const project = "site";
  const team = "acme";
  const scriptName = `${project}-${team}`;

  return worker.fetch(
    new Request(`https://${project}-${team}.bycreek.com${opts.pathname}`, {
      method: opts.method ?? "GET",
    }),
    createEnv({
      orgs: [{ slug: team, plan: "pro", id: "org_acme" }],
      productionDeployments: {
        [`${project}|${team}`]: { productionDeploymentId: "deploy_123" },
      },
      scriptHandlers: {
        [scriptName]: async () => {
          const headers = new Headers(opts.responseHeaders ?? {});
          const res = new Response(opts.body ?? "ok", {
            status: opts.responseStatus ?? 200,
            headers,
          });
          if (opts.omitContentType) {
            const stripped = new Headers(res.headers);
            stripped.delete("Content-Type");
            return new Response(res.body, {
              status: res.status,
              statusText: res.statusText,
              headers: stripped,
            });
          }
          return res;
        },
      },
    }),
  );
}

describe("dispatch-worker — Cache-Control passthrough invariants", () => {
  test("user worker's `Cache-Control: public, max-age=300` round-trips unchanged", async () => {
    const res = await dispatchProduction({
      pathname: "/blog/post-1",
      responseHeaders: {
        "Content-Type": "text/html",
        "Cache-Control": "public, max-age=300",
      },
    });
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
  });

  test("user worker's `Cache-Control: private, max-age=0` round-trips unchanged", async () => {
    const res = await dispatchProduction({
      pathname: "/account",
      responseHeaders: {
        "Content-Type": "text/html",
        "Cache-Control": "private, max-age=0",
      },
    });
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=0");
  });

  test("user worker's `Cache-Control: no-store` round-trips unchanged", async () => {
    const res = await dispatchProduction({
      pathname: "/dashboard",
      responseHeaders: {
        "Content-Type": "text/html",
        "Cache-Control": "no-store",
      },
    });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  test("response without Cache-Control stays without Cache-Control (no inferred default)", async () => {
    const res = await dispatchProduction({
      pathname: "/api/me",
      responseHeaders: { "Content-Type": "application/json" },
    });
    expect(res.headers.get("Cache-Control")).toBeNull();
  });
});

describe("dispatch-worker — Set-Cookie passthrough invariants", () => {
  test("Set-Cookie on a 200 GET passes through verbatim", async () => {
    const res = await dispatchProduction({
      pathname: "/login",
      responseHeaders: {
        "Content-Type": "text/html",
        "Set-Cookie": "session=abc; HttpOnly; Secure; SameSite=Lax; Path=/",
      },
    });
    expect(res.headers.get("Set-Cookie")).toBe(
      "session=abc; HttpOnly; Secure; SameSite=Lax; Path=/",
    );
  });

  test("Set-Cookie on a POST auth response passes through (the EmDash regression)", async () => {
    // The exact shape that broke on sandbox: passkey verify is a POST
    // returning JSON + Set-Cookie. Production must never strip it.
    const res = await dispatchProduction({
      pathname: "/_emdash/api/auth/passkey/verify",
      method: "POST",
      responseHeaders: {
        "Content-Type": "application/json",
        "Set-Cookie": "astro-session=xyz; HttpOnly; Secure; SameSite=Lax",
      },
    });
    expect(res.headers.get("Set-Cookie")).toContain("astro-session=xyz");
    // Also: dispatch-worker MUST NOT inject `public` Cache-Control
    // here. If it ever does, CF will strip the cookie.
    const cc = res.headers.get("Cache-Control");
    expect(cc).toBeNull(); // no override → user controls fully
  });
});

describe("dispatch-worker — Vary, response code, and body fidelity", () => {
  test("Vary header from user worker passes through", async () => {
    const res = await dispatchProduction({
      pathname: "/api/data",
      responseHeaders: {
        "Content-Type": "application/json",
        Vary: "Accept-Encoding, Authorization",
      },
    });
    expect(res.headers.get("Vary")).toBe("Accept-Encoding, Authorization");
  });

  test("dispatch-worker does NOT add Vary: Host of its own", async () => {
    // sandbox-dispatch DOES add this. Production should not — tenants
    // are isolated by hostname-to-script binding, no shared cache key.
    const res = await dispatchProduction({
      pathname: "/anything",
      responseHeaders: { "Content-Type": "text/html" },
    });
    expect(res.headers.get("Vary")).toBeNull();
  });

  test("non-200 statuses are forwarded as-is (302 redirect)", async () => {
    const res = await dispatchProduction({
      pathname: "/old",
      responseStatus: 302,
      responseHeaders: { Location: "/new" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/new");
  });

  test("non-200 statuses are forwarded as-is (500 error)", async () => {
    const res = await dispatchProduction({
      pathname: "/crash",
      responseStatus: 500,
      responseHeaders: { "Content-Type": "text/plain" },
      body: "internal error",
    });
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("internal error");
  });

  test("response body is preserved byte-for-byte", async () => {
    const body = "<!doctype html>\n<html><body>hello</body></html>";
    const res = await dispatchProduction({
      pathname: "/",
      responseHeaders: { "Content-Type": "text/html" },
      body,
    });
    expect(await res.text()).toBe(body);
  });
});

describe("dispatch-worker — Content-Type inference does NOT clobber user values", () => {
  test("Content-Type set by user worker is preserved", async () => {
    const res = await dispatchProduction({
      pathname: "/api/x",
      responseHeaders: { "Content-Type": "application/vnd.creek+json" },
    });
    expect(res.headers.get("Content-Type")).toBe("application/vnd.creek+json");
  });

  test("missing Content-Type is inferred from extension (CSS file)", async () => {
    const res = await dispatchProduction({
      pathname: "/_astro/main.x123.css",
      // simulate WfP Static Assets: returns body without Content-Type
      omitContentType: true,
      body: "body{color:red}",
    });
    expect(res.headers.get("Content-Type")).toBe("text/css; charset=utf-8");
  });

  test("missing Content-Type on extensionless path infers HTML (SPA route)", async () => {
    const res = await dispatchProduction({
      pathname: "/dashboard",
      omitContentType: true,
      body: "<html></html>",
    });
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  });

  test("missing Content-Type is NOT inferred for non-2xx responses", async () => {
    // Code path: `if (response.ok && !response.headers.get("Content-Type"))`
    const res = await dispatchProduction({
      pathname: "/missing.png",
      responseStatus: 404,
      omitContentType: true,
      body: "not found",
    });
    expect(res.headers.get("Content-Type")).toBeNull();
  });
});
