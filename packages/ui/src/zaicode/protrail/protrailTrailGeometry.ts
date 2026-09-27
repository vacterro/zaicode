import type { ProtrailTrailConfig } from "./protrailModel.js";
import {
  alphaFor,
  clamp01,
  colorFor,
  glowPass,
  protrailHash,
  protrailHash01,
  sparkFlicker,
  sparkleForPoint,
  sparkleParams,
  styleAlphaMultiplier,
  styleWidthAt,
  type Rgb01,
  type Sparkle,
} from "./protrailTrailMath.js";

/**
 * One frame of ProTrail's trail (TrailEffect::build_geometry): the samples
 * inside the lifetime window, de-duplicated on a quarter-pixel grid, a
 * synthetic tail interpolated exactly at the window boundary, the live head
 * at the cursor, centripetal Catmull-Rom smoothing with adaptive subdivision,
 * head-anchored dots for Dotted / Spark, and sparkle slots whose identity is
 * the source span they sit on, so a sparkle stays put while the trail ages.
 */

export interface TrailSample {
  x: number;
  y: number;
  /** ms, performance.now() clock. */
  ts: number;
}

export type TrailCap = "round" | "butt";

export interface TrailSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  alpha: number;
  width: number;
  color: Rgb01;
  cap: TrailCap;
  glow: { width: number; alpha: number } | null;
}

export interface TrailFrame {
  segments: TrailSegment[];
  sparkles: Sparkle[];
}

interface BuildPoint {
  x: number;
  y: number;
  t: number;
  ts: number;
  live: boolean;
}

interface Piece {
  x1: number;
  y1: number;
  t1: number;
  x2: number;
  y2: number;
  t2: number;
  /** Identity of the source span (its start sample). */
  occ: number;
  /** Arc from the span start to (x1, y1). */
  occArc: number;
  live: boolean;
}

const QUANTUM = 0.25;
const q = (v: number) => Math.trunc(v / QUANTUM);
const MAX_SUBDIVISIONS = 12;
const MAX_SEGMENT_PX = 24;
const FLATNESS_TOL_PX = 0.5;
const MAX_T_STEP = 1 / MAX_SUBDIVISIONS;
const DOT_STUB_PX = 1.5;
const MAX_SPARKLES = 128;
const SPARKLE_BASE_SPACING_PX = 18;
const MAX_DOTS = 2048;

const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(bx - ax, by - ay);

export function prepareTrailPoints(
  samples: readonly TrailSample[],
  nowMs: number,
  config: ProtrailTrailConfig,
  head: { x: number; y: number } | null,
): BuildPoint[] {
  const windowStart = nowMs - config.lifetimeMs;
  const out: BuildPoint[] = [];
  for (const s of samples) {
    if (s.ts < windowStart || s.ts > nowMs) continue;
    const point = { x: s.x, y: s.y, t: clamp01(1 - (nowMs - s.ts) / config.lifetimeMs), ts: s.ts, live: false };
    const last = out[out.length - 1];
    if (!last || q(point.x) !== q(last.x) || q(point.y) !== q(last.y)) out.push(point);
  }
  // The boundary: interpolate the tail at exactly windowStart from the last sample before it.
  const first = out[0];
  if (first && first.ts > windowStart) {
    let prev: TrailSample | null = null;
    for (const s of samples) if (s.ts < windowStart && (!prev || s.ts >= prev.ts)) prev = s;
    if (prev) {
      const span = first.ts - prev.ts;
      const f = span > 0 ? clamp01((windowStart - prev.ts) / span) : 0;
      const tail = { x: prev.x + (first.x - prev.x) * f, y: prev.y + (first.y - prev.y) * f, t: 0, ts: prev.ts, live: false };
      if (q(tail.x) !== q(first.x) || q(tail.y) !== q(first.y)) out.unshift(tail);
    }
  }
  if (head && Number.isFinite(head.x) && Number.isFinite(head.y)) {
    const last = out[out.length - 1];
    if (!last || q(last.x) !== q(head.x) || q(last.y) !== q(head.y)) {
      out.push({ x: head.x, y: head.y, t: 1, ts: last ? last.ts : nowMs, live: true });
    }
  }
  return out;
}

function centripetalControls(s: number, p0: BuildPoint, p1: BuildPoint, p2: BuildPoint, p3: BuildPoint) {
  const d = (a: BuildPoint, b: BuildPoint) => Math.sqrt(Math.max(1e-6, dist(a.x, a.y, b.x, b.y)));
  const d01 = d(p0, p1);
  const d12 = d(p1, p2);
  const d23 = d(p2, p3);
  const sumL = d01 + d12 > 1e-9 ? d01 + d12 : 1;
  const sumR = d12 + d23 > 1e-9 ? d12 + d23 : 1;
  const t1x = p1.x - (p0.x - p1.x) * (d12 / sumL);
  const t1y = p1.y - (p0.y - p1.y) * (d12 / sumL);
  const t2x = p2.x - (p3.x - p2.x) * (d12 / sumR);
  const t2y = p2.y - (p3.y - p2.y) * (d12 / sumR);
  const l1x = p1.x + (p2.x - p1.x) / 3;
  const l1y = p1.y + (p2.y - p1.y) / 3;
  const l2x = p2.x - (p2.x - p1.x) / 3;
  const l2y = p2.y - (p2.y - p1.y) / 3;
  return {
    c1x: l1x + s * (p1.x + (p2.x - t1x) / 3 - l1x),
    c1y: l1y + s * (p1.y + (p2.y - t1y) / 3 - l1y),
    c2x: l2x + s * (p2.x - (t2x - p1.x) / 3 - l2x),
    c2y: l2y + s * (p2.y - (t2y - p1.y) / 3 - l2y),
  };
}

function subdivisions(x0: number, y0: number, c1x: number, c1y: number, c2x: number, c2y: number, x1: number, y1: number, tSpan: number): number {
  const chord = dist(x0, y0, x1, y1);
  const control = dist(x0, y0, c1x, c1y) + dist(c1x, c1y, c2x, c2y) + dist(c2x, c2y, x1, y1);
  if (!Number.isFinite(chord) || !Number.isFinite(control)) return 1;
  const want = Math.max(Math.sqrt(Math.max(0, control - chord) / FLATNESS_TOL_PX), chord / MAX_SEGMENT_PX, Math.max(0, tSpan) / MAX_T_STEP);
  return Math.min(MAX_SUBDIVISIONS, Math.max(1, Math.ceil(want)));
}

/** The canonical pieces of the visible path, tail to head. */
export function trailPieces(points: readonly BuildPoint[], smoothing: number): Piece[] {
  const pieces: Piece[] = [];
  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const live = b.live;
    if (smoothing <= 0 || points.length < 3) {
      pieces.push({ x1: a.x, y1: a.y, t1: a.t, x2: b.x, y2: b.y, t2: b.t, occ: a.ts, occArc: 0, live });
      continue;
    }
    const p0 = points[i - 1] ?? a;
    const p3 = points[i + 2] ?? b;
    const { c1x, c1y, c2x, c2y } = centripetalControls(smoothing, p0, a, b, p3);
    const n = subdivisions(a.x, a.y, c1x, c1y, c2x, c2y, b.x, b.y, b.t - a.t);
    let px = a.x;
    let py = a.y;
    let pt = a.t;
    let arc = 0;
    for (let k = 1; k <= n; k += 1) {
      const u = k / n;
      const v = 1 - u;
      const x = v * v * v * a.x + 3 * v * v * u * c1x + 3 * v * u * u * c2x + u * u * u * b.x;
      const y = v * v * v * a.y + 3 * v * v * u * c1y + 3 * v * u * u * c2y + u * u * u * b.y;
      const t = a.t + (b.t - a.t) * u;
      pieces.push({ x1: px, y1: py, t1: pt, x2: x, y2: y, t2: t, occ: a.ts, occArc: arc, live });
      arc += dist(px, py, x, y);
      px = x;
      py = y;
      pt = t;
    }
  }
  return pieces;
}

function sparkleSlots(pieces: readonly Piece[], config: ProtrailTrailConfig) {
  const P = sparkleParams(config.sparkleMode);
  const spacing = Math.max(2, SPARKLE_BASE_SPACING_PX / P.density);
  const slots: { x: number; y: number; t: number; occurrence: number; slot: number }[] = [];
  for (const piece of pieces) {
    const chord = dist(piece.x1, piece.y1, piece.x2, piece.y2);
    if (piece.live || !(chord > 0)) continue;
    const occurrence = Math.round(piece.occ * 1000);
    const id = ((occurrence >>> 0) ^ protrailHash(Math.floor(occurrence / 4294967296) >>> 0)) >>> 0;
    const phase = spacing * (0.05 + 0.9 * protrailHash01((id ^ 0xa27d4eb2) >>> 0));
    const first = Math.max(0, Math.ceil((piece.occArc - phase) / spacing));
    const after = Math.max(first, Math.ceil((piece.occArc + chord - phase) / spacing));
    for (let ord = first; ord < after; ord += 1) {
      const u = (phase + ord * spacing - piece.occArc) / chord;
      slots.push({
        x: piece.x1 + (piece.x2 - piece.x1) * u,
        y: piece.y1 + (piece.y2 - piece.y1) * u,
        t: piece.t1 + (piece.t2 - piece.t1) * u,
        occurrence,
        slot: ord,
      });
    }
  }
  // Over budget: the oldest slots (nearest the tail) go first.
  return slots.slice(Math.max(0, slots.length - MAX_SPARKLES));
}

export function buildTrailFrame(
  samples: readonly TrailSample[],
  nowMs: number,
  config: ProtrailTrailConfig,
  head: { x: number; y: number } | null,
): TrailFrame {
  if (!config.enabled) return { segments: [], sparkles: [] };
  const points = prepareTrailPoints(samples, nowMs, config, head);
  if (points.length < 2) return { segments: [], sparkles: [] };
  const pieces = trailPieces(points, config.smoothing);
  const segments: TrailSegment[] = [];
  const dots = config.style === "dotted" || config.style === "spark";
  if (dots) {
    const total = pieces.reduce((sum, piece) => sum + dist(piece.x1, piece.y1, piece.x2, piece.y2), 0);
    const spacing = config.segmentSpacingPx;
    // Head-anchored: the head-most dot sits half a spacing behind the cursor, so dots do not crawl.
    let offset = (total - spacing * 0.5) % spacing;
    if (offset < 0) offset += spacing;
    let carry = spacing - offset;
    let arc = 0;
    for (const piece of pieces) {
      const dx = piece.x2 - piece.x1;
      const dy = piece.y2 - piece.y1;
      const chord = Math.hypot(dx, dy);
      if (!(chord > 0)) continue;
      const start = arc;
      arc += chord;
      let next = spacing - carry;
      let emitted = false;
      while (next <= chord && segments.length < MAX_DOTS) {
        const f = next / chord;
        const t = piece.t1 + (piece.t2 - piece.t1) * f;
        const index = Math.max(0, Math.trunc((total - (start + next)) / spacing + 0.5));
        let alpha = alphaFor(config, t) * styleAlphaMultiplier(config, t, nowMs);
        if (config.style === "spark") alpha *= sparkFlicker(index, nowMs);
        const x = piece.x1 + dx * f;
        const y = piece.y1 + dy * f;
        const half = DOT_STUB_PX * 0.5;
        segments.push({
          x1: x - (dx / chord) * half,
          y1: y - (dy / chord) * half,
          x2: x + (dx / chord) * half,
          y2: y + (dy / chord) * half,
          alpha,
          width: styleWidthAt(config, t, nowMs),
          color: colorFor(config, t),
          cap: "round",
          glow: null,
        });
        emitted = true;
        next += spacing;
      }
      carry = emitted ? chord - (next - spacing) : carry + chord;
    }
  } else {
    pieces.forEach((piece, index) => {
      const alpha = alphaFor(config, piece.t2) * styleAlphaMultiplier(config, piece.t2, nowMs);
      const width = styleWidthAt(config, piece.t2, nowMs);
      segments.push({
        x1: piece.x1,
        y1: piece.y1,
        x2: piece.x2,
        y2: piece.y2,
        alpha,
        width,
        color: colorFor(config, piece.t2),
        // ProTrail's cap policy: flat joints inside the stroke, a round head, round when alone.
        cap: pieces.length <= 1 || index === pieces.length - 1 ? "round" : "butt",
        glow: glowPass(config.style, config.glowStrength, width, alpha),
      });
    });
  }
  const sparkles: Sparkle[] = [];
  if (config.sparkleMode !== "off" && points.length >= 3) {
    for (const slot of sparkleSlots(pieces, config)) {
      const sparkle = sparkleForPoint(slot, config, nowMs);
      if (sparkle) sparkles.push(sparkle);
    }
  }
  return { segments, sparkles };
}
