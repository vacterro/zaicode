import { Ellipsis } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { ZAICODE_OVERFLOW_UNKNOWN_WIDTH, zaicodeOverflowFit } from "./zaicodeOverflow.js";

export interface ZaicodeOverflowItem {
  key: string;
  node: ReactNode;
}

const MORE_BUTTON_WIDTH = 28;

/**
 * A row of icon buttons that never clips one (SRC-035): whatever does not
 * fit the width it gets moves, in order, into a "⋯" panel at the end of the
 * row, and comes back as soon as there is room again. Items are rendered once
 * (in the row or in the open panel), so their own state and menus keep working.
 * Place it in a slot that can shrink (`min-w-0`, `flex-1` or a fixed width).
 */
export function ZaicodeOverflowRow({
  items,
  gap = 2,
  className,
  moreTitle = "More",
}: {
  items: readonly ZaicodeOverflowItem[];
  /** Pixels between items. */
  gap?: number;
  className?: string;
  moreTitle?: string;
}) {
  const outerRef = useRef<HTMLDivElement | null>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const widths = useRef(new Map<string, number>());
  const [fit, setFit] = useState(items.length);
  const [width, setWidth] = useState(0);
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    const outer = outerRef.current;
    if (!outer || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setWidth(outer.clientWidth));
    observer.observe(outer);
    setWidth(outer.clientWidth);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (row) {
      for (const child of Array.from(row.children)) {
        const key = (child as HTMLElement).dataset.overflowKey;
        if (key) widths.current.set(key, (child as HTMLElement).offsetWidth);
      }
    }
    if (width <= 0) return;
    const measured = items.map((item) => widths.current.get(item.key) ?? ZAICODE_OVERFLOW_UNKNOWN_WIDTH);
    const next = zaicodeOverflowFit(measured, width, gap, MORE_BUTTON_WIDTH);
    if (next !== fit) setFit(next);
  });

  const shown = items.slice(0, fit);
  const hidden = items.slice(fit);
  return (
    <div ref={outerRef} className={cn("flex min-w-0 items-center overflow-hidden", className)} data-zaicode-overflow-row>
      <div ref={rowRef} className="flex min-w-0 items-center" style={{ gap }}>
        {shown.map((item) => (
          <span key={item.key} data-overflow-key={item.key} className="flex shrink-0 items-center">
            {item.node}
          </span>
        ))}
      </div>
      {hidden.length > 0 ? (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-md"
              className="ml-0.5 shrink-0 [app-region:no-drag]"
              aria-label={`${moreTitle} (${hidden.length})`}
              title={`${moreTitle}: ${hidden.length} button(s) that do not fit`}
              data-zaicode-overflow-more
            >
              <Ellipsis className="size-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" side="bottom" className="w-auto max-w-[260px] flex-row flex-wrap gap-0.5 p-1">
            {hidden.map((item) => (
              <span key={item.key} className="flex shrink-0 items-center">
                {item.node}
              </span>
            ))}
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
}
