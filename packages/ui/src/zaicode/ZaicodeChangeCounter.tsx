import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { isZaicodeProductMode } from "@zcode/shared";
import { playZaicodeSound } from "./zaicodeSoundBus.js";
import {
  useZaicodeChangeFloaters,
  zaicodeChangeDelta,
  zaicodeFloatersFor,
  type ZaicodeChangeCounts,
  type ZaicodeFloater,
} from "./zaicodeChangeFloaters.js";

/**
 * Wraps a "+added -removed" counter (the Changes chip and row) and makes the
 * numbers fly (SRC-060): green "+N" rises like healing, red "-N" like damage.
 * The numbers are portalled to <body> at the counter's place, so a clipped
 * chip never cuts them off. `scopeKey` is what the counts belong to (the
 * workspace): a new scope starts silent.
 */

const CSS_ID = "zaicode-change-floater-css";
const CSS = `
.zaicode-floater{position:fixed;z-index:2147483000;pointer-events:none;white-space:nowrap;
  font:700 calc(11px*var(--zf-s)) var(--font-mono,ui-monospace,monospace);line-height:1;
  transform:translate(-50%,0);animation:zf-rise var(--zf-t) ease-out forwards;}
.zaicode-floater[data-outline="1"]{text-shadow:1px 0 #000,-1px 0 #000,0 1px #000,0 -1px #000,1px 1px #000,-1px -1px #000,1px -1px #000,-1px 1px #000;}
.zaicode-floater[data-crit="1"]{font-size:calc(15px*var(--zf-s));}
.zaicode-floater[data-style="pop"]{animation-name:zf-pop;}
.zaicode-floater[data-style="drift"]{animation-name:zf-drift;}
.zaicode-floater[data-style="arcade"]{animation-name:zf-arcade;}
@keyframes zf-rise{0%{opacity:0;transform:translate(-50%,4px)}12%{opacity:1}70%{opacity:1}100%{opacity:0;transform:translate(-50%,calc(-1*var(--zf-d)))}}
@keyframes zf-pop{0%{opacity:0;transform:translate(-50%,0) scale(.3)}18%{opacity:1;transform:translate(-50%,calc(-.35*var(--zf-d))) scale(1.35)}35%{transform:translate(-50%,calc(-.45*var(--zf-d))) scale(1)}80%{opacity:1}100%{opacity:0;transform:translate(-50%,calc(-1*var(--zf-d))) scale(1)}}
@keyframes zf-drift{0%{opacity:0;transform:translate(-50%,0)}12%{opacity:1}75%{opacity:1}100%{opacity:0;transform:translate(calc(-50% + var(--zf-dx)),calc(-1*var(--zf-d)))}}
@keyframes zf-arcade{0%{opacity:0;transform:translate(-50%,0) scale(2)}10%{opacity:1;transform:translate(-50%,0) scale(1)}14%{transform:translate(calc(-50% - 3px),0)}18%{transform:translate(calc(-50% + 3px),0)}22%{transform:translate(-50%,0)}80%{opacity:1}100%{opacity:0;transform:translate(-50%,calc(-1*var(--zf-d)))}}
@keyframes zf-fade{0%{opacity:0}15%{opacity:1}80%{opacity:1}100%{opacity:0}}
@keyframes zf-flash{0%{filter:brightness(2.2) drop-shadow(0 0 3px currentColor)}100%{filter:none}}
.zaicode-change-flash{animation:zf-flash .6s ease-out;}
@media (prefers-reduced-motion: reduce){.zaicode-floater{animation-name:zf-fade!important}}
`;

function ensureFloaterCss(): void {
  if (typeof document === "undefined" || document.getElementById(CSS_ID)) return;
  const style = document.createElement("style");
  style.id = CSS_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

interface LiveFloater extends ZaicodeFloater {
  id: number;
  x: number;
  y: number;
  dx: number;
}

let nextFloaterId = 1;

export function ZaicodeChangeCounter({
  added,
  removed,
  scopeKey,
  children,
  className,
}: ZaicodeChangeCounts & { scopeKey: string; children: ReactNode; className?: string }) {
  const prefs = useZaicodeChangeFloaters();
  const anchor = useRef<HTMLSpanElement | null>(null);
  const previous = useRef<{ key: string; counts: ZaicodeChangeCounts } | null>(null);
  const pending = useRef({ heal: 0, damage: 0 });
  const mergeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const [floaters, setFloaters] = useState<LiveFloater[]>([]);
  // SRC-060 audit: the counter flash used a `key` on the span that also hosts
  // the portalled floaters, so every burst remounted that subtree and restarted
  // the `zf-rise` animation of the floaters still in flight -- they blinked and
  // jumped back to opacity 0 mid-flight. The key was only there to re-run the
  // flash animation, so the flash is retriggered imperatively instead and the
  // floaters are left alone.
  const [flash, setFlash] = useState(0);
  const flashRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (flash === 0) return;
    const element = flashRef.current;
    if (!element) return;
    // The standard retrigger idiom: cancel, commit the cancellation, then put
    // the animation back. Nothing unmounts, so the floaters keep flying.
    element.classList.remove("zaicode-change-flash");
    void element.offsetWidth;
    element.classList.add("zaicode-change-flash");
  }, [flash]);

  useEffect(() => {
    const live = timers.current;
    return () => {
      if (mergeTimer.current) clearTimeout(mergeTimer.current);
      for (const timer of live) clearTimeout(timer);
      live.clear();
    };
  }, []);

  useEffect(() => {
    const before = previous.current?.key === scopeKey ? previous.current.counts : null;
    previous.current = { key: scopeKey, counts: { added, removed } };
    if (!isZaicodeProductMode()) return;
    const delta = zaicodeChangeDelta(before, { added, removed });
    if (delta.heal === 0 && delta.damage === 0) return;
    pending.current = { heal: pending.current.heal + delta.heal, damage: pending.current.damage + delta.damage };
    if (mergeTimer.current) return;
    const flush = () => {
      mergeTimer.current = null;
      const burst = pending.current;
      pending.current = { heal: 0, damage: 0 };
      const current = prefsRef.current;
      const made = zaicodeFloatersFor(burst, current);
      if (made.length === 0) return;
      ensureFloaterCss();
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) return;
      const spawned = made.map((floater, index) => ({
        ...floater,
        id: nextFloaterId++,
        // Heal rises from the "+" half, damage from the "-" half of the counter.
        x: rect.left + rect.width * (made.length === 1 ? 0.5 : index === 0 ? 0.3 : 0.75),
        y: rect.top,
        dx: (floater.kind === "heal" ? -1 : 1) * (6 + Math.round(Math.random() * 10)),
      }));
      setFloaters((list) => [...list, ...spawned].slice(-current.maxFloaters));
      for (const floater of spawned) {
        const timer = setTimeout(() => {
          timers.current.delete(timer);
          setFloaters((list) => list.filter((entry) => entry.id !== floater.id));
        }, current.durationMs + 50);
        timers.current.add(timer);
      }
      if (current.flashCounter) setFlash((count) => count + 1);
      if (current.sound) {
        if (made.some((floater) => floater.kind === "heal")) playZaicodeSound("changes.heal");
        if (made.some((floater) => floater.kind === "damage")) playZaicodeSound("changes.damage");
      }
    };
    if (prefsRef.current.mergeMs === 0) flush();
    else mergeTimer.current = setTimeout(flush, prefsRef.current.mergeMs);
  }, [added, removed, scopeKey]);

  const color = (floater: LiveFloater) =>
    floater.kind === "heal"
      ? prefs.healColor || "var(--color-diff-added)"
      : prefs.damageColor || "var(--color-diff-removed)";

  return (
    <span
      ref={(node) => {
        anchor.current = node;
        flashRef.current = node;
      }}
      className={className}
      data-zaicode-change-counter
      data-zaicode-help="changes"
    >
      {children}
      {floaters.length > 0 && typeof document !== "undefined"
        ? createPortal(
            floaters.map((floater) => (
              <span
                key={floater.id}
                aria-hidden="true"
                className="zaicode-floater"
                data-style={prefs.style}
                data-kind={floater.kind}
                data-crit={floater.crit ? "1" : "0"}
                data-outline={prefs.outline ? "1" : "0"}
                style={
                  {
                    left: floater.x,
                    top: floater.y - 2,
                    color: color(floater),
                    "--zf-d": `${prefs.distancePx}px`,
                    "--zf-t": `${prefs.durationMs}ms`,
                    "--zf-s": String(prefs.scalePct / 100),
                    "--zf-dx": `${floater.dx}px`,
                  } as CSSProperties
                }
              >
                {floater.text}
              </span>
            )),
            document.body,
          )
        : null}
    </span>
  );
}
