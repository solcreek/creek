import { Hono } from "hono";
import type { Env } from "../../types.js";

type TemplateEnv = {
  Bindings: Env;
};

const templates = new Hono<TemplateEnv>();

// --- R2 helpers ---

function r2Key(templateId: string, file: string): string {
  return `_templates/${templateId}/${file}`;
}

async function readR2Text(env: Env, key: string): Promise<string | null> {
  const obj = await env.ASSETS.get(key);
  return obj ? await obj.text() : null;
}

// --- Routes ---

/**
 * List templates (public, no auth)
 * GET /templates?category=dark&limit=20
 */
templates.get("/", async (c) => {
  const category = c.req.query("category");
  const limit = parseInt(c.req.query("limit") ?? "50");

  let query = "SELECT id, name, category, thumbnail_url, generated_by, created_at FROM templates";
  const params: string[] = [];

  if (category) {
    query += " WHERE category = ?";
    params.push(category);
  }
  query += " ORDER BY created_at DESC LIMIT ?";
  params.push(String(limit));

  const rows = await c.env.DB.prepare(query).bind(...params).all();
  return c.json(rows.results);
});

/**
 * Get a single template with full HTML + schema (for editor)
 * GET /templates/:id
 */
templates.get("/:id", async (c) => {
  const id = c.req.param("id");
  if (id === "editor" || id.includes("/")) return c.notFound();

  const meta = await c.env.DB.prepare("SELECT * FROM templates WHERE id = ?")
    .bind(id)
    .first();

  if (!meta) {
    return c.json({ error: "not_found", message: "Template not found" }, 404);
  }

  // Read HTML + CSS from R2
  const html = await readR2Text(c.env, r2Key(id, "index.html"));
  const css = await readR2Text(c.env, r2Key(id, "styles.css"));

  return c.json({
    ...meta,
    schema: JSON.parse((meta.schema as string) || "{}"),
    html: html ?? (meta.html_template as string) ?? "",
    css: css ?? null,
  });
});

/**
 * Create a template
 * POST /templates
 * { name, category?, html, css?, schema, generated_by? }
 *
 * HTML and CSS stored in R2, metadata in D1.
 */
templates.post("/", async (c) => {
  const body = await c.req.json<{
    name: string;
    category?: string;
    thumbnail_url?: string;
    html: string;
    css?: string;
    schema: { fields: TemplateField[] };
    generated_by?: string;
  }>();

  if (!body.name || !body.html) {
    return c.json({ error: "validation", message: "name and html required" }, 400);
  }

  const id = crypto.randomUUID().slice(0, 12);

  // Store HTML + CSS in R2
  await c.env.ASSETS.put(r2Key(id, "index.html"), body.html, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
  });
  if (body.css) {
    await c.env.ASSETS.put(r2Key(id, "styles.css"), body.css, {
      httpMetadata: { contentType: "text/css; charset=utf-8" },
    });
  }

  // Store metadata in D1 (no html_template — it's in R2 now)
  await c.env.DB.prepare(
    "INSERT INTO templates (id, name, category, thumbnail_url, html_template, schema, generated_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      id,
      body.name,
      body.category ?? "minimal",
      body.thumbnail_url ?? null,
      "", // legacy column, HTML now in R2
      JSON.stringify(body.schema),
      body.generated_by ?? "manual",
    )
    .run();

  return c.json({ id }, 201);
});

/**
 * Editor page
 * GET /templates/:id/editor
 *
 * Loads template data from API, renders form from schema,
 * uses postMessage for flicker-free live preview.
 */
templates.get("/:id/editor", async (c) => {
  const id = c.req.param("id");
  const meta = await c.env.DB.prepare("SELECT * FROM templates WHERE id = ?")
    .bind(id)
    .first<{ id: string; name: string; schema: string }>();

  if (!meta) return c.text("Template not found", 404);

  const html = await readR2Text(c.env, r2Key(id, "index.html"));
  const css = await readR2Text(c.env, r2Key(id, "styles.css"));
  if (!html) return c.text("Template HTML not found in R2", 404);

  const schema = JSON.parse(meta.schema || "{}");
  const fields: TemplateField[] = schema.fields || [];
  const apiBase = new URL(c.req.url).origin;

  return c.html(generateEditorHtml(meta.id, meta.name, html, css, fields, apiBase));
});

interface TemplateField {
  key: string;
  label: string;
  type: "text" | "textarea" | "image" | "color" | "links";
  placeholder?: string;
  default?: string;
  max?: number;
}

function generateEditorHtml(
  templateId: string,
  templateName: string,
  htmlTemplate: string,
  cssTemplate: string | null,
  fields: TemplateField[],
  apiBase: string,
): string {
  // If template has a separate CSS file, inject it into the HTML <head>
  let fullTemplate = htmlTemplate;
  if (cssTemplate && !htmlTemplate.includes("<style>")) {
    fullTemplate = fullTemplate.replace("</head>", `<style>${cssTemplate}</style></head>`);
  }

  const escapedTemplate = JSON.stringify(fullTemplate);

  const formFieldsHtml = fields
    .map((f) => {
      if (f.type === "color") {
        return `<div class="field">
            <label>${esc(f.label)}</label>
            <input type="color" name="${esc(f.key)}" value="${esc(f.default || "#000000")}" oninput="onEdit()">
          </div>`;
      }
      if (f.type === "textarea") {
        return `<div class="field">
            <label>${esc(f.label)}</label>
            <textarea name="${esc(f.key)}" placeholder="${esc(f.placeholder || "")}" oninput="onEdit()">${esc(f.default || "")}</textarea>
          </div>`;
      }
      if (f.type === "image") {
        return `<div class="field">
            <label>${esc(f.label)}</label>
            <input type="url" name="${esc(f.key)}" placeholder="${esc(f.placeholder || "https://...")}" value="${esc(f.default || "")}" oninput="onEdit()">
          </div>`;
      }
      return `<div class="field">
          <label>${esc(f.label)}</label>
          <input type="text" name="${esc(f.key)}" placeholder="${esc(f.placeholder || "")}" value="${esc(f.default || "")}" oninput="onEdit()">
        </div>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Edit: ${esc(templateName)}</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,sans-serif;background:#f5f5f5;height:100vh;display:flex;flex-direction:column}
    header{background:#111;color:#fff;padding:.75rem 1.5rem;display:flex;align-items:center;justify-content:space-between}
    header h1{font-size:.9rem;font-weight:600}
    .actions{display:flex;gap:.5rem;align-items:center}
    .btn{padding:.5rem 1rem;border:none;border-radius:8px;font-size:.8rem;font-weight:600;cursor:pointer}
    .btn-secondary{background:#333;color:#fff}
    .btn-primary{background:#00cc6a;color:#000}
    .btn:hover{opacity:.9}
    main{display:flex;flex:1;overflow:hidden}
    .editor-panel{width:360px;background:#fff;border-right:1px solid #e0e0e0;overflow-y:auto;padding:1.5rem;flex-shrink:0}
    .preview-panel{flex:1;background:#1a1a1a;display:flex;justify-content:center;align-items:flex-start;padding:2rem;overflow-y:auto}
    .preview-panel iframe{width:420px;height:100%;border:none;border-radius:12px;background:#fff;min-height:600px}
    .field{margin-bottom:1rem}
    .field label{display:block;font-size:.75rem;font-weight:600;color:#555;text-transform:uppercase;letter-spacing:.05em;margin-bottom:.35rem}
    .field input[type="text"],.field input[type="url"],.field textarea{width:100%;padding:.6rem .75rem;border:1px solid #ddd;border-radius:8px;font-size:.85rem}
    .field input:focus,.field textarea:focus{outline:none;border-color:#00cc6a}
    .field input[type="color"]{width:48px;height:36px;border:1px solid #ddd;border-radius:8px;cursor:pointer}
    .field textarea{min-height:60px;resize:vertical}
    #status{font-size:.75rem;color:#888}
  </style>
</head>
<body>
  <header>
    <h1>Editing: ${esc(templateName)}</h1>
    <div class="actions">
      <button class="btn btn-secondary" onclick="sharePreview()">Share Preview</button>
      <button class="btn btn-primary" onclick="deploySite()">Deploy</button>
      <span id="status"></span>
    </div>
  </header>
  <main>
    <div class="editor-panel">
      <form id="ef" autocomplete="off">${formFieldsHtml}</form>
    </div>
    <div class="preview-panel">
      <iframe id="pf"></iframe>
    </div>
  </main>
<script>
// --- Data ---
var T = ${escapedTemplate};
var API = "${apiBase}";
var ready = false;

// --- postMessage listener injected into template iframe ---
// It receives {type:"u", t: bodyTemplate, d: data} and patches body innerHTML.
var LISTENER = '<scr'+'ipt>var B;window.addEventListener("message",function(e){'
  + 'if(!e.data||e.data.type!=="u")return;'
  + 'if(e.data.t)B=e.data.t;'
  + 'if(!B)return;'
  + 'var h=B,d=e.data.d||{};'
  + 'Object.keys(d).forEach(function(k){h=h.split("{{"+k+"}}").join(d[k]||"")});'
  + 'h=h.replace(/\\\\{\\\\{[^}]+\\\\}\\\\}/g,"");'
  + 'document.body.innerHTML=h;'
  + '});</'+'script>';

// --- Helpers ---
function data() {
  var o = {};
  document.querySelectorAll('#ef [name]').forEach(function(el) { o[el.name] = el.value; });
  return o;
}

function render(d) {
  var h = T;
  Object.keys(d).forEach(function(k) { h = h.split('{{'+k+'}}').join(d[k]||''); });
  return h.replace(/\\{\\{[^}]+\\}\\}/g, '');
}

function bodyOf(html) {
  var m = html.match(/<body[^>]*>([\\s\\S]*)<\\/body>/i);
  return m ? m[1] : html;
}

// --- Preview ---
function initPreview() {
  var d = data();
  var full = render(d);
  // Inject listener before </body>
  full = full.replace('</body>', LISTENER + '</body>');
  var iframe = document.getElementById('pf');
  iframe.srcdoc = full;
  iframe.onload = function() {
    ready = true;
    // Send body template + initial data
    iframe.contentWindow.postMessage({ type:'u', t: bodyOf(T), d: d }, '*');
  };
}

function onEdit() {
  var d = data();
  var iframe = document.getElementById('pf');
  if (ready && iframe.contentWindow) {
    iframe.contentWindow.postMessage({ type:'u', d: d }, '*');
  }
}

// --- Actions ---
async function sharePreview() {
  var s = document.getElementById('status');
  s.textContent = 'Creating...';
  var r = await fetch(API+'/preview/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({html:render(data()),ttl:3600})});
  var j = await r.json();
  if(j.previewUrl){navigator.clipboard.writeText(j.previewUrl).catch(function(){});s.textContent='URL copied!';window.open(j.previewUrl,'_blank');}
}

async function deploySite() {
  var slug = prompt('Choose a URL slug:','');
  if(!slug)return;
  var s = document.getElementById('status');
  s.textContent = 'Deploying...';
  var r = await fetch(API+'/instant-deploy',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+(prompt('API token:')||'')},body:JSON.stringify({slug:slug,files:{'index.html':render(data())}})});
  var j = await r.json();
  s.textContent = j.url ? 'Deployed!' : 'Error: '+(j.message||'?');
  if(j.url) window.open(j.url,'_blank');
}

initPreview();
</script>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export { templates };
