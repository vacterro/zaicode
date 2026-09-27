import {
  PROTRAIL_CLICK_STYLES,
  PROTRAIL_COLOR_MODES,
  PROTRAIL_EASINGS,
  PROTRAIL_FADE_CURVES,
  PROTRAIL_LIMITS,
  PROTRAIL_SPARKLE_MODES,
  PROTRAIL_TRAIL_STYLES,
  protrailDefaults,
  type ProtrailConfig,
  type ProtrailRgb,
} from "./protrailModel.js";

/**
 * Stored ProTrail settings -> a render-safe value, the way ProTrail's own
 * TrailConfig::validated / ClickConfig::validated do it: out-of-range values
 * clamp, a NaN repairs to the product default, an unknown enum repairs to the
 * safe default (a corrupted sparkle mode is Off, never "on by accident"), and
 * the click's end radius is never smaller than its start radius.
 */

type Raw = Record<string, unknown>;

function record(value: unknown): Raw {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : {};
}

function num(value: unknown, [min, max]: readonly [number, number], fallback: number): number {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function oneOf<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return options.includes(value as T) ? (value as T) : fallback;
}

function rgb(value: unknown, fallback: ProtrailRgb): ProtrailRgb {
  const r = record(value);
  const channel = (v: unknown, f: number) => (typeof v === "number" && Number.isFinite(v) ? Math.round(Math.min(255, Math.max(0, v))) : f);
  return { r: channel(r.r, fallback.r), g: channel(r.g, fallback.g), b: channel(r.b, fallback.b) };
}

export function normalizeProtrailConfig(raw: unknown): ProtrailConfig {
  const d = protrailDefaults();
  const r = record(raw);
  const t = record(r.trail);
  const c = record(r.click);
  const L = PROTRAIL_LIMITS;
  const startRadius = num(c.startRadiusPx, L.startRadiusPx, d.click.startRadiusPx);
  return {
    enabled: flag(r.enabled, d.enabled),
    pixelSize: Math.round(num(r.pixelSize, L.pixelSize, d.pixelSize)),
    followCalm: flag(r.followCalm, d.followCalm),
    everywhere: flag(r.everywhere, d.everywhere),
    trail: {
      enabled: flag(t.enabled, d.trail.enabled),
      colorMode: oneOf(t.colorMode, PROTRAIL_COLOR_MODES, d.trail.colorMode),
      start: rgb(t.start, d.trail.start),
      fade: rgb(t.fade, d.trail.fade),
      style: oneOf(t.style, PROTRAIL_TRAIL_STYLES, d.trail.style),
      glowStrength: num(t.glowStrength, L.glowStrength, d.trail.glowStrength),
      segmentSpacingPx: num(t.segmentSpacingPx, L.segmentSpacingPx, d.trail.segmentSpacingPx),
      headThicknessPx: num(t.headThicknessPx, L.thicknessPx, d.trail.headThicknessPx),
      tailThicknessPx: num(t.tailThicknessPx, L.thicknessPx, d.trail.tailThicknessPx),
      taperStrength: num(t.taperStrength, [0, 1], d.trail.taperStrength),
      lifetimeMs: num(t.lifetimeMs, L.lifetimeMs, d.trail.lifetimeMs),
      baseOpacity: num(t.baseOpacity, L.trailOpacity, d.trail.baseOpacity),
      smoothing: num(t.smoothing, L.smoothing, d.trail.smoothing),
      fadeStart: num(t.fadeStart, L.fadeStart, d.trail.fadeStart),
      // An invalid persisted curve repairs to Smooth, the current product default (T-020).
      fadeCurve: oneOf(t.fadeCurve, PROTRAIL_FADE_CURVES, "smooth"),
      sparkleMode: oneOf(t.sparkleMode, PROTRAIL_SPARKLE_MODES, "off"),
      sparkleAmount: num(t.sparkleAmount, L.sparkleAmount, d.trail.sparkleAmount),
      sparkleSizePx: num(t.sparkleSizePx, L.sparkleSizePx, d.trail.sparkleSizePx),
      sparkleSpreadPx: num(t.sparkleSpreadPx, L.sparkleSpreadPx, d.trail.sparkleSpreadPx),
    },
    click: {
      enabled: flag(c.enabled, d.click.enabled),
      triggerLeft: flag(c.triggerLeft, d.click.triggerLeft),
      triggerRight: flag(c.triggerRight, d.click.triggerRight),
      triggerMiddle: flag(c.triggerMiddle, d.click.triggerMiddle),
      color: rgb(c.color, d.click.color),
      style: oneOf(c.style, PROTRAIL_CLICK_STYLES, "ring"),
      particleAmount: Math.round(num(c.particleAmount, L.particleAmount, d.click.particleAmount)),
      elementTint: num(c.elementTint, L.elementTint, d.click.elementTint),
      holdEnabled: flag(c.holdEnabled, d.click.holdEnabled),
      holdWakeEnabled: flag(c.holdWakeEnabled, d.click.holdWakeEnabled),
      holdIntensity: num(c.holdIntensity, L.holdIntensity, d.click.holdIntensity),
      holdWakeDensity: num(c.holdWakeDensity, L.holdWakeDensity, d.click.holdWakeDensity),
      holdWakeLifetimeMs: num(c.holdWakeLifetimeMs, L.holdWakeLifetimeMs, d.click.holdWakeLifetimeMs),
      holdReleaseStrength: num(c.holdReleaseStrength, L.holdReleaseStrength, d.click.holdReleaseStrength),
      wakeStrength: num(c.wakeStrength, L.wakeStrength, d.click.wakeStrength),
      wakeSize: num(c.wakeSize, L.wakeSize, d.click.wakeSize),
      wakeSpread: num(c.wakeSpread, L.wakeSpread, d.click.wakeSpread),
      speedResponse: num(c.speedResponse, L.speedResponse, d.click.speedResponse),
      minMotionSpeedPxS: num(c.minMotionSpeedPxS, L.minMotionSpeedPxS, d.click.minMotionSpeedPxS),
      turnAccent: flag(c.turnAccent, d.click.turnAccent),
      stopAccent: flag(c.stopAccent, d.click.stopAccent),
      startRadiusPx: startRadius,
      endRadiusPx: Math.max(startRadius, num(c.endRadiusPx, L.endRadiusPx, d.click.endRadiusPx)),
      durationMs: num(c.durationMs, L.durationMs, d.click.durationMs),
      baseOpacity: num(c.baseOpacity, L.clickOpacity, d.click.baseOpacity),
      outlineThicknessPx: num(c.outlineThicknessPx, L.outlinePx, d.click.outlineThicknessPx),
      fillOpacity: num(c.fillOpacity, L.fillOpacity, d.click.fillOpacity),
      easing: oneOf(c.easing, PROTRAIL_EASINGS, "easeOut"),
    },
  };
}
