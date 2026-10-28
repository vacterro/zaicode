import type { ProtrailClickConfig, ProtrailClickStyle, ProtrailEasing } from "./protrailModel.js";
import { isProtrailElemental } from "./protrailModel.js";

/**
 * ProTrail's click helpers (src/effects/click_bubble_effect.cpp): easing,
 * the click family's own hash (it differs from the trail's), per-bubble
 * seeds, the release "power" gains, and the elemental colour targets that
 * Air / Fire / Water / Earth tint toward. Constants are ProTrail's.
 */

export const HOLD_ACTIVATION_MS = 175;
export const HOLD_CHARGE_MS = 600;
export const HOLD_INTENSITY = 0.8;
export const MAX_ACTIVE_HOLDS = 3;
export const MAX_WAKE_EMISSIONS = 192;
export const MAX_WAKE_BIRTHS_PER_MOVEMENT = 14;
export const MAX_WAKE_MARKS_PER_EMISSION = 10;
export const WAKE_REFERENCE_SPEED_PX_S = 2200;
export const BASE_WAKE_SPACING_PX = 12;
export const WAKE_INTENSITY = 0.62;
export const MOTION_MEANINGFUL_SPEED_PX_S = 120;
export const TURN_ACCENT_MIN_ANGLE_RAD = 1.3962634;
export const TURN_ACCENT_COOLDOWN_MS = 250;
export const WATER_RIPPLES = 3;

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export function easeOutCubic(p: number): number {
  const inv = 1 - clamp01(p);
  return 1 - inv * inv * inv;
}

export function applyEasing(easing: ProtrailEasing, p: number): number {
  const u = clamp01(p);
  if (easing === "smooth") return u * u * (3 - 2 * u);
  if (easing === "linear") return u;
  return easeOutCubic(u);
}

/** ClickBubbleEffect::hash01. */
export function clickHash01(seed: number): number {
  let h = (Math.imul(seed >>> 0, 747796405) + 2891336453) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return (h & 0x00ffffff) / 0x01000000;
}

/** ClickBubbleEffect::bubble_seed: position and time, so two clicks never share a pattern. */
export function bubbleSeed(x: number, y: number, tsMs: number): number {
  const ns = Math.round(tsMs * 1e6);
  const lo = ns >>> 0;
  const hi = Math.floor(ns / 4294967296) >>> 0;
  let h = Math.imul(Math.trunc(x) >>> 0, 2654435761) >>> 0;
  h = (h ^ Math.imul(Math.trunc(y) >>> 0, 2246822519)) >>> 0;
  h = (h ^ Math.imul(lo, 3266489917)) >>> 0;
  h = (h ^ Math.imul(hi, 668265263)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39) >>> 0;
  h ^= h >>> 15;
  return h >>> 0;
}

export function burstParticleLife(seed: number, index: number, spark: boolean): number {
  const h = clickHash01((seed ^ Math.imul(index >>> 0, 2654435761) ^ 0x5f356495) >>> 0);
  return spark ? 0.55 + 0.45 * h : 0.78 + 0.22 * h;
}

export function powerSizeGain(power: number): number {
  return 1 + 0.35 * (Math.max(1, power) - 1);
}

export function powerAlpha(alpha: number, power: number): number {
  return Math.min(1, alpha * (1 + 0.15 * (Math.max(1, power) - 1)));
}

export type Rgb255 = [number, number, number];

export function elementTarget(style: ProtrailClickStyle, cool: number): Rgb255 {
  switch (style) {
    case "air":
      return [230, 244, 255];
    case "fire": {
      const c = clamp01(cool);
      return [255, 190 + (70 - 190) * c, 60 + (20 - 60) * c];
    }
    case "water":
      return [60, 150, 255];
    case "earth":
      return [170, 112, 62];
    default:
      return [0, 0, 0];
  }
}

export function elementalColor(style: ProtrailClickStyle, user: Rgb255, strength: number, cool: number): Rgb255 {
  if (!isProtrailElemental(style)) return user;
  const t = clamp01(strength);
  const target = elementTarget(style, cool);
  return [user[0] + (target[0] - user[0]) * t, user[1] + (target[1] - user[1]) * t, user[2] + (target[2] - user[2]) * t];
}

export function elementalParticleCount(style: ProtrailClickStyle, amount: number): number {
  if (amount <= 0) return 0;
  if (style === "water") return Math.trunc(amount / 3);
  if (style === "earth") return Math.max(3, Math.trunc((amount + 1) / 2));
  return amount;
}

/** Where drawing goes: a ring / disc ("bubble") or a filled particle. Colours 0..255. */
export interface ProtrailClickSink {
  bubble(x: number, y: number, radius: number, thickness: number, rgb: Rgb255, ringAlpha: number, fillAlpha: number): void;
  particle(x: number, y: number, radius: number, rgb: Rgb255, alpha: number): void;
}

export function clickRgb(config: Pick<ProtrailClickConfig, "color">): Rgb255 {
  return [config.color.r, config.color.g, config.color.b];
}
