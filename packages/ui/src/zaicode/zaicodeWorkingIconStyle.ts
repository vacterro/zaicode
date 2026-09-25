import type { CSSProperties } from "react";
import type { ZaicodeMotionEasing, ZaicodeWorkingIconPrefs, ZaicodeWorkingMotion } from "./zaicodeHighlights.js";

/**
 * Custom properties and animation of the Working icon (SRC-038, mixes and the
 * opacity fix SRC-043). Keyframes live in zaicodeMotionCss.ts.
 */

const EASING_CSS: Record<ZaicodeMotionEasing, string> = {
  linear: "linear",
  smooth: "ease-in-out",
  steps: "steps(var(--zw-steps), end)",
};

const MOTION_KEYFRAMES: Record<ZaicodeWorkingMotion, string | null> = {
  spin: "zw-spin",
  swing: "zw-swing",
  wobble: "zw-wobble",
  pulse: "zw-pulse",
  breathe: "zw-breathe",
  bounce: "zw-bounce",
  flip: "zw-flip",
  blink: "zw-blink",
  none: null,
};

/**
 * Combined motions (SRC-043): each one animates its own registered channel
 * (zaicodeMotionCss.ts) and one transform / opacity reads them all, so spin +
 * pulse + blink run together instead of the last one winning the property.
 */
const COMBO_KEYFRAMES: Record<ZaicodeWorkingMotion, string | null> = {
  spin: "zwc-spin",
  swing: "zwc-swing",
  wobble: "zwc-wobble",
  pulse: "zwc-pulse",
  breathe: "zwc-breathe",
  bounce: "zwc-bounce",
  flip: "zwc-flip",
  blink: "zwc-blink",
  none: null,
};

export const ZAICODE_WORKING_COMBO_TRANSFORM =
  "translateY(var(--zw-ty)) perspective(40px) rotateY(var(--zw-ry)) rotate(calc(var(--zw-r1) + var(--zw-r2) + var(--zw-r3))) scale(var(--zw-s))";

const round2 = (value: number) => String(Math.round(value * 100) / 100);

/** Custom properties and animation of the Working icon (size stays with the host's class). */
export function zaicodeWorkingIconStyle(prefs: ZaicodeWorkingIconPrefs): CSSProperties {
  const motions = prefs.motions.filter((motion) => motion !== "none");
  const combined = motions.length > 1;
  const direction = prefs.direction === "ccw" ? "reverse" : prefs.direction === "alternate" ? "alternate" : "normal";
  // Swing / wobble / pulse / bounce / breathe / blink read how far to go from the amplitude.
  const amplitude = prefs.amplitude / 100;
  const easingOf = (motion: ZaicodeWorkingMotion) =>
    motion === "spin" || motion === "flip" ? EASING_CSS[prefs.easing] : prefs.easing === "steps" ? EASING_CSS.steps : "ease-in-out";
  const animations = motions.map(
    (motion) => `${(combined ? COMBO_KEYFRAMES : MOTION_KEYFRAMES)[motion]} ${prefs.seconds}s ${easingOf(motion)} infinite ${direction}`,
  );
  // The resting opacity is a filter, not the opacity property: breathe and blink animate
  // `opacity`, which used to overwrite the Opacity slider completely (SRC-043).
  const filters = [
    prefs.opacity < 100 ? `opacity(${prefs.opacity / 100})` : null,
    prefs.glow ? `drop-shadow(0 0 ${Math.round(1 + amplitude * 3)}px var(--zw-color))` : null,
  ].filter(Boolean);
  const color =
    prefs.color === "accent" ? "var(--zaicode-highlight, #f0c040)" : prefs.color === "custom" ? prefs.custom : "currentColor";
  return {
    "--zw-deg": `${Math.round(amplitude * 180)}deg`,
    "--zw-scale": round2(1 + amplitude * 0.6),
    "--zw-px": `${Math.max(1, Math.round(amplitude * 6))}px`,
    "--zw-fade": round2(1 - amplitude * 0.9),
    // Blink's dark phase: Reach 100 % = gone, 5 % = barely dims.
    "--zw-blink-low": round2(1 - amplitude),
    "--zw-steps": String(prefs.steps),
    "--zw-color": color,
    ...(animations.length > 0 ? { "--zw-anim": animations.join(", "), animation: "var(--zw-anim)" } : { animation: "none" }),
    ...(combined ? { transform: ZAICODE_WORKING_COMBO_TRANSFORM, opacity: "calc(var(--zw-o1) * var(--zw-o2))" } : {}),
    color,
    ...(filters.length > 0 ? { filter: filters.join(" ") } : {}),
    ...(prefs.size !== 100 ? { scale: String(prefs.size / 100) } : {}),
  } as unknown as CSSProperties;
}

/** Whether the Reach slider changes anything for this set of motions. */
export function zaicodeWorkingMotionsReach(motions: readonly ZaicodeWorkingMotion[]): boolean {
  return motions.some((motion) => motion !== "spin" && motion !== "flip" && motion !== "none");
}
