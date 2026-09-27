import { playZaicodeSound } from "./zaicodeSoundBus.js";
import {
  pickZaicodeFloaterLane,
  zaicodeFloaterSchedule,
  type ZaicodeChangeFloaterPrefs,
  type ZaicodeFloater,
  type ZaicodeFloaterStyle,
} from "./zaicodeChangeFloaters.js";

/**
 * One layer for every RPG change number (SRC-060, SRC-062): the Changes
 * counter and the agent's Edit rows in the chat both launch numbers here.
 *
 * The numbers are plain DOM nodes in one fixed container on <body>, outside
 * React: a counter or a chat row that re-renders, remounts or scrolls away
 * can never restart or cut a number in flight. Three things the first version
 * got wrong are handled here once:
 *
 * - The numbers started ON the counter (their top at its top edge), so they
 *   covered its own digits and each other. They now start just above the
 *   anchor, and a number launched next to one still rising takes the next
 *   lane up instead of printing over it.
 * - A burst with both plays in the operator's order ("- then +" by default)
 *   with a gap, not both on one spot.
 * - The calm interface (`html.zaicode-no-motion`, animation: none !important)
 *   and the system's reduced-motion setting froze or flattened them.
 *   "Keep moving" (ignoreReducedMotion) re-enables exactly these numbers.
 */

const CSS_ID = "zaicode-change-floater-css";
const LAYER_ID = "zaicode-change-floater-layer";
const LANE_PX = 13;

const CSS = `
#${LAYER_ID}{position:fixed;inset:0;pointer-events:none;z-index:2147483000;overflow:visible;}
.zaicode-floater{position:fixed;pointer-events:none;white-space:nowrap;
  font:700 calc(11px*var(--zf-s)) var(--font-mono,ui-monospace,monospace);line-height:1;
  transform:translate(-50%,-100%);animation:var(--zf-name,zf-rise) var(--zf-t) ease-out forwards;}
.zaicode-floater[data-outline="1"]{text-shadow:1px 0 #000,-1px 0 #000,0 1px #000,0 -1px #000,1px 1px #000,-1px -1px #000,1px -1px #000,-1px 1px #000;}
.zaicode-floater[data-crit="1"]{font-size:calc(15px*var(--zf-s));}
@keyframes zf-rise{0%{opacity:0;transform:translate(-50%,-100%) translateY(4px)}12%{opacity:1}70%{opacity:1}100%{opacity:0;transform:translate(-50%,-100%) translateY(calc(-1*var(--zf-d)))}}
@keyframes zf-pop{0%{opacity:0;transform:translate(-50%,-100%) scale(.3)}18%{opacity:1;transform:translate(-50%,-100%) translateY(calc(-.35*var(--zf-d))) scale(1.35)}35%{transform:translate(-50%,-100%) translateY(calc(-.45*var(--zf-d))) scale(1)}80%{opacity:1}100%{opacity:0;transform:translate(-50%,-100%) translateY(calc(-1*var(--zf-d))) scale(1)}}
@keyframes zf-drift{0%{opacity:0;transform:translate(-50%,-100%)}12%{opacity:1}75%{opacity:1}100%{opacity:0;transform:translate(-50%,-100%) translate(var(--zf-dx),calc(-1*var(--zf-d)))}}
@keyframes zf-arcade{0%{opacity:0;transform:translate(-50%,-100%) scale(2)}10%{opacity:1;transform:translate(-50%,-100%) scale(1)}14%{transform:translate(-50%,-100%) translateX(-3px)}18%{transform:translate(-50%,-100%) translateX(3px)}22%{transform:translate(-50%,-100%)}80%{opacity:1}100%{opacity:0;transform:translate(-50%,-100%) translateY(calc(-1*var(--zf-d)))}}
@keyframes zf-fade{0%{opacity:0}15%{opacity:1}80%{opacity:1}100%{opacity:0}}
@keyframes zf-flash{0%{filter:brightness(2.2) drop-shadow(0 0 3px currentColor)}100%{filter:none}}
.zaicode-change-flash{animation:zf-flash .6s ease-out;}
html.zaicode-no-motion .zaicode-floater[data-zf-keep="1"]{animation:var(--zf-name,zf-rise) var(--zf-t) ease-out forwards !important;}
html.zaicode-no-motion .zaicode-change-flash[data-zf-keep="1"]{animation:zf-flash .6s ease-out !important;}
@media (prefers-reduced-motion: reduce){.zaicode-floater:not([data-zf-keep="1"]){animation-name:zf-fade!important}}
`;

export function ensureZaicodeFloaterCss(): void {
  if (typeof document === "undefined" || document.getElementById(CSS_ID)) return;
  const style = document.createElement("style");
  style.id = CSS_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

function layer(): HTMLElement | null {
  if (typeof document === "undefined" || !document.body) return null;
  ensureZaicodeFloaterCss();
  let host = document.getElementById(LAYER_ID);
  if (!host) {
    host = document.createElement("div");
    host.id = LAYER_ID;
    host.setAttribute("aria-hidden", "true");
    document.body.appendChild(host);
  }
  return host;
}

interface LiveNumber {
  element: HTMLElement;
  x: number;
  y: number;
  lane: number;
  born: number;
  durationMs: number;
}

const live = new Set<LiveNumber>();

/** How one launch looks: the counter's settings, or the chat's own ones. */
export interface ZaicodeFloaterLook {
  style: ZaicodeFloaterStyle;
  distancePx: number;
  durationMs: number;
  scalePct: number;
  outline: boolean;
  keepMoving: boolean;
  maxFloaters: number;
  healColor: string;
  damageColor: string;
}

export function zaicodeCounterLook(prefs: ZaicodeChangeFloaterPrefs): ZaicodeFloaterLook {
  return {
    style: prefs.style,
    distancePx: prefs.distancePx,
    durationMs: prefs.durationMs,
    scalePct: prefs.scalePct,
    outline: prefs.outline,
    keepMoving: prefs.ignoreReducedMotion,
    maxFloaters: prefs.maxFloaters,
    healColor: prefs.healColor,
    damageColor: prefs.damageColor,
  };
}

export function zaicodeChatLook(prefs: ZaicodeChangeFloaterPrefs): ZaicodeFloaterLook {
  return {
    ...zaicodeCounterLook(prefs),
    style: prefs.chatStyle === "same" ? prefs.style : prefs.chatStyle,
    distancePx: prefs.chatDistancePx,
    durationMs: prefs.chatDurationMs,
    scalePct: prefs.chatScalePct,
  };
}

function launchOne(anchor: DOMRect, floater: ZaicodeFloater, share: number, look: ZaicodeFloaterLook): void {
  const host = layer();
  if (!host) return;
  const now = performance.now();
  const x = Math.round(anchor.left + anchor.width * share);
  const y = Math.round(anchor.top - 1);
  // Numbers near this spot that are still in the first part of their rise hold their lane.
  const occupied: number[] = [];
  for (const entry of live) {
    if (Math.abs(entry.x - x) < 56 && Math.abs(entry.y - y) < 24 && now - entry.born < entry.durationMs * 0.6) {
      occupied.push(entry.lane);
    }
  }
  const lane = pickZaicodeFloaterLane(occupied);
  const scale = look.scalePct / 100;
  const element = document.createElement("span");
  element.className = "zaicode-floater";
  element.textContent = floater.text;
  element.dataset.kind = floater.kind;
  element.dataset.crit = floater.crit ? "1" : "0";
  element.dataset.outline = look.outline ? "1" : "0";
  element.dataset.style = look.style;
  if (look.keepMoving) element.dataset.zfKeep = "1";
  const dx = (floater.kind === "heal" ? -1 : 1) * (6 + Math.round(Math.random() * 10));
  element.style.left = `${x + (lane % 2 === 0 ? 1 : -1) * Math.ceil(lane / 2) * 8}px`;
  element.style.top = `${y - lane * Math.round(LANE_PX * scale)}px`;
  element.style.color =
    floater.kind === "heal" ? look.healColor || "var(--color-diff-added)" : look.damageColor || "var(--color-diff-removed)";
  element.style.setProperty("--zf-name", `zf-${look.style}`);
  element.style.setProperty("--zf-d", `${look.distancePx}px`);
  element.style.setProperty("--zf-t", `${look.durationMs}ms`);
  element.style.setProperty("--zf-s", String(scale));
  element.style.setProperty("--zf-dx", `${dx}px`);
  host.appendChild(element);
  const entry: LiveNumber = { element, x, y, lane, born: now, durationMs: look.durationMs };
  live.add(entry);
  // The oldest numbers leave first when there are more than the operator allows.
  if (live.size > look.maxFloaters) {
    const oldest = [...live].sort((a, b) => a.born - b.born).slice(0, live.size - look.maxFloaters);
    for (const gone of oldest) {
      gone.element.remove();
      live.delete(gone);
    }
  }
  setTimeout(() => {
    element.remove();
    live.delete(entry);
  }, look.durationMs + 60);
}

/**
 * Launches one burst over `anchor` (re-measured when each number starts, so a
 * number that waits for its turn follows its row). Returns the total time the
 * burst takes to start all its numbers.
 */
export function launchZaicodeFloaters(
  anchor: () => DOMRect | null,
  floaters: readonly ZaicodeFloater[],
  prefs: Pick<ZaicodeChangeFloaterPrefs, "order" | "sequenceGapMs">,
  look: ZaicodeFloaterLook,
  options: { sound: boolean; soundEcho?: boolean; onStart?: () => void } = { sound: true },
): number {
  const plan = zaicodeFloaterSchedule(floaters, prefs);
  const together = prefs.order === "together" && floaters.length > 1;
  for (const [index, step] of plan.entries()) {
    const start = () => {
      const rect = anchor();
      if (!rect || (rect.width === 0 && rect.height === 0)) return;
      // Side by side only when both go at once; one after another they both start from the middle.
      const share = together ? (step.floater.kind === "heal" ? 0.3 : 0.75) : 0.5;
      launchOne(rect, step.floater, share, look);
      if (index === 0 || !together) options.onStart?.();
      // An agent's change is a consequence, not the operator's click: it plays as an echo, so it never
      // silences the operator's own next sound, and a click of the operator's wins over it (SRC-062).
      if (options.sound) {
        playZaicodeSound(step.floater.kind === "heal" ? "changes.heal" : "changes.damage", {
          echo: options.soundEcho ?? true,
        });
      }
    };
    if (step.delayMs === 0) start();
    else setTimeout(start, step.delayMs);
  }
  return plan.length > 0 ? plan[plan.length - 1]!.delayMs : 0;
}

/** Re-runs the flash on an element without remounting anything. */
export function flashZaicodeChange(element: HTMLElement | null, keepMoving: boolean): void {
  if (!element) return;
  ensureZaicodeFloaterCss();
  if (keepMoving) element.dataset.zfKeep = "1";
  else delete element.dataset.zfKeep;
  element.classList.remove("zaicode-change-flash");
  void element.offsetWidth;
  element.classList.add("zaicode-change-flash");
}
