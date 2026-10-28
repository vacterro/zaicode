import type { ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import type { ZaicodeRailControlLayout } from "./zaicodeRailLayout.js";

/**
 * T-224 / SRC-154:R001 — the one way a sidebar-rail control looks.
 *
 * Every control in the vertical rail renders through this view, so sizes,
 * states and the icon-only presentation agree by construction instead of by
 * per-button offsets:
 *
 *  - the box (height, icon slot, gap, corners) comes from the layout contract;
 *  - icon-only mode shows an abbreviated tag at most — the full name stays in
 *    `aria-label` and `title`, so the accessible label and the tooltip survive;
 *  - the `trailing` badge (the MAIN marker) renders inline beside the tag, never
 *    pinned at a corner over the glyph. The `leading` live strip is bounded by
 *    the box itself (inset edges, clipped by overflow-hidden), so neither marker
 *    can overlap the icon or escape the control at rail width;
 *  - active, hover, focus-visible and disabled read from the same tokens on
 *    every control.
 */
export function ZaicodeRailControl({
  layout,
  label,
  hint,
  tag,
  icon,
  leading,
  trailing,
  active,
  disabled,
  testId,
  onActivate,
  className,
}: {
  layout: ZaicodeRailControlLayout;
  /** The full accessible name; also the tooltip. Never truncated. */
  label: string;
  hint?: string;
  /** Abbreviated tag for icon-only mode (a few characters, never the interaction). */
  tag?: string;
  icon: ReactNode;
  /** Inline-start marker inside the box, e.g. the live strip. */
  leading?: ReactNode;
  /** Inline-end badge inside the box, e.g. the MAIN marker. */
  trailing?: ReactNode;
  active?: boolean;
  disabled?: boolean;
  testId?: string;
  onActivate: () => void;
  className?: string;
}) {
  const iconOnly = layout.labelPlacement === "hidden";
  return (
    <button
      type="button"
      data-zaicode-rail-control=""
      data-zaicode-rail-axis={layout.axis}
      data-zaicode-rail-active={active ? "true" : undefined}
      data-zaicode-rail-disabled={disabled ? "true" : undefined}
      data-testid={testId}
      title={hint ?? label}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      disabled={disabled}
      onClick={onActivate}
      style={{ height: layout.hitSizePx, gap: layout.gapPx, borderRadius: layout.radiusPx }}
      className={cn(
        "relative flex w-full shrink-0 items-center overflow-hidden border border-border text-foreground-subtle",
        iconOnly ? "flex-col justify-center px-1" : "flex-row justify-start px-2",
        active && "bg-selected text-foreground",
        !disabled && "hover:bg-hover hover:text-foreground",
        disabled && "cursor-not-allowed opacity-50",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused",
        className,
      )}
    >
      {leading}
      <span
        className="flex shrink-0 items-center justify-center"
        style={{ width: layout.iconSizePx, height: layout.iconSizePx }}
        aria-hidden="true"
      >
        {icon}
      </span>
      {iconOnly ? (
        tag ? (
          <span className="flex max-w-full items-center gap-0.5 text-[10px] leading-tight">
            <span className="min-w-0 truncate">{tag}</span>
            {trailing}
          </span>
        ) : (
          trailing
        )
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate text-left">{label}</span>
          {trailing}
        </>
      )}
    </button>
  );
}
