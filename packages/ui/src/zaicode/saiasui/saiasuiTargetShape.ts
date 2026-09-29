import type { AimTarget } from "./saiasuiEngine.js";
import type { SaiasuiConfig } from "./saiasuiConfig.js";

/** Stroke of the ball's own outline, drawn inside its radius. */
export const SAIASUI_BODY_STROKE = 2;

export interface SaiasuiTargetShape {
  /** Radius of the ball itself. */
  radius: number;
  /** Radius of the approach ring right now (shrinks to the ball as the target ages). */
  ringReach: number;
  /** Half the side of the square the ball is drawn in: it holds the ring at its widest, stroke included. */
  extent: number;
}

/**
 * The ball's geometry. The ring and the ball are ONE SVG sized from this, not a
 * fixed 144 px box: the box clipped any ring wider than 72 px (settings allow a
 * ball up to 80 px and a ring up to 120 px beyond it) to four corner slivers.
 */
export function saiasuiTargetShape(
  target: Pick<AimTarget, "id" | "kind" | "born" | "expires">,
  now: number,
  config: SaiasuiConfig,
): SaiasuiTargetShape {
  const base = target.kind === "tiny" ? config.tinySize : config.targetSize;
  const radius = base * (1 + (((target.id % 5) / 5) * config.sizeVariation));
  const span = target.expires - target.born;
  const life = span > 0 ? Math.min(1, Math.max(0, (target.expires - now) / span)) : 0;
  const ringReach = radius + config.ringSize + life * config.ringDuration * config.animIntensity;
  const widest = Math.max(radius, config.ringVisible ? radius + config.ringSize + config.ringDuration * config.animIntensity : radius);
  return { radius, ringReach, extent: Math.ceil(widest + config.ringThickness + SAIASUI_BODY_STROKE) };
}
