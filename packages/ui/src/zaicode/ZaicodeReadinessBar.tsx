/**
 * The readiness bar after a subscription account in the model menu (SRC-062).
 *
 * The first version drew a 6 px strip on `bg-surface`, which is exactly the
 * menu's own background, so the empty part vanished and only a hovered row
 * (a lighter surface) showed it; the fill used fixed dark colours that sank
 * into most palettes. This one has a frame in the palette's muted text colour,
 * a track in the palette's background (darker than any menu surface) and a
 * fill from the palette's own success / warning / danger tokens, so it reads
 * on every Wintage palette and on a hovered row alike. "Unknown" is a hatched
 * empty box, never an invisible one.
 */

export type ZaicodeReadinessTone = "good" | "warn" | "bad" | "blocked" | "unknown" | "offline";

export interface ZaicodeReadinessView {
  percent: number | null;
  tone: ZaicodeReadinessTone;
  color: string;
  text: string;
  title: string;
}

/** Fill colour per tone, from the palette tokens (the hex after the comma only when no palette is loaded). */
export const ZAICODE_READINESS_TONE_COLORS: Record<ZaicodeReadinessTone, string> = {
  good: "var(--color-success, #5b9630)",
  warn: "var(--color-warning, #c9a227)",
  bad: "var(--color-destructive, #d37676)",
  blocked: "var(--color-destructive, #d37676)",
  unknown: "var(--color-foreground-subtlest, #95804c)",
  offline: "var(--color-foreground-subtlest, #95804c)",
};

const HATCH =
  "repeating-linear-gradient(135deg, var(--color-foreground-subtlest, #95804c) 0 1px, transparent 1px 3px)";

export function ZaicodeReadinessBar({ view, width = 36 }: { view: ZaicodeReadinessView; width?: number }) {
  const known = view.percent !== null;
  const percent = known ? Math.max(0, Math.min(100, view.percent!)) : 0;
  const dim = view.tone === "offline" || view.tone === "unknown";
  return (
    <span
      className="ml-auto inline-flex shrink-0 items-center gap-1.5 text-ui-xs tabular-nums"
      title={view.title}
      data-zaicode-account-readiness={view.tone}
    >
      <span
        className="relative inline-block h-2 shrink-0 overflow-hidden"
        style={{
          width,
          background: "var(--color-background, #101010)",
          border: `1px ${dim ? "dashed" : "solid"} var(--color-foreground-subtlest, #95804c)`,
          backgroundImage: known ? undefined : HATCH,
        }}
      >
        {known ? (
          <span
            className="absolute inset-y-0 left-0"
            style={{
              width: `${percent}%`,
              // A 1-3 % sliver still shows one pixel column so "almost empty" differs from "empty".
              minWidth: percent > 0 ? 1 : 0,
              background: view.color,
              backgroundImage:
                view.tone === "blocked"
                  ? "repeating-linear-gradient(135deg, transparent 0 2px, rgba(0,0,0,0.45) 2px 4px)"
                  : undefined,
            }}
          />
        ) : null}
      </span>
      <span
        className="min-w-[3ch] text-right"
        style={{ color: dim ? "var(--color-foreground-subtlest)" : view.color }}
      >
        {view.text}
      </span>
    </span>
  );
}
