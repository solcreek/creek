import type { Hono } from "hono";
import type { Env } from "../types.js";

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  png: "image/png",
  svg: "image/svg+xml",
  ico: "image/x-icon",
};

/**
 * Local dev only: stand in for the dispatch worker by serving a project's
 * production deployment from ASSETS at GET /preview/:slug/*.
 *
 * Mounted by serve.ts, never by the deployed Worker: it is unauthenticated
 * and would serve any project's assets by slug from the control-plane host.
 */
export function mountLocalPreview<E extends { Bindings: Env }>(app: Hono<E>): void {
  app.get("/preview/:slug/*", async (c) => {
    const slug = c.req.param("slug");
    const project = await c.env.DB.prepare(
      "SELECT id, productionDeploymentId FROM project WHERE slug = ?",
    )
      .bind(slug)
      .first<{ id: string; productionDeploymentId: string | null }>();

    if (!project?.productionDeploymentId) {
      return c.text("Project not found or no production deployment", 404);
    }

    const prefix = `${project.id}/${project.productionDeploymentId}`;
    const reqPath = c.req.path.replace(`/preview/${slug}`, "") || "/index.html";
    const assetPath = reqPath === "/" ? "/index.html" : reqPath;

    const object = await c.env.ASSETS.get(`${prefix}${assetPath}`);
    if (object) {
      const ext = assetPath.split(".").pop()?.toLowerCase() ?? "";
      return new Response(object.body as ReadableStream, {
        headers: { "Content-Type": CONTENT_TYPES[ext] || "application/octet-stream" },
      });
    }

    // SPA fallback
    const fallback = await c.env.ASSETS.get(`${prefix}/index.html`);
    if (fallback) {
      return new Response(fallback.body as ReadableStream, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return c.text("Not Found", 404);
  });
}
