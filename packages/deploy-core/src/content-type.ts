/**
 * Content-Type for a static asset served through Workers for Platforms.
 *
 * WfP Static Assets returns no Content-Type, so both dispatch workers (the
 * production dispatcher and the sandbox dispatcher) fill it in from the
 * request path. This is the one table they share; it used to be two copies,
 * which is how `.md` went missing from both (solcreek/creek#60).
 */
export const MIME_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
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

/**
 * Infer a Content-Type from a request path's last segment. An extensionless
 * path is an HTML route; an unknown extension is `application/octet-stream`.
 */
export function inferContentType(pathname: string): string {
  const lastSegment = pathname.split("/").pop() ?? "";
  const ext = lastSegment.includes(".") ? (lastSegment.split(".").pop()?.toLowerCase() ?? "") : "";
  if (!ext) return "text/html; charset=utf-8";
  return MIME_TYPES[ext] ?? "application/octet-stream";
}
