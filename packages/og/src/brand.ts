/**
 * Creek brand tokens for OG card generation.
 *
 * Centralised so every template — and future user-authored cards
 * consuming `@solcreek/og` — renders with a consistent visual identity.
 *
 * Satori-friendly: all values are plain CSS strings usable directly
 * inside inline `style` props.
 */

export const creekBrand = {
  colors: {
    /** Primary background — near-black with subtle warm tone */
    bg: "#0a0a0a",
    /** Midtone used in the gradient */
    bgMid: "#0f1419",
    /** Deepest shade used in the gradient */
    bgDeep: "#080a0d",
    /** Primary foreground text */
    fg: "#fafafa",
    /** Muted label/body text */
    mutedFg: "#a1a1aa",
    /** Dimmer secondary text (owner line, captions) */
    dimFg: "#71717a",
    /** Teal accent — primary brand colour */
    accent: "#5eead4",
    /** Blue accent — used in hero-text gradients */
    accent2: "#60a5fa",
    /** Border on surfaces (CTA pills, cards) */
    border: "#1f2937",
    /** Semi-transparent surface for CTA pills */
    surface: "rgba(15, 20, 25, 0.8)",
  },
  gradients: {
    /** Page background — diagonal warm-black */
    background:
      "linear-gradient(135deg, #0a0a0a 0%, #0f1419 50%, #080a0d 100%)",
    /** Hero text — teal → blue, used for repo name and headlines */
    heroText: "linear-gradient(135deg, #5eead4, #60a5fa)",
  },
  fonts: {
    sans: "sans-serif",
    mono: "monospace",
  },
} as const;

export type CreekBrand = typeof creekBrand;
