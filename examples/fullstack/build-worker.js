// Bundles worker/index.ts into dist/worker.js
// Strategy: bundle user code with `loopix` as external,
// then prepend the runtime source and rewrite the import.

import { build } from "esbuild";
import { readFileSync, writeFileSync } from "fs";

// Bundle user code — keep `loopix` as external (don't inline it)
await build({
  entryPoints: ["worker/index.ts"],
  bundle: true,
  format: "esm",
  platform: "neutral",
  outfile: "dist/_user_worker.js",
  external: ["loopix"],
});

// Read the bundled user code and the runtime source
let userCode = readFileSync("dist/_user_worker.js", "utf-8");
const runtimeCode = readFileSync(
  "../../packages/runtime/dist/index.js",
  "utf-8",
);

// Remove the `import ... from "loopix"` line — we'll inline the runtime instead
userCode = userCode.replace(/import\s*\{[^}]*\}\s*from\s*["']loopix["'];?\n?/g, "");

const workerEntry = `
// === Loopix Runtime ===
${runtimeCode}

// === User Code ===
${userCode}

// === Worker Entry ===
const CONTENT_TYPES = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  woff2: "font/woff2",
  webp: "image/webp",
  wasm: "application/wasm",
};

function getContentType(path) {
  const ext = path.split(".").pop()?.toLowerCase();
  return CONTENT_TYPES[ext] || "application/octet-stream";
}

export default {
  async fetch(request, env) {
    _setEnv(env);

    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return handleApi(request);
    }

    const prefix = env.PROJECT_ID + "/" + env.DEPLOYMENT_ID;
    const path = url.pathname === "/" ? "/index.html" : url.pathname;

    const object = await env.ASSETS.get(prefix + path);
    if (object) {
      const isHashed = path.includes("/assets/");
      return new Response(object.body, {
        headers: {
          "Content-Type": getContentType(path),
          "Cache-Control": isHashed
            ? "public, max-age=31536000, immutable"
            : "public, max-age=0, s-maxage=600",
          "ETag": object.etag,
        },
      });
    }

    if (!path.includes(".")) {
      const fallback = await env.ASSETS.get(prefix + "/index.html");
      if (fallback) {
        return new Response(fallback.body, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "public, max-age=0, s-maxage=600",
          },
        });
      }
    }

    return new Response("Not Found", { status: 404 });
  }
};
`;

writeFileSync("dist/worker.js", workerEntry);
console.log("Worker built: dist/worker.js");
