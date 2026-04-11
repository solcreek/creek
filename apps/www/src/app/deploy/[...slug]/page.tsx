import { redirect } from "next/navigation";

/**
 * Path-based deploy button entry point.
 *
 * Canonical URL shape for "Deploy to Creek" buttons:
 *
 *   creek.dev/deploy/gh/owner/repo
 *   creek.dev/deploy/gl/owner/repo
 *   creek.dev/deploy/bb/owner/repo
 *
 * The path-based form is the shortest, most shareable, most
 * copy-paste-friendly variant — no `?` or `&` chars that shells
 * misinterpret, no URL encoding, looks clean in Twitter threads
 * and README badges.
 *
 * Query-string forms also work via the sibling /deploy route:
 *
 *   creek.dev/deploy?url=https://github.com/owner/repo   (CF-compatible)
 *   creek.dev/deploy?url=gh:owner/repo                   (short prefix)
 *
 * All three eventually render the same /new page component.
 */
export default async function DeployPathPage({
  params,
}: {
  params: Promise<{ slug: string[] }>;
}) {
  const { slug } = await params;

  if (!slug || slug.length < 3) {
    // /deploy/gh or /deploy alone — not enough info; redirect to query form
    redirect("/deploy");
  }

  const [providerRaw, ...rest] = slug;
  const provider = providerRaw.toLowerCase();

  // Map short prefixes to provider hosts. Long forms (`github`, `gitlab`,
  // `bitbucket`) also accepted so both `/deploy/gh/...` and
  // `/deploy/github/...` work.
  const providerMap: Record<string, string> = {
    gh: "github.com",
    github: "github.com",
    gl: "gitlab.com",
    gitlab: "gitlab.com",
    bb: "bitbucket.org",
    bitbucket: "bitbucket.org",
  };

  const host = providerMap[provider];
  if (!host) {
    // Unknown provider — fall back to the query-string /deploy page which
    // will render an error state explaining the issue.
    redirect("/deploy");
  }

  // rest should be [owner, repo, ...optional-extras]. Take the first two.
  const owner = rest[0];
  const repo = rest[1];
  if (!owner || !repo) {
    redirect("/deploy");
  }

  // Strip any trailing .git
  const cleanRepo = repo.replace(/\.git$/, "");

  // Build the canonical URL and forward to /new which handles the render.
  // Using the full URL form (not gh: short) because /new's parser accepts
  // both, and the full URL is unambiguous.
  const fullUrl = `https://${host}/${owner}/${cleanRepo}`;
  redirect(`/new?repo=${encodeURIComponent(fullUrl)}`);
}
