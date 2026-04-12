import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * CSS-drawn cross marker. A 12×12 anchor box with a 1px horizontal
 * and a 1px vertical bar, both centered via `inset-0 m-auto`. The
 * `mask-radial-from-15%` feathers the bar ends for a hand-drawn
 * blueprint feel.
 *
 * Decoupled from typography — no font metrics, no glyph-centering
 * quirks, no `calc(+1px)` nudges. Always pixel-perfect, renders
 * before fonts load, independent of `font-mono` being available.
 *
 * Callers position the mark at a corner and translate it so its
 * centre lands exactly on the corner point. The `0.5px` offset keeps
 * the 1px bars on the device pixel grid (crisp on retina).
 */
export function CrossMark({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute size-3 mask-radial-from-40%",
        "before:absolute before:inset-0 before:m-auto before:h-px before:bg-foreground/10",
        "after:absolute after:inset-0 after:m-auto after:w-px after:bg-foreground/10",
        className,
      )}
    />
  );
}

/**
 * Architectural / CAD "drawing reference" corner markers — crosses
 * anchored at the four corners of the parent (which must be
 * `position: relative`). Pure decoration, pointer-events-none.
 *
 * Use `group` on the parent to get the hover brighten effect.
 */
export function CornerMarkers() {
  const hover =
    "before:transition-colors after:transition-colors group-hover:before:bg-accent/70 group-hover:after:bg-accent/70";
  // Cards use `border border-border` — a 1px border on ALL four sides, so
  // every edge sits OUTSIDE the relative box. Y and X both need +0.5 to
  // pull the cross centre onto the border midline.
  return (
    <>
      <CrossMark
        className={cn("top-0 left-0 -translate-[calc(50%+0.5px)]", hover)}
      />
      <CrossMark
        className={cn(
          "top-0 right-0 translate-x-[calc(50%+0.5px)] -translate-y-[calc(50%+0.5px)]",
          hover,
        )}
      />
      <CrossMark
        className={cn(
          "bottom-0 left-0 -translate-x-[calc(50%+0.5px)] translate-y-[calc(50%+0.5px)]",
          hover,
        )}
      />
      <CrossMark
        className={cn("bottom-0 right-0 translate-[calc(50%+0.5px)]", hover)}
      />
    </>
  );
}

/**
 * A card container with CornerMarkers + optional mono catalog index.
 * Use for "feature catalog" style sections where the cards should feel
 * like entries in a technical datasheet.
 */
export function LineworkCard({
  children,
  index,
  className,
}: {
  children: ReactNode;
  /** Optional numeric index rendered as two-digit zero-padded mono label top-right. */
  index?: number;
  className?: string;
}) {
  return (
    <div className={cn("group relative border border-border bg-code-bg", className)}>
      <CornerMarkers />
      {typeof index === "number" && (
        <span className="absolute top-3 right-3 text-[10px] font-mono text-muted-foreground/40 tracking-wider">
          {String(index).padStart(2, "0")}
        </span>
      )}
      {children}
    </div>
  );
}

/**
 * Full-bleed section wrapper. Frames the content column with a
 * rectangle of hairline rules — top spanning the full viewport,
 * verticals hugging the inner container edges — and anchors a
 * CrossMark at every corner intersection.
 *
 * The bottom border is omitted because consecutive sections share a
 * seam: section N+1's border-t closes section N. The final section
 * should pass `terminal` so its bottom corners also get marks.
 */
export function LineworkSection({
  children,
  className,
  innerClassName,
  terminal = false,
}: {
  children: ReactNode;
  className?: string;
  innerClassName?: string;
  /** Render bottom corner marks. Use on the last section. */
  terminal?: boolean;
}) {
  return (
    <section className={cn("border-t border-border", className)}>
      <div
        className={cn(
          "relative mx-auto w-full max-w-5xl px-6 py-20",
          innerClassName,
        )}
      >
        {/* Vertical frame lines at container edges */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 w-px bg-border"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 w-px bg-border"
        />
        {/* Top corner marks — centred on the line intersections.
            X uses `50% - 0.5` (rails are INSIDE the relative box at
            left:0 / right:0, midline at x = ±0.5). Y uses `50% + 0.5`
            (border-t lives OUTSIDE, above the relative box, midline
            at y = -0.5). Mirrored for the bottom corners. */}
        <CrossMark className="left-0 top-0 -translate-x-[calc(50%-0.5px)] -translate-y-[calc(50%+0.5px)]" />
        <CrossMark className="right-0 top-0 translate-x-[calc(50%-0.5px)] -translate-y-[calc(50%+0.5px)]" />
        {terminal && (
          <>
            <CrossMark className="left-0 bottom-0 -translate-x-[calc(50%-0.5px)] translate-y-[calc(50%+0.5px)]" />
            <CrossMark className="right-0 bottom-0 translate-x-[calc(50%-0.5px)] translate-y-[calc(50%+0.5px)]" />
          </>
        )}
        {children}
      </div>
    </section>
  );
}
