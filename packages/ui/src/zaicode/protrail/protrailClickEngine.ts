import type { ProtrailClickConfig, ProtrailClickStyle } from "./protrailModel.js";
import {
  BASE_WAKE_SPACING_PX,
  HOLD_ACTIVATION_MS,
  HOLD_CHARGE_MS,
  MAX_ACTIVE_HOLDS,
  MAX_WAKE_BIRTHS_PER_MOVEMENT,
  MAX_WAKE_EMISSIONS,
  MOTION_MEANINGFUL_SPEED_PX_S,
  TURN_ACCENT_COOLDOWN_MS,
  TURN_ACCENT_MIN_ANGLE_RAD,
  WAKE_REFERENCE_SPEED_PX_S,
  bubbleSeed,
  clamp01,
} from "./protrailClickMath.js";

/**
 * ProTrail's click / hold / motion-wake state (ClickBubbleEffect), without
 * drawing (see protrailClickDraw). A press spawns a bubble at once and starts
 * a hold candidate; after 175 ms held it is an active hold whose charge fills
 * over 600 ms; its release spawns a second bubble whose power grows with the
 * charge. While an active hold moves, detached "wake" emissions are born at a
 * fixed spatial spacing along the path, each keeping its birth point forever.
 * Buttons: 0 left, 1 middle, 2 right (PointerEvent.button).
 */

export interface ProtrailBubble {
  x: number;
  y: number;
  start: number;
  seed: number;
  power: number;
}

export interface ProtrailHold {
  button: number;
  x: number;
  y: number;
  start: number;
  seed: number;
  lastX: number;
  lastY: number;
  lastMove: number;
  residual: number;
  ordinal: number;
  hasDir: boolean;
  lastDirX: number;
  lastDirY: number;
  moving: boolean;
  stopArmed: boolean;
  lastTurnAccent: number;
}

export interface ProtrailWake {
  x: number;
  y: number;
  birth: number;
  seed: number;
  style: ProtrailClickStyle;
  tx: number;
  ty: number;
  energy: number;
  charge: number;
  color: [number, number, number];
  tint: number;
  particles: number;
  sizeBasis: number;
  thickness: number;
  intensity: number;
  lifetime: number;
  strength: number;
  size: number;
  spread: number;
  accent: boolean;
}

export function wakeSpacingPx(density: number): number {
  const d = Math.min(2, Math.max(0.25, Number.isFinite(density) ? density : 1));
  return BASE_WAKE_SPACING_PX * Math.pow(1 / d, 0.75);
}

export function speedResponseFactor(speed: number, response: number): number {
  const r = Math.min(2, Math.max(0, response));
  return clamp01(clamp01(speed / WAKE_REFERENCE_SPEED_PX_S) * r);
}

export function turnAngle(ax: number, ay: number, bx: number, by: number): number {
  const la = Math.hypot(ax, ay);
  const lb = Math.hypot(bx, by);
  if (!(la > 0) || !(lb > 0)) return 0;
  return Math.acos(Math.min(1, Math.max(-1, (ax * bx + ay * by) / (la * lb))));
}

export class ProtrailClickEngine {
  bubbles: ProtrailBubble[] = [];
  holds: ProtrailHold[] = [];
  wake: ProtrailWake[] = [];

  constructor(public config: ProtrailClickConfig) {}

  setConfig(config: ProtrailClickConfig): void {
    if (!config.enabled || !config.holdEnabled) {
      this.holds = [];
      this.wake = [];
    } else if (!config.holdWakeEnabled) this.wake = [];
    this.config = config;
  }

  progress(bubble: ProtrailBubble, now: number): number {
    return clamp01((now - bubble.start) / this.config.durationMs);
  }

  charge(hold: ProtrailHold, now: number): number {
    const chargeMs = now - hold.start - HOLD_ACTIVATION_MS;
    return chargeMs > 0 ? clamp01(chargeMs / HOLD_CHARGE_MS) : 0;
  }

  holdActive(hold: ProtrailHold, now: number): boolean {
    return now - hold.start >= HOLD_ACTIVATION_MS;
  }

  private triggers(button: number): boolean {
    return button === 0 ? this.config.triggerLeft : button === 2 ? this.config.triggerRight : button === 1 ? this.config.triggerMiddle : false;
  }

  private spawn(x: number, y: number, ts: number): ProtrailBubble {
    const bubble = { x, y, start: ts, seed: bubbleSeed(x, y, ts), power: 1 };
    this.bubbles.push(bubble);
    if (this.bubbles.length > 64) this.bubbles.shift();
    return bubble;
  }

  down(button: number, x: number, y: number, ts: number): void {
    if (!this.config.enabled || !this.triggers(button)) return;
    if (this.config.holdEnabled) {
      this.holds = this.holds.filter((hold) => hold.button !== button);
      if (this.holds.length < MAX_ACTIVE_HOLDS) {
        this.holds.push({
          button,
          x,
          y,
          start: ts,
          seed: bubbleSeed(x, y, ts),
          lastX: x,
          lastY: y,
          lastMove: ts,
          residual: 0,
          ordinal: 0,
          hasDir: false,
          lastDirX: 0,
          lastDirY: 0,
          moving: false,
          stopArmed: false,
          lastTurnAccent: Number.NEGATIVE_INFINITY,
        });
      }
    }
    this.spawn(x, y, ts);
  }

  up(button: number, x: number, y: number, ts: number): void {
    const index = this.holds.findIndex((hold) => hold.button === button);
    if (index < 0) return;
    const hold = this.holds[index]!;
    const active = this.holdActive(hold, ts);
    const charge = this.charge(hold, ts);
    this.holds.splice(index, 1);
    if (!active || !this.config.enabled || !this.config.holdEnabled) return;
    // The charged release payoff: a second bubble whose power grows with the hold.
    this.spawn(x, y, ts).power = 1 + 1.2 * charge * this.config.holdReleaseStrength;
  }

  /** A lost button-up (focus change, a menu) must not leave a hold running: `buttons` is the real state. */
  reconcile(buttons: number, x: number, y: number, ts: number): void {
    const bit = (button: number) => (button === 0 ? 1 : button === 2 ? 2 : button === 1 ? 4 : 0);
    for (const hold of this.holds.filter((item) => (buttons & bit(item.button)) === 0)) this.up(hold.button, x, y, ts);
  }

  private emitWake(hold: ProtrailHold, seed: number, x: number, y: number, birth: number, tx: number, ty: number, energy: number, accent: boolean) {
    const c = this.config;
    if (this.wake.length >= MAX_WAKE_EMISSIONS) {
      this.prune(birth);
      if (this.wake.length >= MAX_WAKE_EMISSIONS) this.wake.shift();
    }
    this.wake.push({
      x,
      y,
      birth,
      seed: seed >>> 0,
      style: c.style,
      tx,
      ty,
      energy: clamp01(energy),
      charge: this.charge(hold, birth),
      color: [c.color.r, c.color.g, c.color.b],
      tint: c.elementTint,
      particles: c.particleAmount,
      sizeBasis: c.endRadiusPx,
      thickness: c.outlineThicknessPx,
      intensity: c.holdIntensity,
      lifetime: c.holdWakeLifetimeMs,
      strength: c.wakeStrength,
      size: c.wakeSize,
      spread: c.wakeSpread,
      accent,
    });
  }

  move(x: number, y: number, ts: number): void {
    const c = this.config;
    for (const h of this.holds) {
      const px = h.lastX;
      const py = h.lastY;
      const prev = h.lastMove;
      h.x = x;
      h.y = y;
      h.lastX = x;
      h.lastY = y;
      h.lastMove = ts;
      const dx = x - px;
      const dy = y - py;
      const len = Math.hypot(dx, dy);
      if (!(len > 0)) {
        if (h.moving && h.stopArmed) {
          if (c.stopAccent) this.emitWake(h, h.seed ^ 0x51ed2701, x, y, ts, h.lastDirX, h.lastDirY, 0, true);
          h.moving = false;
          h.stopArmed = false;
        }
        continue;
      }
      if (!c.holdWakeEnabled) continue;
      const activation = h.start + HOLD_ACTIVATION_MS;
      if (ts <= activation) continue;
      let segX = px;
      let segY = py;
      let segPrev = prev;
      let segLen = len;
      if (prev < activation) {
        const tc = clamp01(ts - prev > 0 ? (activation - prev) / (ts - prev) : 0);
        segX = px + dx * tc;
        segY = py + dy * tc;
        segPrev = activation;
        segLen = len * (1 - tc);
        h.residual = 0;
        if (!(segLen > 0)) continue;
      }
      const tx = dx / len;
      const ty = dy / len;
      const dtS = Math.min(1, Math.max(1e-3, (ts - segPrev) / 1000));
      const speed = Math.min(20000, Math.max(0, segLen / dtS));
      const gate = c.minMotionSpeedPxS > 0;
      const meaningful = gate ? speed >= c.minMotionSpeedPxS : speed >= MOTION_MEANINGFUL_SPEED_PX_S;
      if (meaningful) {
        if (c.turnAccent && h.hasDir && h.moving && ts - h.lastTurnAccent >= TURN_ACCENT_COOLDOWN_MS) {
          if (turnAngle(h.lastDirX, h.lastDirY, tx, ty) >= TURN_ACCENT_MIN_ANGLE_RAD) {
            this.emitWake(h, h.seed ^ 0x2b7e1516, x, y, ts, tx, ty, 0, true);
            h.lastTurnAccent = ts;
          }
        }
        h.lastDirX = tx;
        h.lastDirY = ty;
        h.hasDir = true;
        h.moving = true;
        h.stopArmed = true;
      } else if (h.moving && h.stopArmed) {
        if (c.stopAccent) this.emitWake(h, h.seed ^ 0x51ed2701, x, y, ts, tx, ty, 0, true);
        h.moving = false;
        h.stopArmed = false;
      }
      if (gate && speed < c.minMotionSpeedPxS) continue;
      const energy = speedResponseFactor(speed, c.speedResponse);
      const spacing = wakeSpacingPx(c.holdWakeDensity);
      const total = h.residual + segLen;
      const crossings = Math.floor(total / spacing);
      if (crossings <= 0) {
        h.residual = total;
        continue;
      }
      const over = crossings > MAX_WAKE_BIRTHS_PER_MOVEMENT;
      const births = over ? MAX_WAKE_BIRTHS_PER_MOVEMENT : crossings;
      for (let i = 0; i < births; i += 1) {
        const along = over ? (segLen * (i + 0.5)) / births : (i + 1) * spacing - h.residual;
        const t = clamp01(along / segLen);
        const tFull = t * (segLen / len);
        const seed = (h.seed ^ Math.imul(h.ordinal >>> 0, 2654435761) ^ 0x7f4a7c15) >>> 0;
        h.ordinal += 1;
        this.emitWake(h, seed, segX + dx * tFull, segY + dy * tFull, segPrev + (ts - segPrev) * t, tx, ty, energy, false);
      }
      h.residual = over ? 0 : total - crossings * spacing;
    }
  }

  prune(now: number): void {
    this.bubbles = this.bubbles.filter((bubble) => this.progress(bubble, now) < 1);
    this.wake = this.wake.filter((emission) => now - emission.birth < Math.max(1, emission.lifetime));
  }

  hasLive(now: number): boolean {
    return (
      this.holds.length > 0 ||
      this.bubbles.some((bubble) => this.progress(bubble, now) < 1) ||
      this.wake.some((emission) => now - emission.birth < Math.max(1, emission.lifetime))
    );
  }

  clear(): void {
    this.bubbles = [];
    this.holds = [];
    this.wake = [];
  }
}
