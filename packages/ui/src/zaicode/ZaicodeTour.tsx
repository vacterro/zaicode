import { useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { openZaicodeHelp } from "./zaicodeActions.js";
import { zaicodeDevicePx } from "./zaicodePixelSnap.js";

/**
 * "Play": a guided walk over the real screen. Each step outlines the actual
 * control and says in two sentences what it is for and what to click. No
 * animation; Next / Back / Esc; nothing changes unless the operator clicks it.
 */

export interface ZaicodeTourStep {
  /** CSS selector of the element to outline; the card explains it even when it is not on screen. */
  target: string;
  title: string;
  body: string;
  /** What to do when the target is hidden right now. */
  hiddenHint?: string;
}

export const ZAICODE_TOUR_STEPS: readonly ZaicodeTourStep[] = [
  {
    target: "[data-zaicode-tour='agents']",
    title: "1 · Agents: who does the work",
    body: "An agent is a saved role (builder, reviewer, tester…) with its model pool. “Teams” adds a ready-made set in one click; click an agent to edit it on the right.",
  },
  {
    target: "[data-zaicode-tour='queue']",
    title: "2 · Tasks: what to do",
    body: "Write a task, pick an agent, add it. With Autopilot on it starts at once, as many at a time as the Parallel number allows. Each row has one main button: Run, Stop, Retry or Resume.",
  },
  {
    target: "[data-zaicode-tour='inspector']",
    title: "3 · Inspector: the details",
    body: "The selected agent or task: its configured pool, what the runtime actually used, the result, and “Open session” to read the whole conversation.",
  },
  {
    target: "[data-zaicode-engine-bar]",
    title: "4 · Engines: your subscriptions",
    body: "Top row: the in-app model pools (SAIFREN free, SAIOPP deep). Second row: your Claude / Codex / Antigravity / ZCode logins, each filled by the quota it has left. Double-click a tile to start that CLI as a worker in this project.",
    hiddenHint: "Show the sidebar (the logo button, top left) to see the tiles.",
  },
  {
    target: "[data-zaicode-workers-panel], [data-zaicode-sidebar-workers]",
    title: "5 · WORKERS: the CLIs at work",
    body: "Started subscriptions run as terminals in the WORKERS panel under the chat — split side by side or as tabs. Any worker can pop out into its own snappable window, or minimize to a chip named after its project.",
    hiddenHint: "No worker yet: double-click an engine tile, then come back here.",
  },
  {
    target: "[data-zaicode-limit-meter]",
    title: "6 · Limits at a glance",
    body: "The title bar meter shows every subscription's quota. Hover for the full breakdown, right-click to choose which engines show. When a window resets, the card names it and the tile glows for a while.",
  },
  {
    target: "[data-zaicode-clock]",
    title: "7 · Clock and timers",
    body: "Alarms, repeating reminders, a quick Temp Timer and work / break phases. Click the clock to open them; the nearest one counts down here.",
    hiddenHint: "The clock is off: Settings → Timers → Title-bar clock.",
  },
  {
    target: "[data-zaicode-tour='help']",
    title: "That's it",
    body: "Help (F1) explains every control in one line each. Almost everything can be right-clicked for its own settings.",
  },
];

function findTarget(selector: string): HTMLElement | null {
  for (const part of selector.split(",")) {
    const element = document.querySelector<HTMLElement>(part.trim());
    if (element && element.getClientRects().length > 0) return element;
  }
  return null;
}

export function ZaicodeTour({ onClose }: { onClose: () => void }) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const step = ZAICODE_TOUR_STEPS[index]!;
  const last = index === ZAICODE_TOUR_STEPS.length - 1;

  useLayoutEffect(() => {
    const measure = () => setRect(findTarget(step.target)?.getBoundingClientRect() ?? null);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [step.target]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      else if (event.key === "ArrowRight" || event.key === "Enter") setIndex((value) => Math.min(ZAICODE_TOUR_STEPS.length - 1, value + 1));
      else if (event.key === "ArrowLeft") setIndex((value) => Math.max(0, value - 1));
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // The card sits below the target when there is room, otherwise above it; centred when the target is hidden.
  const cardWidth = 340;
  const cardStyle: React.CSSProperties = rect
    ? {
        left: zaicodeDevicePx(Math.max(8, Math.min(window.innerWidth - cardWidth - 8, rect.left))),
        top: zaicodeDevicePx(rect.bottom + 180 < window.innerHeight ? rect.bottom + 8 : Math.max(8, rect.top - 172)),
        width: cardWidth,
      }
    : { left: "50%", top: "40%", width: cardWidth, transform: "translateX(-50%)" };

  return createPortal(
    <div className="fixed inset-0 z-[80]" data-zaicode-tour-overlay>
      <div className="absolute inset-0 bg-black/35" onMouseDown={onClose} />
      {rect ? (
        <div
          className="pointer-events-none absolute border-2 border-[var(--zaicode-highlight,#f0c040)]"
          style={{ left: rect.left - 3, top: rect.top - 3, width: rect.width + 6, height: rect.height + 6 }}
        />
      ) : null}
      <div
        role="dialog"
        aria-label={step.title}
        className="absolute flex flex-col gap-2 border border-[var(--zaicode-highlight,var(--color-border-hover))] bg-card p-3 text-ui-xs text-foreground"
        style={cardStyle}
      >
        <div className="flex items-start justify-between gap-2">
          <strong className="text-ui-sm font-normal">{step.title}</strong>
          <button type="button" aria-label="Close the tour" className="flex size-5 items-center justify-center hover:bg-hover" onClick={onClose}>
            <X className="size-3.5" />
          </button>
        </div>
        <p className="text-foreground-subtle">{step.body}</p>
        {!rect && step.hiddenHint ? <p className="text-[var(--zaicode-highlight,#f0c040)]">{step.hiddenHint}</p> : null}
        <div className="flex items-center gap-2">
          <span className="text-foreground-subtlest">
            {index + 1} / {ZAICODE_TOUR_STEPS.length} · ← → Esc
          </span>
          <span className="flex-1" />
          <button
            type="button"
            className="flex items-center border border-border px-1.5 hover:bg-hover disabled:opacity-40"
            disabled={index === 0}
            onClick={() => setIndex(index - 1)}
          >
            <ChevronLeft className="size-3.5" />
            Back
          </button>
          {last ? (
            <button
              type="button"
              className="border border-[var(--zaicode-highlight,var(--color-border-hover))] px-2 hover:bg-hover"
              onClick={() => {
                onClose();
                void openZaicodeHelp();
              }}
            >
              Open Help
            </button>
          ) : (
            <button
              type="button"
              className="flex items-center border border-[var(--zaicode-highlight,var(--color-border-hover))] px-1.5 hover:bg-hover"
              onClick={() => setIndex(index + 1)}
            >
              Next
              <ChevronRight className="size-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
