import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Architectural / CAD "drawing reference" corner markers.
 *
 * Four tiny `+` characters anchored slightly outside the four corners
 * of the parent (which must be `position: relative`). Used to give a
 * container the blueprint / technical-drawing language common in
 * modern dev-tool marketing sites (Linear, Vercel, Neon, Cal.com).
 *
 * Pure decoration: aria-hidden and pointer-events-none, so no impact
 * on screen readers or click targets.
 *
 * The `group-hover:` brightening is why callers should place the
 * parent in a `group` — markers "light up" when the card is hovered,
 * reinforcing the "coming into focus" feel without a new border.
 */
export function CornerMarkers({ className }: { className?: string }) {
  const base =
    "pointer-events-none absolute text-[10px] font-mono leading-none select-none text-muted-foreground/30 group-hover:text-accent/60 transition-colors";

  return (
    <>
      <span aria-hidden className={cn(base, "-top-[5px] -left-[5px]", className)}>
        +
      </span>
      <span aria-hidden className={cn(base, "-top-[5px] -right-[5px]", className)}>
        +
      </span>
      <span aria-hidden className={cn(base, "-bottom-[5px] -left-[5px]", className)}>
        +
      </span>
      <span aria-hidden className={cn(base, "-bottom-[5px] -right-[5px]", className)}>
        +
      </span>
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
 * Linework section header rule — a hairline horizontal line anchored
 * at the top of a section, with `+` markers at both ends. Visually
 * separates major sections without heavy dividers. Pair with the
 * SectionHeader's existing "01/02/..." mono label for consistency.
 */
export function SectionRule({ className }: { className?: string }) {
  return (
    <div className={cn("relative mb-6", className)}>
      <div className="border-t border-border" />
      <span
        aria-hidden
        className="pointer-events-none absolute -top-[5px] -left-[5px] text-[10px] font-mono leading-none select-none text-muted-foreground/30"
      >
        +
      </span>
      <span
        aria-hidden
        className="pointer-events-none absolute -top-[5px] -right-[5px] text-[10px] font-mono leading-none select-none text-muted-foreground/30"
      >
        +
      </span>
    </div>
  );
}
