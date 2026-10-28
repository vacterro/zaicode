import type { CSSProperties } from "react";
import type { ZaicodeWorkingIconPrefs, ZaicodeWorkingMotion } from "./zaicodeHighlights.js";
import {
  zaicodeEasingCss,
  zaicodePhaseDelay,
  type ZaicodeLayerTuning,
  type ZaicodeMotionDirection,
  type ZaicodeMotionEasing,
} from "./zaicodeMotionTuning.js";

/**
 * Custom properties and animation of the Working icon (SRC-038, mixes and the
 * opacity fix SRC-043, separate settings per motion and symmetric motion
 * SRC-048). Keyframes live in zaicodeMotionCss.ts.
 */

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

/**
 * No perspective (SRC-048): a flip under `perspective(40px)` drew one half of
 * a 16 px icon twice as big as the other, a slanted sliver instead of a coin.
 * Without it rotateY is a plain horizontal squash, symmetric about the centre.
 */
export const ZAICODE_WORKING_COMBO_TRANSFORM =
  "translateY(var(--zw-ty)) rotateY(var(--zw-ry)) rotate(calc(var(--zw-r1) + var(--zw-r2) + var(--zw-r3))) scale(var(--zw-s))";

const round2 = (value: number) => String(Math.round(value * 100) / 100);

function directionCss(direction: ZaicodeMotionDirection): string {
  return direction === "ccw" ? "reverse" : direction === "alternate" ? "alternate" : "normal";
}

/** Timing of one motion: spin and flip turn at the chosen pace, the back-and-forth ones glide unless told otherwise. */
function timingOf(motion: ZaicodeWorkingMotion, easing: ZaicodeMotionEasing, prefs: ZaicodeWorkingIconPrefs, curve = prefs.curve): string {
  if (easing === "steps") return "steps(var(--zw-steps), end)";
  const turning = motion === "spin" || motion === "flip";
  if (!turning && (easing === "linear" || easing === "smooth")) return "ease-in-out";
  return zaicodeEasingCss(easing, curve, prefs.steps);
}

/** Reach per motion, as the custom property its keyframes read. */
function reachVariables(motion: ZaicodeWorkingMotion, amplitude: number): Record<string, string> {
  switch (motion) {
    case "swing":
      return { "--zw-deg": `${Math.round(amplitude * 180)}deg` };
    case "wobble":
      return { "--zw-wdeg": `${Math.round(amplitude * 180)}deg` };
    case "pulse":
      return { "--zw-scale": round2(1 + amplitude * 0.6) };
    case "bounce":
      return { "--zw-px": `${Math.max(1, Math.round(amplitude * 6))}px` };
    case "breathe":
      return { "--zw-fade": round2(1 - amplitude * 0.9) };
    case "blink":
      // Blink's dark phase: Reach 100 % = gone, 5 % = barely dims.
      return { "--zw-blink-low": round2(1 - amplitude) };
    default:
      return {};
  }
}

/** Custom properties and animation of the Working icon (size stays with the host's class). */
export function zaicodeWorkingIconStyle(prefs: ZaicodeWorkingIconPrefs): CSSProperties {
  const motions = prefs.motions.filter((motion) => motion !== "none");
  const combined = motions.length > 1;
  // Swing / wobble / pulse / bounce / breathe / blink read how far to go from the amplitude.
  const amplitude = prefs.amplitude / 100;
  const reach: Record<string, string> = {};
  for (const motion of ["swing", "wobble", "pulse", "bounce", "breathe", "blink"] as const) {
    Object.assign(reach, reachVariables(motion, (prefs.tuning[motion]?.amplitude ?? prefs.amplitude) / 100));
  }
  const animations = motions.map((motion) => {
    const own = prefs.tuning[motion];
    const seconds = own?.seconds ?? prefs.seconds;
    const timing = timingOf(motion, own?.easing ?? prefs.easing, prefs, own?.curve ?? prefs.curve);
    const direction = directionCss(own?.direction ?? prefs.direction);
    const keyframes = (combined ? COMBO_KEYFRAMES : MOTION_KEYFRAMES)[motion];
    const phase = own?.phase ?? 0;
    return phase > 0
      ? `${keyframes} ${seconds}s ${timing} ${zaicodePhaseDelay(phase, seconds)} infinite ${direction}`
      : `${keyframes} ${seconds}s ${timing} infinite ${direction}`;
  });
  // The resting opacity is a filter, not the opacity property: breathe and blink animate
  // `opacity`, which used to overwrite the Opacity slider completely (SRC-043).
  const filters = [
    prefs.opacity < 100 ? `opacity(${prefs.opacity / 100})` : null,
    prefs.glow ? `drop-shadow(0 0 ${Math.round(1 + amplitude * 3)}px var(--zw-color))` : null,
  ].filter(Boolean);
  const color =
    prefs.color === "accent" ? "var(--zaicode-highlight, #f0c040)" : prefs.color === "custom" ? prefs.custom : "currentColor";
  return {
    ...reach,
    "--zw-steps": String(prefs.steps),
    "--zw-color": color,
    ...(animations.length > 0 ? { "--zw-anim": animations.join(", "), animation: "var(--zw-anim)" } : { animation: "none" }),
    ...(combined ? { transform: ZAICODE_WORKING_COMBO_TRANSFORM, opacity: "calc(var(--zw-o1) * var(--zw-o2))" } : {}),
    color,
    ...(filters.length > 0 ? { filter: filters.join(" ") } : {}),
    ...(prefs.size !== 100 ? { scale: String(prefs.size / 100) } : {}),
  } as unknown as CSSProperties;
}

/**
 * One stacked picture as a layer (SRC-048): its own opacity, size, blend,
 * offset and an extra motion on top of the icon's own. The wrapper isolates
 * the stack, so a blend mixes the layers with each other, not with the page.
 */
export function zaicodeWorkingLayerStyle(layer: ZaicodeLayerTuning | undefined, prefs: ZaicodeWorkingIconPrefs): CSSProperties {
  if (!layer) return {};
  const motion = layer.motion as ZaicodeWorkingMotion;
  const keyframes = MOTION_KEYFRAMES[motion] ?? null;
  const timing = keyframes ? timingOf(motion, prefs.easing, prefs) : null;
  return {
    // A filter, like the icon's own Opacity: a layer's breathe / blink animates `opacity` (SRC-043).
    ...(layer.opacity < 100 ? { filter: `opacity(${layer.opacity / 100})` } : {}),
    ...(layer.size !== 100 ? { scale: String(layer.size / 100) } : {}),
    ...(layer.x !== 0 || layer.y !== 0 ? { translate: `${layer.x}% ${layer.y}%` } : {}),
    ...(layer.blend !== "normal" ? { mixBlendMode: layer.blend } : {}),
    ...(keyframes
      ? {
          "--zw-layer-anim": `${keyframes} ${layer.seconds}s ${timing} infinite ${directionCss(layer.direction)}`,
          animation: "var(--zw-layer-anim)",
        }
      : {}),
  } as unknown as CSSProperties;
}

/** Whether the Reach slider changes anything for this set of motions. */
export function zaicodeWorkingMotionsReach(motions: readonly ZaicodeWorkingMotion[]): boolean {
  return motions.some((motion) => motion !== "spin" && motion !== "flip" && motion !== "none");
}
