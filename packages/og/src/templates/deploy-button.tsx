/** @jsxImportSource hono/jsx */

/**
 * Deploy button card — 1200x630 PNG for social sharing of
 * `creek.dev/deploy/{provider}/{owner}/{repo}` URLs.
 *
 * Uses satori-compatible JSX: every div has display:flex, no block/grid,
 * no nested layouts beyond flat rows/columns. Satori is stricter than
 * regular CSS — missing display:flex on a container with children causes
 * the rendered image to come out empty.
 */

import { creekBrand } from "../brand.js";

export interface DeployButtonCardProps {
  owner: string;
  repo: string;
  description: string | null;
  providerHost: string;
}

export function deployButtonCard(props: DeployButtonCardProps) {
  const { owner, repo, description } = props;
  const truncatedDesc = description
    ? description.length > 120
      ? description.slice(0, 117) + "…"
      : description
    : "";

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        padding: "72px 80px",
        background: creekBrand.gradients.background,
        color: creekBrand.colors.fg,
        fontFamily: creekBrand.fonts.sans,
      }}
    >
      {/* Brand line */}
      <div
        style={{
          display: "flex",
          fontSize: 26,
          color: creekBrand.colors.mutedFg,
          letterSpacing: 2,
          textTransform: "uppercase",
          marginBottom: 32,
        }}
      >
        Deploy to Creek
      </div>

      {/* Owner / */}
      <div
        style={{
          display: "flex",
          fontSize: 40,
          color: creekBrand.colors.dimFg,
          marginBottom: 12,
        }}
      >
        {owner} /
      </div>

      {/* Repo name — gradient hero */}
      <div
        style={{
          display: "flex",
          fontSize: 96,
          fontWeight: 700,
          background: creekBrand.gradients.heroText,
          backgroundClip: "text",
          color: "transparent",
          letterSpacing: -2,
          marginBottom: 24,
        }}
      >
        {repo}
      </div>

      {/* Description */}
      {truncatedDesc && (
        <div
          style={{
            display: "flex",
            fontSize: 30,
            color: creekBrand.colors.mutedFg,
            maxWidth: 1040,
            textAlign: "center",
            marginBottom: 40,
          }}
        >
          {truncatedDesc}
        </div>
      )}

      {/* Footer CTA */}
      <div
        style={{
          display: "flex",
          fontSize: 24,
          fontFamily: creekBrand.fonts.mono,
          color: creekBrand.colors.accent,
          padding: "14px 28px",
          border: `1px solid ${creekBrand.colors.border}`,
          borderRadius: 10,
          background: creekBrand.colors.surface,
        }}
      >
        $ npx creek deploy gh:{owner}/{repo}
      </div>
    </div>
  );
}
