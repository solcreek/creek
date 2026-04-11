/**
 * @solcreek/og-api — Dynamic OpenGraph image service for Creek.
 *
 * Phase 1 (current): hosted-only CF Worker, powers social cards for
 * creek.dev's deploy buttons and template gallery. Internal use.
 * Rendering primitives (ImageResponse, brand tokens, card templates)
 * live in `packages/og` as `@solcreek/og` — consumed here via
 * workspace reference. This worker is also the reference consumer
 * for the library.
 *
 * Phase 2 (planned): flip `packages/og` from `"private": true` to
 * published and cut `@solcreek/og@0.1.0` on npm, so Creek users can
 * embed dynamic OG images in their own deployed workers the same way
 * @vercel/og works on Vercel.
 *
 * Phase 3 (planned): `npx creek deploy --template og` scaffolds a
 * project-local OG service on the user's creek subdomain, connected to
 * their project's metadata via runtime bindings.
 *
 * ---
 *
 * Deployed at: https://og.creek.dev
 *
 * Endpoints:
 *   GET /                                       → redirect to creek.dev
 *   GET /health                                 → { status: "ok", version: "..." }
 *   GET /deploy/:provider/:owner/:repo          → deploy button card PNG
 *                                                  (provider: gh|github|gl|gitlab|bb|bitbucket)
 *   GET /brand                                  → generic Creek brand card PNG
 *
 * All image responses are cached at the CF edge for 24h (s-maxage=86400)
 * and in the browser for 1h (max-age=3600). Upstream GitHub metadata is
 * fetched with next.revalidate=3600 to avoid hammering GitHub's unauth
 * rate limits.
 *
 * Image generation uses `workers-og` which wraps satori + resvg-wasm +
 * yoga-wasm-web — the same underlying stack as @vercel/og but compiled
 * for the Cloudflare Workers runtime. This is why it lives as its own
 * Worker rather than being bundled into apps/www: the wasm modules don't
 * survive Next.js/OpenNextJS's webpack pass.
 */

import { Hono } from "hono";
import {
  ImageResponse,
  brandCard,
  deployButtonCard,
} from "@solcreek/og";

type Env = {
  CREEK_ORIGIN: string;
};

const app = new Hono<{ Bindings: Env }>();

// ---- Health / root ----

app.get("/", (c) => {
  return c.redirect(c.env.CREEK_ORIGIN, 302);
});

app.get("/health", (c) => {
  return c.json({
    status: "ok",
    service: "creek-og-api",
    version: "0.1.0",
  });
});

// ---- Deploy button card ----

const PROVIDER_MAP: Record<string, { host: string; displayName: string }> = {
  gh: { host: "github.com", displayName: "GitHub" },
  github: { host: "github.com", displayName: "GitHub" },
  gl: { host: "gitlab.com", displayName: "GitLab" },
  gitlab: { host: "gitlab.com", displayName: "GitLab" },
  bb: { host: "bitbucket.org", displayName: "Bitbucket" },
  bitbucket: { host: "bitbucket.org", displayName: "Bitbucket" },
};

/**
 * Validate an owner/repo segment — GitHub's own rules: alphanumeric,
 * hyphens, dots, underscores. This prevents weird paths from being
 * interpolated into HTML text nodes or URLs in the rendered image.
 */
function safeName(name: string | undefined): string | null {
  if (!name) return null;
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) return null;
  return name;
}

/**
 * Fetch a GitHub repo's public metadata. Returns null for 404 / rate
 * limit / any other failure — the card template falls back to no
 * description in that case rather than erroring out the image response.
 */
async function fetchGitHubDescription(
  owner: string,
  repo: string,
): Promise<string | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "creek-og-api",
      },
      // Cache in CF for 1h — description doesn't change often and we
      // don't want to hammer GitHub's 60/hr unauth limit.
      cf: { cacheTtl: 3600, cacheEverything: true },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { description: string | null };
    return data.description;
  } catch {
    return null;
  }
}

app.get("/deploy/:provider/:owner/:repo", async (c) => {
  const providerKey = c.req.param("provider")?.toLowerCase();
  const owner = safeName(c.req.param("owner"));
  const repoRaw = c.req.param("repo");
  const repo = safeName(repoRaw?.replace(/\.git$/, ""));

  const provider = providerKey ? PROVIDER_MAP[providerKey] : undefined;

  // Invalid params → fall back to generic Creek brand card, still 200
  // so social crawlers get a valid image instead of a broken image icon.
  if (!provider || !owner || !repo) {
    return renderBrandCard();
  }

  // Only GitHub is wired for description fetch today; GitLab/Bitbucket
  // cards render with just owner/repo until the registry supports them.
  const description =
    provider.host === "github.com"
      ? await fetchGitHubDescription(owner, repo)
      : null;

  return new ImageResponse(
    deployButtonCard({
      owner,
      repo,
      description,
      providerHost: provider.host,
    }),
    { width: 1200, height: 630 },
  );
});

// ---- Generic Creek brand card ----

app.get("/brand", () => renderBrandCard());

function renderBrandCard(): Response {
  const response = new ImageResponse(brandCard(), {
    width: 1200,
    height: 630,
  });
  response.headers.set("Cache-Control", "public, max-age=3600, s-maxage=86400");
  response.headers.set("CDN-Cache-Control", "public, max-age=86400");
  return response;
}

// ---- 404 fallback ----

app.notFound((c) => {
  return c.json({ error: "not_found", service: "creek-og-api" }, 404);
});

export default app;
