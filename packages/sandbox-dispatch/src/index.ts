interface Env {
  DISPATCHER: {
    get(
      name: string,
      metadata?: Record<string, unknown>,
      options?: { limits?: { cpuMs?: number; subRequests?: number } },
    ): { fetch(request: Request): Promise<Response> };
  };
  DB: D1Database;
  KV: KVNamespace;
  SANDBOX_DOMAIN: string;
}

// --- Visitor cap ---
// Limit each sandbox to 50 unique visitor IPs. Uses KV to track.
const VISITOR_CAP = 50;

// --- MIME type inference ---
// WfP Static Assets does not set Content-Type on responses.

const MIME_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  wasm: "application/wasm",
  map: "application/json; charset=utf-8",
};

import { generateQrSvg } from "./qr.js";

// --- Banner HTML ---

function bannerHtml(sandboxId: string, deployDurationMs: number | null, previewUrl: string): string {
  const durationText = deployDurationMs
    ? `Deployed in ${(deployDurationMs / 1000).toFixed(1)}s`
    : "Deployed in seconds";

  const qrSvg = generateQrSvg(`${previewUrl}?ref=qr`, 3, 1);
  const qrDataUri = `data:image/svg+xml;base64,${btoa(qrSvg)}`;

  // Randomized tag name — makes it harder to target with querySelector
  const tag = `creek-sb-${sandboxId.slice(0, 4)}`;

  // Banner uses closed Shadow DOM — user JS cannot access internals via
  // element.shadowRoot (returns null for closed mode).
  // A periodic integrity check re-creates the element if removed.
  return `
<script>
(function(){
  var T="${tag}",S="${sandboxId}",D="${durationText}";

  function mk(){
    if(document.querySelector(T))return;
    var el=document.createElement(T);
    el.setAttribute("style","position:fixed;bottom:0;left:0;right:0;z-index:2147483647;");
    var sh=el.attachShadow({mode:"closed"});
    sh.innerHTML=
      '<style>'+
      ':host{display:block;font-family:system-ui,-apple-system,sans-serif;font-size:13px}'+
      '.b{background:linear-gradient(180deg,rgba(10,10,10,0.97),rgba(10,10,10,1));border-top:1px solid rgba(255,255,255,0.08);padding:10px 20px;display:flex;align-items:center;justify-content:space-between;color:#aaa;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}'+
      '.l{display:flex;align-items:center;gap:14px}'+
      '.r{display:flex;align-items:center;gap:10px}'+
      'a{text-decoration:none}'+
      '.logo{display:flex;align-items:center;gap:8px;color:#fff}'+
      '.logo span{font-weight:700;font-size:14px;letter-spacing:-0.02em}'+
      '.sep{color:rgba(255,255,255,0.15)}'+
      '.dur{color:#888;font-size:12px}'+
      '.fp{color:#666;font-size:12px}'+
      '.lm{color:#888;font-size:12px;transition:color 0.15s}'+
      '.lm:hover{color:#fff}'+
      '.cta{color:#fff;background:linear-gradient(135deg,#2563eb,#3b82f6);padding:5px 14px;border-radius:7px;font-weight:600;font-size:12px;transition:opacity 0.15s;box-shadow:0 1px 3px rgba(37,99,235,0.3)}'+
      '.cta:hover{opacity:0.9}'+
      '.qr-wrap{position:relative;display:flex;align-items:center;cursor:pointer}'+
      '.qr-wrap svg{width:18px;height:18px;stroke:#666;transition:stroke 0.15s}'+
      '.qr-wrap:hover svg{stroke:#fff}'+
      '.qr-pop{display:none;position:absolute;bottom:40px;right:-8px;background:#fff;border-radius:10px;padding:12px;box-shadow:0 8px 30px rgba(0,0,0,0.6)}'+
      '.qr-wrap:hover .qr-pop{display:block}'+
      '.qr-pop img{display:block;width:160px;height:160px}'+
      '.qr-pop span{display:block;text-align:center;font-size:11px;color:#666;margin-top:6px}'+
      '@media(max-width:640px){'+
        '.b{flex-wrap:wrap;gap:8px;padding:8px 12px}'+
        '.l{flex:1 1 100%;justify-content:center}'+
        '.r{flex:1 1 100%;justify-content:center}'+
        '.sep{display:none}'+
        '.fp{display:none}'+
        '.qr-wrap{display:none}'+
        '.logo span{font-size:13px}'+
        '.dur{font-size:11px}'+
        '.lm{font-size:11px}'+
        '.cta{font-size:11px;padding:4px 12px}'+
      '}'+
      '</style>'+
      '<div class="b">'+
      '<div class="l">'+
      '<a href="https://creek.dev?ref=banner" target="_blank" class="logo">'+
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>'+
      '<span>Creek</span>'+
      '</a>'+
      '<span class="sep">|</span>'+
      '<span class="dur">'+D+'</span>'+
      '<span class="sep">·</span>'+
      '<span class="fp">Free preview</span>'+
      '</div>'+
      '<div class="r">'+
      '<div class="qr-wrap">'+
      '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="8" height="8" rx="1"/><rect x="14" y="2" width="8" height="8" rx="1"/><rect x="2" y="14" width="8" height="8" rx="1"/><rect x="14" y="14" width="4" height="4" rx="0.5"/><line x1="22" y1="14" x2="22" y2="22"/><line x1="14" y1="22" x2="22" y2="22"/></svg>'+
      '<div class="qr-pop"><img src="${qrDataUri}" alt="QR"/><span>Scan to view on mobile</span></div>'+
      '</div>'+
      '<a href="https://creek.dev?ref=banner" target="_blank" class="lm">Learn more</a>'+
      '<a href="https://app.creek.dev/login?sandbox_id='+S+'&ref=banner" class="cta">Make it permanent →</a>'+
      '</div>'+
      '</div>';
    document.body.appendChild(el);
  }

  // Create banner
  if(document.body)mk();
  else document.addEventListener("DOMContentLoaded",mk);

  // Integrity check — re-create if removed (every 2s)
  setInterval(function(){
    if(!document.querySelector(T))mk();
  },2000);

  // Also guard against display:none via user CSS on the host element
  setInterval(function(){
    var el=document.querySelector(T);
    if(el){
      el.style.cssText="position:fixed;bottom:0;left:0;right:0;z-index:2147483647;display:block;visibility:visible;opacity:1;pointer-events:auto;";
    }
  },3000);
})();
</script>`;
}

// --- Main handler ---

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const hostname = url.hostname;
    const domain = env.SANDBOX_DOMAIN;

    // Extract sandbox ID from hostname: {sandboxId}.creeksandbox.com
    const suffix = `.${domain}`;
    if (!hostname.endsWith(suffix)) {
      return Response.json({ error: "not_found", message: "Unknown hostname" }, { status: 404 });
    }

    const sandboxId = hostname.slice(0, -suffix.length);
    if (!sandboxId || sandboxId.includes(".")) {
      return Response.json({ error: "not_found", message: "Invalid sandbox hostname" }, { status: 404 });
    }

    // Look up sandbox record
    const sandbox = await env.DB.prepare(
      "SELECT id, status, expiresAt, previewHost, deployDurationMs FROM sandbox WHERE id = ?",
    )
      .bind(sandboxId)
      .first<{ id: string; status: string; expiresAt: number; previewHost: string; deployDurationMs: number | null }>();

    if (!sandbox) {
      return Response.json({ error: "not_found", message: "Sandbox not found" }, { status: 404 });
    }

    // Check blocked (abuse auto-ban)
    if (sandbox.status === "blocked") {
      return new Response(blockedPage(), {
        status: 451,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // Check expiry
    if (sandbox.status === "expired" || (sandbox.status === "active" && Date.now() > sandbox.expiresAt)) {
      return new Response(expiredPage(sandboxId), {
        status: 410,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // Check if still deploying
    if (sandbox.status !== "active") {
      return Response.json(
        { error: "not_ready", message: `Sandbox is ${sandbox.status}`, status: sandbox.status },
        { status: 503, headers: { "Retry-After": "3" } },
      );
    }

    // Visitor cap — limit unique IPs per sandbox
    const visitorIp = request.headers.get("cf-connecting-ip") ?? "unknown";
    const visitorKey = `v:${sandboxId}:${visitorIp}`;
    const existing = await env.KV.get(visitorKey);
    if (!existing) {
      // Count current unique visitors
      const countKey = `vc:${sandboxId}`;
      const rawCount = await env.KV.get(countKey);
      const count = rawCount ? parseInt(rawCount, 10) : 0;

      if (count >= VISITOR_CAP) {
        return new Response(visitorCapPage(), {
          status: 429,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // Register this visitor — TTL matches sandbox expiry
      const ttlSeconds = Math.max(60, Math.ceil((sandbox.expiresAt - Date.now()) / 1000));
      await env.KV.put(visitorKey, "1", { expirationTtl: ttlSeconds });
      await env.KV.put(countKey, String(count + 1), { expirationTtl: ttlSeconds });
    }

    // Dispatch to user worker
    // Script name: {sandboxId}-sandbox (matches deployWithAssets output: {projectSlug}-{teamSlug})
    const scriptName = `${sandboxId}-sandbox`;

    try {
      const userWorker = env.DISPATCHER.get(
        scriptName,
        {},
        { limits: { cpuMs: 10, subRequests: 5 } }, // sandbox = free tier limits
      );
      let response = await userWorker.fetch(request);

      // Infer Content-Type if missing
      if (response.ok && !response.headers.get("Content-Type")) {
        const lastSegment = url.pathname.split("/").pop() ?? "";
        const ext = lastSegment.includes(".") ? lastSegment.split(".").pop()?.toLowerCase() ?? "" : "";
        const contentType = ext ? (MIME_TYPES[ext] ?? "application/octet-stream") : "text/html; charset=utf-8";
        const headers = new Headers(response.headers);
        headers.set("Content-Type", contentType);
        response = new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }

      // Prevent CDN cache cross-contamination between sandboxes.
      // WfP Static Assets may return shared cache keys — ensure each
      // sandbox response has its own cache scope via Vary + sandbox ID.
      {
        const headers = new Headers(response.headers);
        headers.set("Cache-Control", "public, max-age=300, s-maxage=300");
        headers.set("Vary", "Host");
        headers.set("X-Sandbox-Id", sandboxId);
        response = new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }

      // Inject banner into HTML responses
      const ct = response.headers.get("Content-Type") ?? "";
      if (ct.includes("text/html") && response.ok) {
        const html = await response.text();
        const banner = bannerHtml(sandboxId, sandbox.deployDurationMs, `https://${sandbox.previewHost}`);
        // Try </body> first, fall back to </html>, fall back to append
        const injected = html.includes("</body>")
          ? html.replace("</body>", `${banner}</body>`)
          : html.includes("</html>")
            ? html.replace("</html>", `${banner}</html>`)
            : html + banner;

        const headers = new Headers(response.headers);
        headers.set("X-Robots-Tag", "noindex, nofollow");
        headers.set("X-Sandbox-Expires-At", new Date(sandbox.expiresAt).toISOString());
        headers.delete("Content-Length"); // length changed after injection

        return new Response(injected, {
          status: response.status,
          headers,
        });
      }

      return response;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.startsWith("Worker not found")) {
        return Response.json({ error: "not_found", message: "Sandbox deployment not found" }, { status: 404 });
      }
      return Response.json({ error: "internal", message: `Sandbox error: ${message}` }, { status: 500 });
    }
  },
};

function visitorCapPage(): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Visitor Limit — Creek</title>
<style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#0a0a0a;color:#eee;}
.card{text-align:center;padding:2rem;max-width:400px;}
h1{font-size:1.5rem;margin-bottom:0.5rem;}
p{color:#888;margin:0.5rem 0;}
a{color:#2563eb;text-decoration:none;}
.btn{display:inline-block;background:#2563eb;color:#fff;padding:8px 20px;border-radius:8px;margin-top:1rem;font-weight:500;}
</style></head>
<body><div class="card">
<h1>Visitor Limit Reached</h1>
<p>This free sandbox preview has reached its visitor limit.</p>
<p>Deploy your own project for unlimited visitors.</p>
<a href="https://creek.dev?ref=visitor-cap" class="btn">Get Started with Creek &rarr;</a>
</div></body></html>`;
}

function blockedPage(): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Content Removed — Creek</title>
<style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#0a0a0a;color:#eee;}
.card{text-align:center;padding:2rem;max-width:400px;}
h1{font-size:1.5rem;margin-bottom:0.5rem;}
p{color:#888;margin:0.5rem 0;}
a{color:#2563eb;text-decoration:none;}
</style></head>
<body><div class="card">
<h1>Content Removed</h1>
<p>This sandbox has been taken down due to a content policy violation.</p>
<p>If you believe this is a mistake, contact <a href="mailto:abuse@creek.dev">abuse@creek.dev</a>.</p>
</div></body></html>`;
}

function expiredPage(sandboxId: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Sandbox Expired — Creek</title>
<style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#0a0a0a;color:#eee;}
.card{text-align:center;padding:2rem;max-width:400px;}
h1{font-size:1.5rem;margin-bottom:0.5rem;}
p{color:#888;margin:0.5rem 0;}
a{color:#2563eb;text-decoration:none;}
.btn{display:inline-block;background:#2563eb;color:#fff;padding:8px 20px;border-radius:8px;margin-top:1rem;font-weight:500;}
</style></head>
<body><div class="card">
<h1>Sandbox Expired</h1>
<p>This sandbox has reached its 60-minute time limit.</p>
<p>Want to deploy your own project permanently?</p>
<a href="https://app.creek.dev/login?sandbox_id=${sandboxId}" class="btn">Get Started with Creek &rarr;</a>
</div></body></html>`;
}
