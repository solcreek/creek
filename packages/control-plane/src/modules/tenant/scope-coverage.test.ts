import { describe, it, expect } from "vitest";
import { app } from "../../index.js";
import { apiKeyRouteGate, guardInfo, type GuardInfo } from "./scope-guard.js";
import { ALL_SCOPES } from "./scopes.js";

/**
 * Every endpoint of the deployed Worker, with what an API key needs to call
 * it. This is the reviewed authorization manifest: adding a route, or
 * changing a route's guard, fails this test until the line here changes with
 * it — so the change shows up in review as a diff of this table.
 *
 * Notation: "a b" = the key needs both; "a | b" = either (the handler then
 * checks the exact scope, e.g. preview vs production by branch).
 */
const MANIFEST: Record<string, string> = {
  "GET /health": "public",
  "POST /api/auth/*": "auth-routes",
  "GET /api/auth/*": "auth-routes",
  "POST /webhooks/github": "public",
  "POST /web-deploy": "public",
  "GET /web-deploy/list": "platform-admin",
  "GET /web-deploy/preflight": "public",
  "GET /web-deploy/:buildId": "public",
  "POST /builds/:id/logs": "internal + deploy:preview | deploy:production",
  "GET /projects": "project:read",
  "POST /projects": "project:write",
  "GET /projects/:idOrSlug": "project:read",
  "DELETE /projects/:idOrSlug": "project:delete",
  "POST /projects/:projectId/deployments": "deploy:preview | deploy:production",
  "PUT /projects/:projectId/deployments/:deploymentId/bundle": "deploy:preview | deploy:production",
  "PUT /projects/:projectId/deployments/:deploymentId/serverfile":
    "deploy:preview | deploy:production",
  "GET /projects/:projectId/deployments/:deploymentId": "project:read",
  "GET /projects/:projectId/deployments": "project:read",
  "POST /projects/:projectId/deployments/:deploymentId/promote": "deploy:production",
  "GET /projects/:projectId/rollback": "project:read",
  "POST /projects/:projectId/rollback": "deploy:production",
  "GET /projects/:projectId/cron-logs": "logs:read",
  "GET /projects/:projectId/analytics": "logs:read",
  "PATCH /projects/:projectId/triggers": "deploy:production",
  "POST /projects/:projectId/queue/send": "queue:send",
  "GET /projects/:projectId/domains": "domain:read",
  "GET /projects/:projectId/domains/:domainId": "domain:read",
  "POST /projects/:projectId/domains": "domain:write",
  "POST /projects/:projectId/domains/:domainId/activate": "domain:write",
  "DELETE /projects/:projectId/domains/:domainId": "domain:write",
  "GET /projects/:projectId/env": "env:read",
  "POST /projects/:projectId/env": "env:write",
  "DELETE /projects/:projectId/env/:key": "env:write",
  "GET /projects/:slug/logs": "logs:read",
  "GET /projects/:slug/logs/ws-token": "logs:read",
  "GET /projects/:slug/metrics": "logs:read",
  "GET /projects/:slug/deployments/:id/logs": "logs:read",
  "GET /projects/:slug/bindings": "resource:read",
  "POST /projects/:slug/bindings": "resource:write",
  "DELETE /projects/:slug/bindings/:name": "resource:write",
  "GET /resources": "resource:read",
  "POST /resources": "resource:write",
  "GET /resources/:id": "resource:read",
  "PATCH /resources/:id": "resource:write",
  "DELETE /resources/:id": "resource:delete",
  "POST /resources/:id/query": "db:query",
  "GET /resources/:id/metrics": "resource:read",
  "POST /instant-deploy": "project:write deploy:production",
  "PUT /instant-deploy/:slug": "deploy:production",
  "GET /github/installations": "github:read",
  "POST /github/installations/:id/claim": "github:write",
  "GET /github/installations/:id/repos": "github:read",
  "POST /github/connect": "github:write deploy:production",
  "POST /github/deploy-latest": "deploy:production",
  "DELETE /github/connections/:id": "github:write",
  "GET /github/connections/by-project/:projectId": "github:read",
  "GET /github/connections": "github:read",
  "POST /github/scan/:owner/:repo": "github:write",
};

/** app.use() middleware paths. An ALL route anywhere else would be an unguarded endpoint. */
const MIDDLEWARE_PATHS = new Set([
  "/*",
  "/projects/*",
  "/instant-deploy/*",
  "/github/*",
  "/resources/*",
]);

function describeGuard(info: GuardInfo): string {
  if (info.kind !== "scopes") return info.kind;
  return info.scopes.join(info.mode === "all" ? " " : " | ");
}

/** The deployed app's endpoints, grouped by method + path, in execution order. */
function endpoints(): Map<string, unknown[]> {
  const groups = new Map<string, unknown[]>();
  for (const r of app.routes) {
    if (r.method === "ALL") continue;
    const key = `${r.method} ${r.path}`;
    groups.set(key, [...(groups.get(key) ?? []), r.handler]);
  }
  return groups;
}

describe("API key scope coverage", () => {
  it("has a guard on every endpoint, matching the manifest", () => {
    const actual: Record<string, string> = {};
    for (const [route, handlers] of endpoints()) {
      // The last handler is the endpoint itself; guards must run before it.
      const guards = handlers
        .slice(0, -1)
        .map(guardInfo)
        .filter((g) => g !== undefined);
      actual[route] = guards.map(describeGuard).join(" + ") || "UNGUARDED";
    }
    expect(actual).toEqual(MANIFEST);
  });

  it("mounts apiKeyRouteGate on every path, before any endpoint", () => {
    const gate = app.routes.findIndex(
      (r) => r.method === "ALL" && r.path === "/*" && r.handler === apiKeyRouteGate,
    );
    expect(gate).toBeGreaterThanOrEqual(0);
    const firstEndpoint = app.routes.findIndex((r) => r.method !== "ALL");
    expect(gate).toBeLessThan(firstEndpoint);
  });

  it("has no guard placed after its endpoint", () => {
    for (const [route, handlers] of endpoints()) {
      expect(guardInfo(handlers.at(-1)), route).toBeUndefined();
    }
  });

  it("registers catch-all (ALL) handlers only as middleware on known prefixes", () => {
    const allPaths = app.routes.filter((r) => r.method === "ALL").map((r) => r.path);
    for (const path of allPaths) expect(MIDDLEWARE_PATHS, path).toContain(path);
  });

  it("uses every registered scope on some route", () => {
    const used = new Set(Object.values(MANIFEST).flatMap((v) => v.split(/[ |+]+/)));
    for (const scope of ALL_SCOPES) expect(used, scope).toContain(scope);
  });
});
