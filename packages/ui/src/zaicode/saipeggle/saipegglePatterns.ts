import type { SpgPegShape } from "./saipeggleModel.js";
import type { SaipeggleRng } from "./saipeggleRandom.js";

/**
 * The shapes SAIPEGGLE boards are built from. A pattern turns a few numbers
 * into peg places; bricks follow the pattern's direction (tangent to an arc,
 * along a line), and `mirror` repeats the pattern across the board's middle
 * the way most boards of the genre are symmetric.
 */

export interface SpgPlace {
  x: number;
  y: number;
  shape: SpgPegShape;
  angle: number;
}

interface Common {
  shape?: SpgPegShape;
  mirror?: boolean;
}

export type SpgPattern = Common &
  (
    | { kind: "arc"; cx: number; cy: number; r: number; from: number; to: number; count: number }
    | { kind: "ring"; cx: number; cy: number; r: number; count: number; phase?: number }
    | { kind: "grid"; x0: number; y0: number; cols: number; rows: number; dx: number; dy: number; stagger?: boolean }
    | { kind: "hex"; cx: number; cy: number; radius: number; spacing: number }
    | { kind: "wave"; x0: number; x1: number; y: number; amp: number; waves: number; count: number; phase?: number }
    | { kind: "spiral"; cx: number; cy: number; r0: number; r1: number; turns: number; count: number; phase?: number }
    | { kind: "diamond"; cx: number; cy: number; rx: number; ry: number; count: number }
    | { kind: "line"; x0: number; y0: number; x1: number; y1: number; count: number }
    | { kind: "heart"; cx: number; cy: number; size: number; count: number }
    | { kind: "scatter"; left: number; top: number; right: number; bottom: number; count: number; gap: number }
  );

export const SPG_CENTER_X = 160;

/** Pegs closer than this along a curve would overlap; the layout would drop every other one. */
export function saipeggleSpacing(shape: SpgPegShape): number {
  return shape === "brick" ? 12 : 10.5;
}

function sample(count: number, fn: (t: number) => SpgPlace, closed: boolean): SpgPlace[] {
  const out: SpgPlace[] = [];
  const n = Math.max(1, Math.round(count));
  for (let i = 0; i < n; i += 1) out.push(fn(closed ? i / n : n === 1 ? 0.5 : i / (n - 1)));
  return out;
}

/** `count` places along a curve, fewer when the curve is too short to hold them apart. */
function along(count: number, fn: (t: number) => SpgPlace, closed = false): SpgPlace[] {
  const probe = sample(96, fn, closed);
  let length = 0;
  for (let i = 1; i < probe.length; i += 1) length += Math.hypot(probe[i]!.x - probe[i - 1]!.x, probe[i]!.y - probe[i - 1]!.y);
  if (closed) length += Math.hypot(probe[0]!.x - probe.at(-1)!.x, probe[0]!.y - probe.at(-1)!.y);
  const room = Math.floor(length / saipeggleSpacing(probe[0]!.shape)) + (closed ? 0 : 1);
  return sample(Math.max(1, Math.min(Math.round(count), room)), fn, closed);
}

function tangent(dx: number, dy: number): number {
  return Math.atan2(dy, dx);
}

function place(p: SpgPattern, rng: SaipeggleRng): SpgPlace[] {
  const shape = p.shape ?? "round";
  switch (p.kind) {
    case "arc":
      return along(p.count, (t) => {
        const a = p.from + (p.to - p.from) * t;
        return { x: p.cx + Math.cos(a) * p.r, y: p.cy + Math.sin(a) * p.r, shape, angle: a + Math.PI / 2 };
      });
    case "ring":
      return along(
        p.count,
        (t) => {
          const a = (p.phase ?? 0) + t * Math.PI * 2;
          return { x: p.cx + Math.cos(a) * p.r, y: p.cy + Math.sin(a) * p.r, shape, angle: a + Math.PI / 2 };
        },
        true,
      );
    case "grid": {
      const out: SpgPlace[] = [];
      for (let row = 0; row < p.rows; row += 1) {
        const shift = p.stagger && row % 2 === 1 ? p.dx / 2 : 0;
        for (let col = 0; col < p.cols; col += 1) out.push({ x: p.x0 + col * p.dx + shift, y: p.y0 + row * p.dy, shape, angle: 0 });
      }
      return out;
    }
    case "hex": {
      const out: SpgPlace[] = [];
      const rows = Math.floor(p.radius / (p.spacing * 0.866));
      for (let row = -rows; row <= rows; row += 1) {
        const y = p.cy + row * p.spacing * 0.866;
        const shift = Math.abs(row) % 2 === 1 ? p.spacing / 2 : 0;
        for (let x = p.cx - p.radius + shift; x <= p.cx + p.radius; x += p.spacing) {
          if (Math.hypot(x - p.cx, y - p.cy) <= p.radius) out.push({ x, y, shape, angle: 0 });
        }
      }
      return out;
    }
    case "wave":
      return along(p.count, (t) => {
        const k = p.waves * Math.PI * 2;
        const phase = p.phase ?? 0;
        const x = p.x0 + (p.x1 - p.x0) * t;
        const y = p.y + Math.sin(phase + k * t) * p.amp;
        return { x, y, shape, angle: tangent(p.x1 - p.x0, Math.cos(phase + k * t) * p.amp * k) };
      });
    case "spiral":
      return along(p.count, (t) => {
        const a = (p.phase ?? 0) + t * p.turns * Math.PI * 2;
        const r = p.r0 + (p.r1 - p.r0) * t;
        return { x: p.cx + Math.cos(a) * r, y: p.cy + Math.sin(a) * r, shape, angle: a + Math.PI / 2 };
      });
    case "diamond":
      return along(
        p.count,
        (t) => {
          const side = Math.floor(t * 4);
          const u = t * 4 - side;
          const corners = [
            [p.cx, p.cy - p.ry],
            [p.cx + p.rx, p.cy],
            [p.cx, p.cy + p.ry],
            [p.cx - p.rx, p.cy],
          ] as const;
          const [ax, ay] = corners[side % 4]!;
          const [bx, by] = corners[(side + 1) % 4]!;
          return { x: ax + (bx - ax) * u, y: ay + (by - ay) * u, shape, angle: tangent(bx - ax, by - ay) };
        },
        true,
      );
    case "line":
      return along(p.count, (t) => ({
        x: p.x0 + (p.x1 - p.x0) * t,
        y: p.y0 + (p.y1 - p.y0) * t,
        shape,
        angle: tangent(p.x1 - p.x0, p.y1 - p.y0),
      }));
    case "heart":
      return along(
        p.count,
        (t) => {
          const a = t * Math.PI * 2;
          const hx = 16 * Math.sin(a) ** 3;
          const hy = -(13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a));
          const s = p.size / 17;
          const dx = 48 * Math.sin(a) ** 2 * Math.cos(a);
          const dy = 13 * Math.sin(a) - 10 * Math.sin(2 * a) - 6 * Math.sin(3 * a) - 4 * Math.sin(4 * a);
          return { x: p.cx + hx * s, y: p.cy + hy * s, shape, angle: tangent(dx, dy) };
        },
        true,
      );
    case "scatter": {
      const out: SpgPlace[] = [];
      for (let tries = 0; out.length < p.count && tries < p.count * 40; tries += 1) {
        const x = rng.range(p.left, p.right);
        const y = rng.range(p.top, p.bottom);
        if (out.every((q) => Math.hypot(q.x - x, q.y - y) >= p.gap)) {
          out.push({ x, y, shape, angle: shape === "brick" ? rng.range(0, Math.PI) : 0 });
        }
      }
      return out;
    }
  }
}

/** All places of one pattern (twice when mirrored; a place on the middle line is kept once). */
export function saipegglePlaces(pattern: SpgPattern, rng: SaipeggleRng): SpgPlace[] {
  const base = place(pattern, rng);
  if (!pattern.mirror) return base;
  const mirrored = base
    .filter((p) => Math.abs(p.x - SPG_CENTER_X) > 3)
    .map((p) => ({ ...p, x: 2 * SPG_CENTER_X - p.x, angle: Math.PI - p.angle }));
  return [...base, ...mirrored];
}
