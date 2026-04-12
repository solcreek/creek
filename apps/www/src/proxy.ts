import { NextResponse, type NextRequest } from "next/server";

/**
 * Content negotiation proxy (Next.js 16 — was `middleware` before the
 * file-convention rename).
 *
 * When an AI agent requests a page with Accept: text/markdown or
 * text/plain, set a header so the page can return agent-friendly
 * content. Gives agents clean, parseable content instead of HTML.
 *
 * Next.js 16 kept emitting the internal `middleware-manifest.json`
 * build artefact under the old name for compatibility, so OpenNextJS
 * (which reads that manifest) works unchanged after this rename.
 */
export function proxy(request: NextRequest) {
  const accept = request.headers.get("accept") ?? "";
  const isAgentRequest =
    accept.includes("text/markdown") ||
    accept.includes("text/plain") ||
    request.headers.get("user-agent")?.includes("Claude") ||
    request.headers.get("user-agent")?.includes("GPT");

  // Only negotiate on doc pages and the homepage
  const { pathname } = request.nextUrl;
  const isNegotiable =
    pathname === "/" ||
    pathname.startsWith("/docs") ||
    pathname === "/pricing" ||
    pathname === "/changelog";

  if (isAgentRequest && isNegotiable) {
    // Return a simplified text response with key info
    const response = NextResponse.next();
    response.headers.set("X-Content-Negotiation", "agent");
    response.headers.set("Vary", "Accept");
    return response;
  }

  // Normal browser request
  const response = NextResponse.next();
  response.headers.set("Vary", "Accept");
  return response;
}

export const config = {
  matcher: [
    // Match all paths except static assets
    "/((?!_next/static|_next/image|favicon.ico|llms.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp|woff|woff2|css|js)).*)",
  ],
};
