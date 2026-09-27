import type { ProtrailWake } from "./protrailClickEngine.js";
import {
  MAX_WAKE_MARKS_PER_EMISSION,
  WAKE_INTENSITY,
  clamp01,
  clickHash01,
  easeOutCubic,
  elementalColor,
  type ProtrailClickSink,
  type Rgb255,
} from "./protrailClickMath.js";

/**
 * ProTrail's motion-wake marks (ClickBubbleEffect::wake_marks): each emission
 * keeps its birth point forever and animates on its own clock -- rings for
 * Ring / Double Ring / Ripple, thrown particles for the bursts, discs for Soft
 * Flash, swirling motes for Air, embers for Fire, droplets for Water, dust for
 * Earth -- scaled by motion energy, wake strength, size and spread.
 */

const TWO_PI = 6.2831853;

export function drawProtrailWake(e: ProtrailWake, now: number, sink: ProtrailClickSink): number {
  const life = e.lifetime > 1 ? e.lifetime : 1;
  const p = clamp01((now - e.birth) / life);
  if (!(p < 1)) return 0;
  let marks = 0;
  const push = (kind: "ring" | "disc" | "particle", x: number, y: number, radius: number, thickness: number, color: Rgb255, alpha: number) => {
    if (marks >= MAX_WAKE_MARKS_PER_EMISSION || !(alpha > 0) || !(radius > 0)) return;
    marks += 1;
    const a = Math.min(1, alpha);
    if (kind === "ring") sink.bubble(x, y, radius, thickness, color, a, 0);
    else if (kind === "disc") sink.bubble(x, y, radius, thickness, color, 0, a);
    else sink.particle(x, y, radius, color, a);
  };
  const M = clamp01(e.energy);
  const intensity = Math.min(2, Math.max(0.25, e.intensity));
  const strength = Math.min(2, Math.max(0.25, e.strength));
  const size = Math.min(2, Math.max(0.5, e.size));
  const spread = Math.min(2, Math.max(0, e.spread));
  const A = WAKE_INTENSITY * intensity * (0.55 + 0.45 * M) * strength;
  const R = Math.max(1, e.sizeBasis) * (0.8 + 0.4 * M) * size;
  const th = Math.max(0.05, e.thickness) * size;
  const fade = 1 - p;
  const ease = easeOutCubic(p);
  const { tx, ty } = e;
  const perpX = -ty;
  const perpY = tx;
  const h01 = (salt: number) => clickHash01((e.seed ^ salt) >>> 0);
  const base = elementalColor(e.style, e.color, e.tint, 0);
  switch (e.style) {
    case "ring":
      push("ring", e.x, e.y, R * (0.4 + 1.1 * ease), th * 0.7, base, A * fade);
      break;
    case "doubleRing":
      push("ring", e.x, e.y, R * (0.45 + 1.3 * Math.pow(p, 0.85)), th * 0.7, base, A * fade);
      push("ring", e.x, e.y, R * (0.3 + 0.85 * Math.pow(p, 1.35)), th * 0.6, base, A * 0.7 * fade);
      break;
    case "ripple":
      for (let k = 0; k < 3; k += 1) {
        const ph = (p - 0.26 * k) / 0.74;
        if (!(ph > 0) || !(ph < 1)) continue;
        push("ring", e.x, e.y, R * (0.2 + 1.05 * easeOutCubic(ph)), th * 0.55, base, A * (1 - ph) * (1 - 0.15 * k));
      }
      break;
    case "burst":
    case "sparkBurst": {
      const spark = e.style === "sparkBurst";
      if (!spark) push("ring", e.x, e.y, R * (0.35 + 0.55 * ease), th * 0.5, base, A * 0.28 * fade);
      let count = 0;
      if (e.particles > 0) {
        const want = Math.trunc(e.particles / (spark ? 2 : 3)) + 1;
        count = Math.min(spark ? 5 : 4, Math.max(2, want));
      }
      const sector = count > 0 ? TWO_PI / count : 0;
      const bias = (spark ? 0.5 : 0.35) * M;
      for (let i = 0; i < count; i += 1) {
        const salt = (0x9e3779b9 + Math.imul(i, 2654435761)) >>> 0;
        const lifeShare = spark ? 0.5 + 0.5 * h01(salt ^ 0x5f356495) : 0.8 + 0.2 * h01(salt ^ 0x5f356495);
        if (p >= lifeShare) continue;
        const jitter = (h01(salt ^ 0x51ed270b) - 0.5) * sector * (spark ? 1 : 0.55);
        let dx = Math.cos(sector * i + jitter) * (1 - bias) - tx * bias;
        let dy = Math.sin(sector * i + jitter) * (1 - bias) - ty * bias;
        const dl = Math.hypot(dx, dy);
        if (dl > 1e-6) {
          dx /= dl;
          dy /= dl;
        }
        const speed = spark ? 0.5 + 1.2 * h01(salt ^ 0x85ebca6b) : 0.7 + 0.45 * h01(salt ^ 0x85ebca6b);
        const travel = R * (0.25 + 0.55 * p) * speed;
        const hot = spark && h01(salt ^ 0x1b873593) > 0.72;
        const radius = (spark ? 1.9 : 1.7) * (0.7 + 0.6 * h01(salt ^ 0xc2b2ae35)) * (hot ? 1.55 : 1) * (1 - 0.35 * p);
        const alpha = A * (spark ? 0.3 + 0.7 * h01(salt ^ 0x27d4eb2f) : 0.55 + 0.45 * h01(salt ^ 0x27d4eb2f)) * (1 - p / Math.max(0.05, lifeShare));
        const color: Rgb255 = hot ? [255, base[1] * 0.6 + 255 * 0.4, base[2] * 0.5 + 255 * 0.5] : base;
        push("particle", e.x + dx * travel, e.y + dy * travel, radius, 0, color, Math.max(0, alpha));
      }
      break;
    }
    case "softFlash":
      push("disc", e.x, e.y, R * (0.35 + 0.75 * ease), th, base, A * 0.55 * fade * fade);
      push("disc", e.x - tx * R * 0.2 * M, e.y - ty * R * 0.2 * M, R * 0.45 * fade, th * 0.7, base, A * 0.3 * fade);
      break;
    case "dotRing":
      push("particle", e.x, e.y, R * 0.22 * (1 - 0.35 * p), 0, base, A * fade);
      if (h01(0xd07) > 0.6) push("ring", e.x, e.y, R * (0.35 + 0.65 * ease), th * 0.45, base, A * 0.35 * fade);
      break;
    case "air": {
      const swirl = Math.sin(TWO_PI * p);
      for (let i = 0; i < 4; i += 1) {
        const salt = (0x3 + Math.imul(i, 2246822519)) >>> 0;
        const ang = TWO_PI * h01(salt ^ 0x11);
        const radial = R * (0.15 + 0.3 * h01(salt ^ 0x17)) * spread;
        const side = h01(salt ^ 0x1d) > 0.5 ? 1 : -1;
        const curl = R * (0.25 + 0.45 * h01(salt ^ 0x23)) * side * swirl * spread;
        const lag = R * 0.3 * M * (1 - p);
        push("particle", e.x + Math.cos(ang) * radial + perpX * curl - tx * lag, e.y + Math.sin(ang) * radial + perpY * curl - ty * lag, 1.6 * (0.75 + 0.5 * h01(salt ^ 0x29)) * (1 - 0.3 * p), 0, base, A * (0.45 + 0.55 * h01(salt ^ 0x2f)) * fade);
      }
      break;
    }
    case "fire": {
      const count = Math.min(4, Math.max(2, Math.trunc(e.particles / 3)));
      for (let i = 0; i < count; i += 1) {
        const salt = (0x5 + Math.imul(i, 2654435761)) >>> 0;
        const lateral = (h01(salt ^ 0x13) - 0.5) * R * 0.55 * spread;
        const wobble = Math.sin(TWO_PI * (p * 1.6 + h01(salt ^ 0x17))) * R * 0.12 * spread;
        const rise = R * (0.35 + 1.1 * Math.pow(p, 0.7)) * (0.7 + 0.6 * h01(salt ^ 0x1d));
        const back = R * 0.28 * M * (1 - p);
        const color = elementalColor("fire", e.color, e.tint, p);
        const flicker = 0.55 + 0.45 * Math.sin(TWO_PI * (p * 2.2 + h01(salt ^ 0x2b)));
        push("particle", e.x + lateral + wobble - tx * back, e.y - rise - ty * back * 0.35, 2.4 * (0.7 + 0.6 * h01(salt ^ 0x31)) * (1 - 0.55 * p), 0, color, A * flicker * (1 - p * p));
      }
      break;
    }
    case "water":
      push("ring", e.x, e.y, R * (0.25 + 0.85 * ease), th * 0.5, base, A * 0.45 * fade);
      for (let i = 0; i < 2; i += 1) {
        const salt = (0x2b + Math.imul(i, 2246822519)) >>> 0;
        const ang = h01(salt ^ 0x33) * TWO_PI;
        const up = R * 0.55 * (0.75 + 0.5 * h01(salt ^ 0x37));
        const grav = R * 1.05 * (0.85 + 0.3 * h01(salt ^ 0x3b));
        const thrown = R * 0.45 * (0.7 + 0.6 * h01(salt ^ 0x41)) * spread;
        push("particle", e.x + Math.cos(ang) * thrown * p, e.y - up * p + grav * p * p, 1.5 * (0.75 + 0.5 * h01(salt ^ 0x47)) * (1 - 0.35 * p), 0, base, A * (0.6 + 0.4 * h01(salt ^ 0x4d)) * (1 - p * p));
      }
      break;
    case "earth":
      push("disc", e.x, e.y + R * 0.1 * p, R * (0.3 + 0.45 * p), th * 1.4, base, A * 0.3 * fade * fade);
      for (let i = 0; i < 3; i += 1) {
        const salt = (0x1b + Math.imul(i, 2654435761)) >>> 0;
        const ang = TWO_PI * h01(salt ^ 0x1f);
        const d = R * 0.3 * (0.6 + 0.6 * h01(salt ^ 0x25)) * p * spread;
        push("particle", e.x + Math.cos(ang) * d - tx * R * 0.25 * M * (1 - 0.5 * p), e.y + Math.sin(ang) * d * 0.35 + R * 0.55 * p * p, 2.2 * (0.7 + 0.6 * h01(salt ^ 0x2d)) * (1 - 0.15 * p), 0, base, A * (0.55 + 0.45 * h01(salt ^ 0x35)) * (1 - p * p * p));
      }
      break;
    default:
      break;
  }
  return marks;
}
