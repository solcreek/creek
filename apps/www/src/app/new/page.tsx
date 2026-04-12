import type { Metadata } from "next";
import DeployForm from "./deploy-form";

/**
 * /new — server component wrapper for the deploy form.
 *
 * Exists solely to export generateMetadata() so social previews of
 * `/new?repo=https://github.com/owner/repo` show a per-repo card
 * instead of the generic Creek brand card. The actual deploy UI is
 * a client component in ./deploy-form.tsx.
 *
 * Metadata priority:
 *   1. ?repo= present → per-repo og:title + og:image from og.creek.dev
 *   2. ?template= present → template-specific og:title, generic card
 *   3. Neither → falls through to root layout default (Creek brand card)
 */

function parseRepoParam(searchParams: Record<string, string | string[] | undefined>): {
  owner: string;
  repo: string;
} | null {
  const raw = (searchParams.repo ?? searchParams.url) as string | undefined;
  if (!raw) return null;

  const cleaned = raw
    .replace(/^gh:/, "")
    .replace(/^github:/, "")
    .replace(/^https?:\/\//, "")
    .replace(/^github\.com\//, "")
    .replace(/\.git$/, "");

  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length < 2) return null;

  const owner = parts[0];
  const repo = parts[1];
  if (!/^[a-zA-Z0-9._-]+$/.test(owner) || !/^[a-zA-Z0-9._-]+$/.test(repo)) {
    return null;
  }
  return { owner, repo };
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<Metadata> {
  const params = await searchParams;
  const parsed = parseRepoParam(params);

  if (!parsed) {
    // No repo → template or generic. Let root layout defaults apply.
    const template = params.template as string | undefined;
    if (template) {
      return {
        title: `Deploy ${template} template — Creek`,
        description: `Deploy the ${template} template to a live URL in ~15 seconds. No signup.`,
      };
    }
    return {};
  }

  const { owner, repo } = parsed;
  const title = `Deploy ${owner}/${repo} to Creek`;
  const description = `Deploy this repo to Creek in ~15 seconds — no signup, no config, free sandbox URL.`;
  const ogImage = `https://og.creek.dev/deploy/gh/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  return {
    title,
    description,
    openGraph: {
      type: "website",
      siteName: "Creek",
      title,
      description,
      images: [
        {
          url: ogImage,
          width: 1200,
          height: 630,
          alt: title,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      site: "@useCreek",
      title,
      description,
      images: [ogImage],
    },
  };
}

export default function NewPage() {
  return <DeployForm />;
}
