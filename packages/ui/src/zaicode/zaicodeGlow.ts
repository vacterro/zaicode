import type { CSSProperties } from "react";
import {
  dismissZaicodeFresh,
  listZaicodeFresh,
  readZaicodeNotifySettings,
  type ZaicodeFreshMark,
  type ZaicodeGlowRules,
} from "./zaicodeNotifications.js";

/**
 * The life of a glow ("this just reset", SRC-035): how strong it is while it
 * ages, and which of the operator's rules end it -- seen (pointer rests on
 * it), acknowledged (click), in use (the quota started to go down) or time.
 */

const GLOW_TINT_ALPHA = 0.22;
const GLOW_MIN_STRENGTH = 0.3;
/** Pointer rest that counts as "seen" (a pass-by does not). */
export const ZAICODE_GLOW_SEEN_MS = 800;
/** A drop of more than this many points below the peak means the quota is in use. */
export const ZAICODE_GLOW_USE_DROP = 1;

/** 1 at the start, falling linearly to a floor at the end when fading; 1 throughout otherwise. */
export function zaicodeGlowStrength(mark: ZaicodeFreshMark, now: number, fade: boolean): number {
  if (!fade) return 1;
  const life = mark.until - mark.since;
  if (life <= 0) return 1;
  const left = Math.max(0, Math.min(1, (mark.until - now) / life));
  return GLOW_MIN_STRENGTH + (1 - GLOW_MIN_STRENGTH) * left;
}

/** Inline style of a glowing element: warm outline and tint at the glow's strength, no motion. */
export function zaicodeGlowStyle(mark: ZaicodeFreshMark, now: number, rules: Pick<ZaicodeGlowRules, "fade">): CSSProperties {
  const strength = zaicodeGlowStrength(mark, now, rules.fade);
  return {
    outline: `1px solid rgba(240, 192, 64, ${strength.toFixed(2)})`,
    outlineOffset: "1px",
    background: `rgba(240, 160, 48, ${(GLOW_TINT_ALPHA * strength).toFixed(3)})`,
  };
}

/** Keys whose quota dropped below the level they glowed at (the "in use" rule). */
export function zaicodeGlowsInUse(
  marks: readonly (readonly [string, ZaicodeFreshMark])[],
  remainingByKey: ReadonlyMap<string, number>,
): string[] {
  return marks.flatMap(([key, mark]) => {
    const now = remainingByKey.get(key);
    return typeof mark.peak === "number" && typeof now === "number" && now < mark.peak - ZAICODE_GLOW_USE_DROP ? [key] : [];
  });
}

/** Applies the "in use" rule to every live glow with a known quota. */
export function endZaicodeGlowsInUse(remainingByKey: ReadonlyMap<string, number>): void {
  if (!readZaicodeNotifySettings().glow.use) return;
  const ended = zaicodeGlowsInUse(listZaicodeFresh(), remainingByKey);
  if (ended.length > 0) dismissZaicodeFresh(ended);
}

const seenTimers = new Map<string, number>();

/**
 * Pointer handlers for a glowing element (usable inside lists): resting on it
 * ends the glow when "seen" is on, a click when "acknowledged" is on. Inert
 * without a glow; the element's own click still does its job.
 */
export function zaicodeGlowHandlers(keys: readonly string[], active: boolean) {
  const id = keys.join(" ");
  const clear = () => {
    const timer = seenTimers.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    seenTimers.delete(id);
  };
  return {
    onMouseEnter: () => {
      if (!active || !readZaicodeNotifySettings().glow.hover) return;
      clear();
      seenTimers.set(
        id,
        window.setTimeout(() => {
          seenTimers.delete(id);
          dismissZaicodeFresh(keys);
        }, ZAICODE_GLOW_SEEN_MS),
      );
    },
    onMouseLeave: clear,
    onClickCapture: () => {
      if (active && readZaicodeNotifySettings().glow.click) dismissZaicodeFresh(keys);
    },
  };
}
