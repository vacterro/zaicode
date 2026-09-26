import type { CSSProperties } from "react";
import type { ZaicodeHighlightEffect, ZaicodeHighlightRule, ZaicodeHighlightTarget } from "./zaicodeHighlights.js";
import { zaicodeEasingCss, zaicodePhaseDelay, ZAICODE_DEFAULT_CURVE } from "./zaicodeMotionTuning.js";

/**
 * Attributes and custom properties that light an element up (SRC-038), with
 * the separate settings of every combined effect and shape (SRC-048). Kept
 * apart from zaicodeHighlights.ts for the 400-line limit; the rules that read
 * these properties live in zaicodeMotionCss.ts.
 */

/** Colour a `state` highlight takes per target (the same one the rest of ZAICODE uses). */
export const ZAICODE_HIGHLIGHT_STATE_COLORS: Record<ZaicodeHighlightTarget, string> = {
  sessionWorking: "#f0c040",
  sessionWaiting: "#e0a040",
  sessionOpen: "#f0c040",
  projectWorking: "#f0c040",
  projectWaiting: "#e0a040",
  headerWorking: "#f0c040",
  meterPrepared: "#50c878",
};

/** Keyframes (zaicodeMotionCss.ts) per effect; `steady` has none. */
const EFFECT_KEYFRAMES: Record<ZaicodeHighlightEffect, string | null> = {
  steady: null,
  pulse: "zh-pulse",
  breathe: "zh-breathe",
  heartbeat: "zh-heartbeat",
  blink: "zh-blink",
  strobe: "zh-strobe",
  flicker: "zh-flicker",
};

/** How far each effect dims at its lowest point, in % (the keyframes' own shape). */
export const ZAICODE_EFFECT_DEPTH: Record<ZaicodeHighlightEffect, number> = {
  steady: 0,
  pulse: 75,
  breathe: 88,
  heartbeat: 80,
  blink: 100,
  strobe: 100,
  flicker: 85,
};

/** Blink and strobe switch; everything else glides. */
function defaultTiming(effect: ZaicodeHighlightEffect): string {
  return effect === "blink" || effect === "strobe" ? "linear" : "ease-in-out";
}

export interface ZaicodeLightAttrs {
  [attribute: `data-${string}`]: string | undefined;
  style: CSSProperties;
}

/** The animation of one combined effect, with its own speed, easing and phase when it has them. */
export function zaicodeEffectAnimation(effect: ZaicodeHighlightEffect, rule: ZaicodeHighlightRule): string | null {
  const keyframes = EFFECT_KEYFRAMES[effect];
  if (!keyframes) return null;
  const own = rule.tuning[effect];
  const seconds = own?.seconds ?? rule.seconds;
  const timing = own?.easing ? zaicodeEasingCss(own.easing, own.curve ?? ZAICODE_DEFAULT_CURVE, 6) : defaultTiming(effect);
  const phase = own?.phase ?? 0;
  return phase > 0
    ? `${keyframes} ${seconds}s ${timing} ${zaicodePhaseDelay(phase, seconds)} infinite`
    : `${keyframes} ${seconds}s ${timing} infinite`;
}

/**
 * The attributes and custom properties that light an element up for `target`,
 * or null when that highlight is off. `stateColor` overrides the target's
 * default state colour (e.g. the runtime verdict colour).
 */
export function zaicodeHighlightAttrs(
  target: ZaicodeHighlightTarget,
  prefs: ZaicodeHighlightRule,
  stateColor?: string | null,
): ZaicodeLightAttrs | null {
  if (!prefs.enabled) return null;
  const rainbow = prefs.color === "rainbow";
  const color =
    prefs.color === "custom"
      ? prefs.custom
      : prefs.color === "state"
        ? (stateColor ?? ZAICODE_HIGHLIGHT_STATE_COLORS[target])
        : prefs.color === "accent"
          ? "var(--zaicode-highlight, #f0c040)"
          : "hsl(var(--zh-hue) 90% 60%)";
  // Each effect animates its own strength channel; the CSS multiplies them into --zh-k,
  // so combined effects stack (a pulse that also flickers) instead of fighting over one value.
  const animations = [
    ...prefs.effects.flatMap((effect) => {
      const animation = zaicodeEffectAnimation(effect, prefs);
      return animation ? [animation] : [];
    }),
    ...(rainbow ? [`zh-hue ${Math.max(2, prefs.seconds * 3)}s linear infinite`] : []),
  ];
  const own: Record<string, string> = {};
  for (const effect of prefs.effects) {
    const depth = prefs.tuning[effect]?.depth;
    if (depth !== null && depth !== undefined) own[`--zh-d-${effect}`] = String(depth / 100);
  }
  for (const shape of prefs.shapes) {
    const tuning = prefs.shapeTuning[shape];
    if (tuning?.color) own[`--zh-c-${shape}`] = tuning.color;
    if (tuning?.strength !== null && tuning?.strength !== undefined) own[`--zh-s-${shape}`] = String(tuning.strength / 100);
  }
  const style = {
    "--zh-color": color,
    "--zh-s": String(prefs.strength / 100),
    ...own,
    ...(animations.length > 0 ? { "--zh-anim": animations.join(", "), animation: "var(--zh-anim)" } : {}),
  } as CSSProperties;
  return {
    "data-zh": target,
    // Space-separated: the CSS matches each shape with ~=, so shapes draw together.
    "data-zh-shape": prefs.shapes.join(" "),
    "data-zh-keep": prefs.keepMoving && animations.length > 0 ? "" : undefined,
    style,
  };
}
