/** @jsxImportSource hono/jsx */

/**
 * Generic Creek brand card — 1200x630 PNG.
 *
 * Used as:
 * - /brand endpoint fallback for social shares of creek.dev pages
 *   that don't have a more specific card
 * - /deploy/{...} fallback when the repo params don't parse
 * - Future: homepage OG, pricing, docs pages that haven't got their
 *   own card yet
 */

import { creekBrand } from "../brand.js";

export function brandCard() {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        background: creekBrand.gradients.background,
        color: creekBrand.colors.fg,
        fontFamily: creekBrand.fonts.sans,
      }}
    >
      <div
        style={{
          fontSize: 28,
          color: creekBrand.colors.mutedFg,
          marginBottom: 24,
          letterSpacing: 3,
          textTransform: "uppercase",
          display: "flex",
        }}
      >
        Creek
      </div>
      <div
        style={{
          fontSize: 112,
          fontWeight: 700,
          background: creekBrand.gradients.heroText,
          backgroundClip: "text",
          color: "transparent",
          letterSpacing: -3,
          display: "flex",
        }}
      >
        Ship full-stack apps.
      </div>
      <div
        style={{
          fontSize: 36,
          color: creekBrand.colors.dimFg,
          marginTop: 24,
          display: "flex",
        }}
      >
        Open source. One command. No signup.
      </div>
      <div
        style={{
          marginTop: 48,
          fontSize: 28,
          fontFamily: creekBrand.fonts.mono,
          color: creekBrand.colors.accent,
          padding: "14px 28px",
          border: `1px solid ${creekBrand.colors.border}`,
          borderRadius: 12,
          background: creekBrand.colors.surface,
          display: "flex",
        }}
      >
        $ npx creek deploy
      </div>
    </div>
  );
}
