import type { ProtrailFadeCurve, ProtrailSparkleMode, ProtrailTrailConfig, ProtrailTrailStyle } from "./protrailModel.js";

/**
 * ProTrail's trail formulas (src/effects/trail_effect.cpp), ported one to one:
 * the fade curves and plateau, head -> tail width taper, the four colour
 * modes, the per-style width / alpha multipliers (Comet, Pulse, Ribbon), the
 * Spark flicker and the sparkle decoration layer. Time is in milliseconds
 * here (ProTrail counts nanoseconds); every formula keeps its constants.
 * t = position along the visible trail: 1 = head (the cursor), 0 = tail.
 */

export type Rgb01 = [number, number, number];

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** ProTrail's style_hash (a 32-bit integer mixer). */
export function protrailHash(x: number): number {
  let h = x >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

export function protrailHash01(h: number): number {
  return (protrailHash(h) & 0x00ffffff) / 0x01000000;
}

export function applyFadeCurve(curve: ProtrailFadeCurve, p: number): number {
  const u = clamp01(p);
  if (curve === "smooth") return u * u * (3 - 2 * u);
  if (curve === "easeOut") return 1 - (1 - u) * (1 - u) * (1 - u);
  return u;
}

/** 1 until the fade-start plateau, then the curve down to exactly 0 at the lifetime boundary. */
export function fadeFor(config: Pick<ProtrailTrailConfig, "fadeStart" | "fadeCurve">, ageProgress: number): number {
  const age = clamp01(ageProgress);
  const start = clamp01(config.fadeStart);
  if (age <= start) return 1;
  const span = 1 - start;
  const progress = span > 0 ? (age - start) / span : 1;
  return 1 - applyFadeCurve(config.fadeCurve, progress);
}

export function alphaFor(config: ProtrailTrailConfig, t: number): number {
  return config.baseOpacity * fadeFor(config, 1 - clamp01(t));
}

export function widthAt(config: ProtrailTrailConfig, t: number): number {
  const u = clamp01(t);
  const target = config.tailThicknessPx + (config.headThicknessPx - config.tailThicknessPx) * u;
  const w = config.headThicknessPx + (target - config.headThicknessPx) * clamp01(config.taperStrength);
  return Math.min(40, Math.max(0.5, w));
}

const ACCENT_SPAN = 0.25;

export function colorFor(config: ProtrailTrailConfig, t: number): Rgb01 {
  const u = clamp01(t);
  const s: Rgb01 = [config.start.r / 255, config.start.g / 255, config.start.b / 255];
  const f: Rgb01 = [config.fade.r / 255, config.fade.g / 255, config.fade.b / 255];
  const lerp = (factor: number): Rgb01 => {
    const k = clamp01(factor);
    return [f[0] + (s[0] - f[0]) * k, f[1] + (s[1] - f[1]) * k, f[2] + (s[2] - f[2]) * k];
  };
  switch (config.colorMode) {
    case "gradient":
      return lerp(u);
    case "startAccent": {
      const accentStart = 1 - ACCENT_SPAN;
      return u <= accentStart ? f : lerp((u - accentStart) / ACCENT_SPAN);
    }
    case "fadeAccent":
      return u >= ACCENT_SPAN ? s : lerp(u / ACCENT_SPAN);
    default:
      return s;
  }
}

export const PULSE_PERIOD_MS = 900;

export function stylePulseMultiplier(style: ProtrailTrailStyle, t: number, nowMs: number): number {
  if (style !== "pulse") return 1;
  const phase = (((nowMs % PULSE_PERIOD_MS) + PULSE_PERIOD_MS) % PULSE_PERIOD_MS) / PULSE_PERIOD_MS;
  const wave = 0.5 + 0.5 * Math.cos(6.2831853 * (3 * clamp01(t) - phase));
  return 0.55 + 0.45 * wave;
}

export function styleWidthAt(config: ProtrailTrailConfig, t: number, nowMs: number): number {
  const u = clamp01(t);
  let multiplier = 1;
  if (config.style === "comet") multiplier = 0.15 + 1.35 * u * u * u;
  else if (config.style === "pulse") {
    const phase = (nowMs % PULSE_PERIOD_MS) / PULSE_PERIOD_MS;
    multiplier = 0.72 + 0.73 * (0.5 + 0.5 * Math.cos(6.2831853 * (3 * u - phase)));
  } else if (config.style === "ribbon") {
    const phase = (nowMs % 2400) / 2400;
    multiplier = 0.43 + 0.82 * (0.5 + 0.5 * Math.cos(6.2831853 * (2.5 * u - phase)));
  }
  return Math.min(40, Math.max(0.5, widthAt(config, u) * multiplier));
}

export function styleAlphaMultiplier(config: ProtrailTrailConfig, t: number, nowMs: number): number {
  if (config.style === "comet") {
    const u = clamp01(t);
    return 0.28 + 0.72 * Math.sqrt(u) * u;
  }
  return stylePulseMultiplier(config.style, t, nowMs);
}

export function sparkFlicker(dotIndex: number, nowMs: number): number {
  const bucket = Math.floor(nowMs / 100) >>> 0;
  let h = protrailHash((Math.imul(dotIndex >>> 0, 747796405) ^ Math.imul(bucket, 2654435761)) >>> 0);
  h = protrailHash(h);
  return 0.35 + 0.65 * ((h & 0x00ffffff) / 0x01000000);
}

/** Glow outer pass of Soft Glow / Neon (frame_geometry.h resolve_trail_style). */
export function glowPass(style: ProtrailTrailStyle, glow: number, width: number, alpha: number): { width: number; alpha: number } | null {
  if (style !== "softGlow" && style !== "neon") return null;
  const neon = style === "neon";
  return { width: width * (neon ? 3 + 3 * glow : 2 + 2 * glow), alpha: alpha * (neon ? 0.45 * glow : 0.3 * glow) };
}

export interface SparkleModeParams {
  density: number;
  spreadScale: number;
  sizeScale: number;
  alphaScale: number;
  brightness: number;
  pulsePeriodMs: number;
  shimmerBucketMs: number;
  spinRadPerS: number;
}

export function sparkleParams(mode: ProtrailSparkleMode): SparkleModeParams {
  const p = (density: number, spreadScale: number, sizeScale: number, alphaScale: number, brightness: number, pulsePeriodMs = 0, shimmerBucketMs = 0, spinRadPerS = 0) => ({
    density,
    spreadScale,
    sizeScale,
    alphaScale,
    brightness,
    pulsePeriodMs,
    shimmerBucketMs,
    spinRadPerS,
  });
  switch (mode) {
    case "stardust":
      return p(0.72, 0.42, 0.71, 0.52, 1.45);
    case "twinkle":
      return p(0.3, 0.65, 4.0, 1.0, 1.8, 350, 0, 0.65);
    case "glitter":
      return p(1.25, 0.65, 0.82, 1.0, 1.9, 0, 90);
    case "firefly":
      return p(0.14, 1.55, 2.64, 1.0, 1.7);
    case "shards":
      return p(0.48, 1.0, 2.64, 1.0, 1.55);
    default:
      return p(0, 0, 0, 0, 1);
  }
}

export type SparkleShape = "dot" | "cross" | "diamond" | "triangle";

export function sparkleShape(mode: ProtrailSparkleMode, seed: number): SparkleShape {
  if (mode === "twinkle") return (seed >>> 8) & 1 ? "cross" : "diamond";
  if (mode === "glitter") return (seed >>> 8) & 1 ? "dot" : "diamond";
  if (mode === "shards") return "triangle";
  return "dot";
}

export interface Sparkle {
  x: number;
  y: number;
  size: number;
  rotation: number;
  alpha: number;
  color: Rgb01;
  shape: SparkleShape;
}

const MODE_INDEX: Record<ProtrailSparkleMode, number> = { off: 0, stardust: 1, twinkle: 2, glitter: 3, firefly: 4, shards: 5 };

/** One sparkle for a slot on the path, deterministic in its identity (sparkle_for_point). */
export function sparkleForPoint(
  point: { x: number; y: number; t: number; occurrence: number; slot: number },
  config: ProtrailTrailConfig,
  nowMs: number,
): Sparkle | null {
  if (config.sparkleMode === "off") return null;
  const P = sparkleParams(config.sparkleMode);
  const amount = clamp01(config.sparkleAmount);
  if (!(amount > 0)) return null;
  const occ = point.occurrence >>> 0;
  const seed = protrailHash(
    (Math.imul(occ, 2654435761) ^ Math.imul(Math.floor(point.occurrence / 4294967296) >>> 0, 2246822519) ^ Math.imul(point.slot >>> 0, 747796405) ^ Math.imul(0x9e3779b9, MODE_INDEX[config.sparkleMode])) >>> 0,
  );
  const h = (salt: number) => protrailHash01((seed ^ salt) >>> 0);
  if (h(0x68bc21eb) >= amount) return null;
  const spread = config.sparkleSpreadPx * P.spreadScale;
  const pulses = P.pulsePeriodMs > 0;
  const shimmers = P.shimmerBucketMs > 0;
  const age01 = 1 - clamp01(point.t);
  const ageS = (age01 * config.lifetimeMs) / 1000;
  const ang = h(0x85ebca6b) * 6.2831853;
  const dx = Math.cos(ang);
  const dy = Math.sin(ang);
  const radius = spread * (0.25 + 0.75 * h(0xc2b2ae35));
  let drift = 0;
  let sideways = 0;
  const base = config.sparkleSpreadPx;
  if (config.sparkleMode === "stardust") drift = base * 0.32 * age01;
  else if (config.sparkleMode === "glitter") drift = base * 1.15 * Math.sqrt(age01);
  else if (config.sparkleMode === "firefly") {
    drift = base * 1.65 * age01;
    sideways = base * 0.55 * Math.sin(Math.PI * age01);
  } else if (config.sparkleMode === "shards") drift = base * (0.4 + 1.4 * h(0xd1b54a35)) * age01;
  const x = point.x + dx * (radius + drift) - dy * sideways;
  const y = point.y + dy * (radius + drift) + dx * sideways;
  const variation = config.sparkleMode === "shards" ? 0.65 + 0.8 * h(0x27d4eb2f) : 0.75 + 0.5 * h(0x27d4eb2f);
  let size = config.sparkleSizePx * P.sizeScale * variation;
  let pulse = 1;
  if (pulses) {
    pulse = Math.sin(Math.PI * clamp01(age01 / 0.62));
    size *= 0.45 + 1.35 * pulse;
  }
  size = Math.min(48, Math.max(1, size));
  let env: number;
  if (pulses) env = 0.45 + 0.55 * pulse;
  else if (shimmers) {
    const bucket = Math.floor(nowMs / P.shimmerBucketMs) >>> 0;
    env = (0.72 + 0.28 * protrailHash01((seed ^ Math.imul(bucket, 2654435761)) >>> 0)) * (0.4 + 0.6 * (1 - age01));
  } else if (config.sparkleMode === "firefly") env = 0.55 + 0.45 * Math.sqrt(1 - age01);
  else if (config.sparkleMode === "shards") {
    const fadeIn = clamp01(age01 / 0.12);
    const out = clamp01((age01 - 0.3) / 0.7);
    env = fadeIn * (1 - 0.65 * out * out * (3 - 2 * out));
  } else env = 0.55 + 0.35 * Math.sqrt(1 - age01);
  const alpha = clamp01(alphaFor(config, point.t) * P.alphaScale * env * stylePulseMultiplier(config.style, point.t, nowMs));
  if (!(alpha > 0)) return null;
  const c = colorFor(config, point.t);
  let rotation = h(0x165667b1) * Math.PI;
  if (pulses) rotation += P.spinRadPerS * ageS;
  if (config.sparkleMode === "shards") {
    const direction = h(0xa24baed5) < 0.5 ? -1 : 1;
    rotation += direction * (1.4 + 1.6 * h(0x94d049bb)) * ageS;
  }
  return {
    x,
    y,
    size,
    rotation,
    alpha,
    color: [clamp01(c[0] * P.brightness), clamp01(c[1] * P.brightness), clamp01(c[2] * P.brightness)],
    shape: sparkleShape(config.sparkleMode, seed),
  };
}
