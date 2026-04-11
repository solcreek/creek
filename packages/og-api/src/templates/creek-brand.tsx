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

/** @jsxImportSource hono/jsx */

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
        background:
          "linear-gradient(135deg, #0a0a0a 0%, #0f1419 50%, #080a0d 100%)",
        color: "#fafafa",
        fontFamily: "sans-serif",
      }}
    >
      <div
        style={{
          fontSize: 28,
          color: "#a1a1aa",
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
          background: "linear-gradient(135deg, #5eead4, #60a5fa)",
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
          color: "#71717a",
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
          fontFamily: "monospace",
          color: "#5eead4",
          padding: "14px 28px",
          border: "1px solid #1f2937",
          borderRadius: 12,
          background: "rgba(15, 20, 25, 0.8)",
          display: "flex",
        }}
      >
        $ npx creek deploy
      </div>
    </div>
  );
}
