import { Hono } from "hono";
import type { Env } from "../../types.js";

type PreviewEnv = {
  Bindings: Env;
};

const preview = new Hono<PreviewEnv>();

/**
 * Server-side preview: render template + data → HTML
 * No auth required — used for shareable preview links.
 * Preview ID is a short-lived token stored in KV/D1.
 *
 * POST /preview/render
 * { "html": "<html>{{name}}...</html>", "data": { "name": "John" } }
 * → HTML response (rendered)
 *
 * This is the "Preview URL" mechanism.
 * For "Instant Preview", the client renders locally in an iframe (no API call).
 */
preview.post("/render", async (c) => {
  const body = await c.req.json<{
    html: string;
    data?: Record<string, string>;
    css?: string;
  }>();

  if (!body.html) {
    return c.json({ error: "validation", message: "html is required" }, 400);
  }

  let rendered = body.html;

  // Simple Mustache-like replacement: {{key}} → value
  if (body.data) {
    for (const [key, value] of Object.entries(body.data)) {
      const escaped = escapeHtml(value);
      rendered = rendered.replaceAll(`{{${key}}}`, escaped);
    }
  }

  // Inject CSS override if provided
  if (body.css) {
    rendered = rendered.replace("</head>", `<style>${body.css}</style></head>`);
  }

  return c.html(rendered);
});

/**
 * Create a shareable preview — stores rendered HTML temporarily.
 *
 * POST /preview/create
 * { "html": "...", "data": {...}, "ttl": 3600 }
 * → { "previewId": "abc123", "previewUrl": "https://.../preview/v/abc123" }
 */
preview.post("/create", async (c) => {
  const body = await c.req.json<{
    html: string;
    data?: Record<string, string>;
    css?: string;
    ttl?: number;
  }>();

  if (!body.html) {
    return c.json({ error: "validation", message: "html is required" }, 400);
  }

  let rendered = body.html;
  if (body.data) {
    for (const [key, value] of Object.entries(body.data)) {
      rendered = rendered.replaceAll(`{{${key}}}`, escapeHtml(value));
    }
  }
  if (body.css) {
    rendered = rendered.replace("</head>", `<style>${body.css}</style></head>`);
  }

  // Store in R2 with a short-lived key
  const previewId = crypto.randomUUID().slice(0, 12);
  const key = `_previews/${previewId}.html`;
  await c.env.ASSETS.put(key, rendered, {
    customMetadata: {
      expires: new Date(Date.now() + (body.ttl ?? 3600) * 1000).toISOString(),
    },
  });

  const baseUrl = new URL(c.req.url).origin;

  return c.json({
    previewId,
    previewUrl: `${baseUrl}/preview/v/${previewId}`,
  }, 201);
});

/**
 * View a shareable preview.
 *
 * GET /preview/v/:id
 * → HTML response
 */
preview.get("/v/:id", async (c) => {
  const id = c.req.param("id");
  const key = `_previews/${id}.html`;

  const object = await c.env.ASSETS.get(key);
  if (!object) {
    return c.text("Preview not found or expired", 404);
  }

  // Check expiry
  const expires = object.customMetadata?.expires;
  if (expires && new Date(expires) < new Date()) {
    await c.env.ASSETS.delete(key);
    return c.text("Preview expired", 410);
  }

  return c.html(await object.text());
});

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export { preview };
