import type { ProtrailClickEngine, ProtrailBubble, ProtrailHold } from "./protrailClickEngine.js";
import {
  HOLD_ACTIVATION_MS,
  HOLD_INTENSITY,
  WATER_RIPPLES,
  applyEasing,
  burstParticleLife,
  clamp01,
  clickHash01,
  clickRgb,
  elementalColor,
  elementalParticleCount,
  powerAlpha,
  powerSizeGain,
  type ProtrailClickSink,
  type Rgb255,
} from "./protrailClickMath.js";
import { drawProtrailWake } from "./protrailWakeMarks.js";

/**
 * ProTrail's click drawing (ClickBubbleEffect::draw / draw_hold): every
 * style's bubble, the elemental particles, Water's three staggered ripples,
 * and the attached hold aura, with ProTrail's constants.
 */

const TWO_PI = 6.2831853;

function elementalParticle(engine: ProtrailClickEngine, b: ProtrailBubble, index: number, count: number, progress: number) {
  const c = engine.config;
  const n = count;
  const i = index;
  const prog = clamp01(progress);
  const endR = c.endRadiusPx * b.power;
  const sg = powerSizeGain(b.power);
  const ringAlpha = powerAlpha(c.baseOpacity * (1 - prog), b.power);
  const u = (index ^ b.seed) >>> 0;
  const h = (mul: number, add: number) => clickHash01((Math.imul(u, mul) + add) >>> 0);
  switch (c.style) {
    case "air": {
      const angle = (TWO_PI * i) / n + 0.6 * h(3, 1) + 2.4 * prog;
      const d = endR * (0.3 + 0.55 * prog) * (0.8 + 0.4 * h(7, 2));
      return { x: b.x + Math.cos(angle) * d, y: b.y + Math.sin(angle) * d, r: 1.8 * sg * (1 - 0.45 * prog), a: ringAlpha * Math.pow(1 - prog, 1.6) * (0.6 + 0.4 * h(11, 3)), cool: 0 };
    }
    case "fire": {
      const lateral = (h(5, 1) - 0.5) * endR * 0.5;
      const wobble = Math.sin(TWO_PI * (prog + h(13, 2))) * endR * 0.12;
      const flicker = 0.55 + 0.45 * Math.sin(TWO_PI * (prog * 2 + h(19, 4)));
      return {
        x: b.x + lateral + wobble,
        y: b.y - endR * 1.15 * Math.pow(prog, 0.75),
        r: 3.2 * sg * (1 - 0.65 * prog) * (0.7 + 0.6 * h(17, 3)),
        a: ringAlpha * Math.pow(1 - prog, 1.2) * flicker,
        cool: prog,
      };
    }
    case "water": {
      const angle = (TWO_PI * i) / n + (h(37, 1) - 0.5) * (TWO_PI / n) * 0.7;
      const up = endR * 0.55 * (0.75 + 0.5 * h(41, 2));
      const gravity = endR * 1.1 * (0.85 + 0.3 * h(43, 3));
      const throwPx = endR * 0.45 * (0.7 + 0.6 * h(47, 4));
      return { x: b.x + Math.cos(angle) * throwPx * prog, y: b.y - up * prog + gravity * prog * prog, r: 1.8 * sg * (1 - 0.4 * prog) * (0.75 + 0.5 * h(53, 5)), a: ringAlpha * (0.7 + 0.3 * h(59, 6)), cool: 0 };
    }
    case "earth": {
      const angle = (TWO_PI * i) / n + 0.5 * h(23, 1);
      const d = endR * (0.75 + 0.5 * h(29, 2)) * prog;
      return {
        x: b.x + Math.cos(angle) * d,
        y: b.y + Math.sin(angle) * d * 0.35 - endR * 0.45 * prog + endR * 1.3 * prog * prog,
        r: 3.4 * sg * (0.75 + 0.6 * h(31, 3)) * (1 - 0.2 * prog),
        a: powerAlpha(c.baseOpacity * (1 - Math.pow(prog, 2.5)), b.power),
        cool: 0,
      };
    }
    default:
      return null;
  }
}

function drawBubble(engine: ProtrailClickEngine, b: ProtrailBubble, now: number, sink: ProtrailClickSink): void {
  const c = engine.config;
  const progress = engine.progress(b, now);
  if (progress >= 1) return;
  const rgb = clickRgb(c);
  const sizeGain = powerSizeGain(b.power);
  const radius = (c.startRadiusPx + (c.endRadiusPx - c.startRadiusPx) * applyEasing(c.easing, progress)) * b.power;
  const ringAlpha = powerAlpha(c.baseOpacity * (1 - progress), b.power);
  const fillAlpha = powerAlpha(c.fillOpacity * (1 - progress), b.power);
  const thickness = c.outlineThicknessPx * sizeGain;
  switch (c.style) {
    case "doubleRing":
      sink.bubble(b.x, b.y, radius, thickness, rgb, ringAlpha, 0);
      sink.bubble(b.x, b.y, radius * 0.62, thickness, rgb, ringAlpha * 0.7, 0);
      return;
    case "ripple":
      sink.bubble(b.x, b.y, radius, thickness * 0.6, rgb, ringAlpha, 0);
      return;
    case "burst":
    case "sparkBurst": {
      const spark = c.style === "sparkBurst";
      if (!spark) sink.bubble(b.x, b.y, radius, thickness, rgb, ringAlpha * 0.5, 0);
      const n = c.particleAmount;
      const sector = TWO_PI / (n > 0 ? n : 1);
      const burstR = c.endRadiusPx * b.power;
      const rotation = clickHash01((b.seed ^ 0x2545f491) >>> 0) * TWO_PI;
      for (let i = 0; i < n; i += 1) {
        if (progress >= burstParticleLife(b.seed, i, spark)) continue;
        const pk = (b.seed ^ Math.imul(i, 2654435761)) >>> 0;
        const angle = rotation + sector * i + (clickHash01((pk ^ 0x9e3779b9) >>> 0) - 0.5) * sector * (spark ? 0.85 : 0.45);
        const speed = spark ? 0.55 + 0.9 * clickHash01((pk ^ 0x85ebca6b) >>> 0) : 0.8 + 0.45 * clickHash01((pk ^ 0x85ebca6b) >>> 0);
        const travel = (burstR * 0.45 + burstR * (spark ? 0.95 : 0.7) * progress) * speed;
        const size = (spark ? 3 : 2.5) * sizeGain * (0.6 + 0.85 * clickHash01((pk ^ 0xc2b2ae35) >>> 0)) * (1 - progress * 0.5);
        const alpha = ringAlpha * (0.55 + 0.45 * clickHash01((pk ^ 0x27d4eb2f) >>> 0));
        sink.particle(b.x + Math.cos(angle) * travel, b.y + Math.sin(angle) * travel, size, rgb, alpha);
      }
      return;
    }
    case "softFlash":
      sink.bubble(b.x, b.y, radius * 0.35, thickness, rgb, 0, ringAlpha * 0.9);
      return;
    case "dotRing":
      sink.particle(b.x, b.y, 3 * sizeGain * b.power, rgb, ringAlpha);
      sink.bubble(b.x, b.y, radius, thickness, rgb, ringAlpha, fillAlpha);
      return;
    case "air":
    case "fire":
    case "water":
    case "earth": {
      const base = elementalColor(c.style, rgb, c.elementTint, 0);
      if (c.style === "air") sink.bubble(b.x, b.y, radius * 1.25, thickness * 0.5, base, ringAlpha * Math.pow(1 - progress, 1.8), 0);
      else if (c.style === "fire") sink.bubble(b.x, b.y + c.endRadiusPx * 0.05, radius * 0.3, thickness, base, 0, ringAlpha * 0.75 * Math.pow(1 - progress, 1.5));
      else if (c.style === "earth") sink.bubble(b.x, b.y, radius * 0.6, thickness * 1.6, base, ringAlpha * Math.pow(1 - progress, 2.2), 0);
      else {
        for (let k = 0; k < WATER_RIPPLES; k += 1) {
          const phase = clamp01(progress) - 0.26 * k;
          if (phase <= 0 || phase >= 1) continue;
          const r = (c.startRadiusPx + (c.endRadiusPx - c.startRadiusPx) * applyEasing(c.easing, phase)) * (1 - 0.1 * k) * b.power;
          sink.bubble(b.x, b.y, r, c.outlineThicknessPx * 0.55 * sizeGain, base, powerAlpha(c.baseOpacity * (1 - phase) * (1 - 0.18 * k), b.power), 0);
        }
      }
      const n = elementalParticleCount(c.style, c.particleAmount);
      for (let i = 0; i < n; i += 1) {
        const p = elementalParticle(engine, b, i, n, progress);
        if (!p || p.a <= 0 || p.r <= 0) continue;
        sink.particle(p.x, p.y, p.r, elementalColor(c.style, rgb, c.elementTint, p.cool), p.a);
      }
      return;
    }
    default:
      sink.bubble(b.x, b.y, radius, thickness, rgb, ringAlpha, fillAlpha);
  }
}

function drawHold(engine: ProtrailClickEngine, hold: ProtrailHold, now: number, sink: ProtrailClickSink): void {
  const c = engine.config;
  const ageMs = now - hold.start;
  if (!(ageMs >= HOLD_ACTIVATION_MS)) return;
  const charge = engine.charge(hold, now);
  const heldS = (ageMs - HOLD_ACTIVATION_MS) / 1000;
  const onset = clamp01((heldS * 1000) / 90);
  const A = Math.min(1, c.baseOpacity * HOLD_INTENSITY * c.holdIntensity * onset * (0.35 + 0.65 * charge));
  if (!(A > 0)) return;
  const R = c.endRadiusPx;
  const th = c.outlineThicknessPx;
  const { x, y } = hold;
  const rgb = clickRgb(c);
  const base = elementalColor(c.style, rgb, c.elementTint, 0);
  const hh = (i: number, salt: number) => clickHash01((hold.seed ^ Math.imul(i, 2654435761) ^ salt) >>> 0);
  const frac = (v: number) => v - Math.floor(v);
  const amount = c.particleAmount;
  const particle = (px: number, py: number, r: number, color: Rgb255, a: number) => sink.particle(px, py, r, color, a);
  switch (c.style) {
    case "doubleRing":
      sink.bubble(x, y, R * (1.7 - 1.05 * charge), th, base, A, 0);
      sink.bubble(x, y, R * (0.25 + 0.55 * charge), th, base, A * 0.75, 0);
      return;
    case "ripple": {
      const rate = 0.9 + 1.8 * charge;
      for (let k = 0; k < 3; k += 1) {
        const ph = frac(heldS * rate + k / 3);
        sink.bubble(x, y, R * (0.25 + 1.25 * ph), th * 0.6, base, A * (1 - ph), 0);
      }
      return;
    }
    case "burst": {
      const n = Math.max(4, amount);
      const orbit = R * (1.55 - 0.95 * charge);
      for (let i = 0; i < n; i += 1) {
        const ang = (TWO_PI * i) / n + 0.35 * heldS + hh(i, 0x9e3779b9) * 0.4;
        const d = orbit * (0.85 + 0.3 * hh(i, 0x85ebca6b));
        particle(x + Math.cos(ang) * d, y + Math.sin(ang) * d, 2.2 * (0.7 + 0.6 * hh(i, 0xc2b2ae35)), base, A * (0.55 + 0.45 * hh(i, 0x27d4eb2f)));
      }
      return;
    }
    case "sparkBurst": {
      const n = Math.max(4, amount);
      const bucket = Math.floor(heldS * (8 + 14 * charge)) >>> 0;
      for (let i = 0; i < n; i += 1) {
        const ang = TWO_PI * hh(i, 0x165667b1) + 1.1 * heldS * (0.5 + hh(i, 0xd1b54a35));
        const d = R * (0.5 + 1.1 * hh(i, 0x94d049bb));
        const flick = clickHash01((hold.seed ^ Math.imul(i, 2246822519) ^ Math.imul(bucket, 2654435761)) >>> 0);
        particle(x + Math.cos(ang) * d, y + Math.sin(ang) * d, 2.6 * (0.6 + 0.7 * hh(i, 0xa24baed5)), base, A * (0.25 + 0.75 * flick));
      }
      return;
    }
    case "softFlash":
      sink.bubble(x, y, R * (0.4 + 0.35 * charge) * (1 + 0.05 * Math.sin(TWO_PI * heldS * 2.2)), th, base, 0, A);
      return;
    case "dotRing":
      sink.bubble(x, y, R * (1.5 - 0.85 * charge), th, base, A * 0.85, 0);
      particle(x, y, 2.5 + 5.5 * charge, base, A);
      return;
    case "air": {
      const n = Math.max(4, amount);
      const omega = 1.2 + 5 * charge;
      for (let i = 0; i < n; i += 1) {
        const ang = (TWO_PI * i) / n + omega * heldS + hh(i, 0x3) * 0.6;
        const d = R * (0.45 + 0.55 * hh(i, 0x7));
        particle(x + Math.cos(ang) * d, y + Math.sin(ang) * d, 1.8 * (0.8 + 0.5 * hh(i, 0xb)), base, A * (0.55 + 0.45 * hh(i, 0x11)));
      }
      return;
    }
    case "fire": {
      const n = Math.max(1, Math.trunc(Math.max(3, amount) * (0.35 + 0.65 * charge)));
      for (let i = 0; i < n; i += 1) {
        const ph = frac(heldS * (0.8 + 0.5 * hh(i, 0x5)) + hh(i, 0xd));
        const lateral = (hh(i, 0x13) - 0.5) * R * 0.55;
        const wobble = Math.sin(TWO_PI * (ph + hh(i, 0x17))) * R * 0.1;
        const color = elementalColor("fire", rgb, c.elementTint, ph);
        particle(x + lateral + wobble, y - R * 1.25 * ph, 3 * (1 - 0.6 * ph) * (0.7 + 0.6 * hh(i, 0x1d)), color, A * (1 - ph));
      }
      return;
    }
    case "water": {
      const rate = 0.8 + charge;
      for (let k = 0; k < 3; k += 1) {
        const ph = frac(heldS * rate + k / 3);
        sink.bubble(x, y, R * (0.15 + 1.15 * ph), th * 0.8, base, A * (1 - ph) * (1 - ph), 0);
      }
      const drops = Math.max(2, Math.trunc(amount / 3));
      for (let i = 0; i < drops; i += 1) {
        const ph = frac(heldS * (0.9 + 0.6 * hh(i, 0x2b)) + hh(i, 0x2f));
        const hop = 4 * ph * (1 - ph);
        const ang = TWO_PI * hh(i, 0x33);
        const d = R * (0.2 + 0.45 * hh(i, 0x37));
        particle(x + Math.cos(ang) * d, y - R * 0.55 * hop + Math.sin(ang) * d * 0.25, 2 * (0.75 + 0.55 * hh(i, 0x3b)), base, A * (0.45 + 0.55 * hop));
      }
      return;
    }
    case "earth": {
      const quake = Math.sin(TWO_PI * heldS * 2.7);
      sink.bubble(x, y + R * 0.18, R * (1.35 - 0.55 * charge) * (1 + 0.03 * quake), th * (1.4 + 0.6 * charge), base, A * 0.7, 0);
      const n = Math.max(3, Math.trunc(amount / 2));
      for (let i = 0; i < n; i += 1) {
        const ang = TWO_PI * hh(i, 0x17);
        const d = R * (0.25 + 0.45 * hh(i, 0x1b)) * (0.85 + 0.3 * charge);
        const tr = Math.sin(TWO_PI * (heldS * (2.2 + 1.6 * hh(i, 0x1f)) + hh(i, 0x23)));
        const amp = R * 0.05 * (0.5 + 0.5 * charge);
        particle(x + Math.cos(ang) * d + tr * amp, y + R * 0.18 + Math.sin(ang) * d * 0.4 + Math.abs(tr) * amp * 0.6, 3.4 * (0.8 + 0.55 * hh(i, 0x25)), base, A * (0.65 + 0.35 * hh(i, 0x29)));
      }
      return;
    }
    default: {
      let ring = R * (1.7 - 1.05 * charge);
      if (charge >= 1) ring *= 1 + 0.06 * Math.sin(TWO_PI * heldS * 1.6);
      sink.bubble(x, y, ring, th * (0.8 + 0.9 * charge), base, A, 0);
    }
  }
}

/** One frame of everything the click engine shows, oldest wake first, holds on top. */
export function drawProtrailClicks(engine: ProtrailClickEngine, now: number, sink: ProtrailClickSink): void {
  for (const emission of engine.wake) drawProtrailWake(emission, now, sink);
  for (const bubble of engine.bubbles) drawBubble(engine, bubble, now, sink);
  for (const hold of engine.holds) drawHold(engine, hold, now, sink);
}
