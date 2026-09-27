import type { SaipeggleRng } from "./saipeggleRandom.js";
import type { SpgPattern } from "./saipegglePatterns.js";

/**
 * SAIPEGGLE's board designs. Each template is a small recipe of patterns
 * whose sizes, counts and phases come from the level's seed, so one template
 * yields many boards that still read as the same design. `d` is the peg
 * density from Settings (1 = normal).
 */

export interface SpgTemplate {
  id: string;
  name: string;
  build(rng: SaipeggleRng, d: number): SpgPattern[];
}

const PI = Math.PI;
const CX = 160;
/** Counts in the recipes are for a sparse board; the genre plays best with 70-110 pegs. */
const n = (base: number, d: number) => Math.max(3, Math.round(base * d * 1.45));

export const SPG_TEMPLATES: readonly SpgTemplate[] = [
  {
    id: "arches",
    name: "Arches",
    build: (rng, d) => [
      { kind: "arc", cx: CX, cy: 210, r: 150, from: PI * 1.18, to: PI * 1.82, count: n(19, d) },
      { kind: "arc", cx: CX, cy: 210, r: 112, from: PI * 1.14, to: PI * 1.86, count: n(15, d), shape: rng.chance(0.5) ? "brick" : "round" },
      { kind: "arc", cx: CX, cy: 210, r: 74, from: PI * 1.1, to: PI * 1.9, count: n(11, d) },
      { kind: "arc", cx: CX, cy: 210, r: 38, from: PI * 1.05, to: PI * 1.95, count: n(6, d), shape: "brick" },
    ],
  },
  {
    id: "rings",
    name: "Twin Rings",
    build: (rng, d) => {
      const r = rng.range(30, 38);
      return [
        { kind: "ring", cx: 108, cy: 110, r, count: n(14, d), mirror: true, phase: rng.range(0, PI) },
        { kind: "ring", cx: 108, cy: 110, r: r * 0.45, count: n(6, d), mirror: true, shape: "brick" },
        { kind: "arc", cx: CX, cy: 150, r: 62, from: PI * 0.15, to: PI * 0.85, count: n(12, d) },
      ];
    },
  },
  {
    id: "grid",
    name: "The Grid",
    build: (rng, d) => {
      const dx = Math.round(20 / Math.sqrt(d));
      const cols = Math.floor(200 / dx);
      return [{ kind: "grid", x0: CX - ((cols - 1) * dx) / 2, y0: 56, cols, rows: rng.int(6, 8), dx, dy: 20, stagger: true }];
    },
  },
  {
    id: "waves",
    name: "Waves",
    build: (rng, d) =>
      [70, 110, 150, 190].map((y, i): SpgPattern => ({
        kind: "wave",
        x0: 60,
        x1: 260,
        y,
        amp: rng.range(8, 14),
        waves: rng.pick([1, 1.5, 2]),
        count: n(15, d),
        phase: i * rng.range(0.5, 1.5),
        shape: i % 2 === 1 ? "brick" : "round",
      })),
  },
  {
    id: "spiral",
    name: "Spiral Mind",
    build: (rng, d) => [
      { kind: "spiral", cx: CX, cy: 128, r0: 10, r1: 78, turns: rng.range(2.1, 2.6), count: n(42, d), phase: rng.range(0, PI * 2) },
      { kind: "arc", cx: CX, cy: 128, r: 96, from: PI * 0.05, to: PI * 0.95, count: n(12, d), shape: "brick" },
      { kind: "arc", cx: CX, cy: 128, r: 96, from: PI * 1.15, to: PI * 1.85, count: n(10, d) },
    ],
  },
  {
    id: "diamonds",
    name: "Diamond Mine",
    build: (_rng, d) => [
      { kind: "diamond", cx: CX, cy: 126, rx: 92, ry: 74, count: n(32, d) },
      { kind: "diamond", cx: CX, cy: 126, rx: 58, ry: 46, count: n(20, d), shape: "brick" },
      { kind: "diamond", cx: CX, cy: 126, rx: 24, ry: 19, count: n(8, d) },
    ],
  },
  {
    id: "vees",
    name: "Flying Vees",
    build: (rng, d) => [
      ...[64, 108, 152].map((y): SpgPattern => ({ kind: "line", x0: 62, y0: y, x1: CX - 8, y1: y + rng.range(22, 34), count: n(7, d), shape: "brick", mirror: true })),
      { kind: "line", x0: 70, y0: 200, x1: 250, y1: 200, count: n(10, d) },
    ],
  },
  {
    id: "heart",
    name: "Heartbeat",
    build: (rng, d) => [
      { kind: "heart", cx: CX, cy: 118, size: rng.range(62, 72), count: n(34, d) },
      { kind: "heart", cx: CX, cy: 116, size: 30, count: n(14, d), shape: "brick" },
      { kind: "scatter", left: 60, top: 180, right: 260, bottom: 208, count: n(8, d), gap: 18 },
      { kind: "scatter", left: 58, top: 46, right: 262, bottom: 66, count: n(8, d), gap: 17 },
    ],
  },
  {
    id: "pillars",
    name: "Pillars",
    build: (rng, d) => [
      ...[74, 110, 146].map((x): SpgPattern => ({ kind: "line", x0: x, y0: rng.range(54, 70), x1: x, y1: rng.range(170, 196), count: n(7, d), shape: "brick", mirror: true })),
      { kind: "grid", x0: 92, y0: 60, cols: 4, rows: 7, dx: 36, dy: 20 },
    ],
  },
  {
    id: "face",
    name: "Happy Face",
    build: (_rng, d) => [
      { kind: "ring", cx: CX, cy: 126, r: 84, count: n(34, d) },
      { kind: "ring", cx: 132, cy: 104, r: 10, count: n(7, d), mirror: true },
      { kind: "arc", cx: CX, cy: 126, r: 48, from: PI * 0.18, to: PI * 0.82, count: n(10, d), shape: "brick" },
    ],
  },
  {
    id: "hourglass",
    name: "Hourglass",
    build: (_rng, d) => [
      { kind: "line", x0: 64, y0: 56, x1: CX - 6, y1: 124, count: n(9, d), shape: "brick", mirror: true },
      { kind: "line", x0: CX - 6, y0: 136, x1: 64, y1: 204, count: n(9, d), shape: "brick", mirror: true },
      { kind: "grid", x0: 100, y0: 60, cols: 7, rows: 2, dx: 20, dy: 16, stagger: true },
      { kind: "grid", x0: 100, y0: 180, cols: 7, rows: 2, dx: 20, dy: 16, stagger: true },
    ],
  },
  {
    id: "stairs",
    name: "Stairway",
    build: (rng, d) => [
      ...[0, 1, 2, 3, 4].map((i): SpgPattern => {
        const y = 58 + i * 30;
        return { kind: "line", x0: 62 + i * 8, y0: y, x1: 104 + i * 8, y1: y + rng.range(-4, 4), count: n(3, d), shape: "brick", mirror: true };
      }),
      { kind: "scatter", left: 120, top: 60, right: 200, bottom: 200, count: n(16, d), gap: 17 },
    ],
  },
  {
    id: "galaxy",
    name: "Galaxy",
    build: (rng, d) => {
      const phase = rng.range(0, PI * 2);
      return [
        { kind: "spiral", cx: CX, cy: 126, r0: 8, r1: 84, turns: 1.3, count: n(22, d), phase },
        { kind: "spiral", cx: CX, cy: 126, r0: 8, r1: 84, turns: 1.3, count: n(22, d), phase: phase + PI, shape: "brick" },
        { kind: "scatter", left: 58, top: 48, right: 262, bottom: 208, count: n(20, d), gap: 20 },
      ];
    },
  },
  {
    id: "target",
    name: "Bullseye",
    build: (rng, d) => [
      { kind: "ring", cx: CX, cy: 124, r: 82, count: n(30, d), phase: rng.range(0, 1) },
      { kind: "ring", cx: CX, cy: 124, r: 58, count: n(20, d), shape: "brick" },
      { kind: "ring", cx: CX, cy: 124, r: 34, count: n(12, d) },
      { kind: "ring", cx: CX, cy: 124, r: 12, count: n(4, d) },
    ],
  },
  {
    id: "crossfire",
    name: "Crossfire",
    build: (_rng, d) => [
      { kind: "line", x0: 66, y0: 56, x1: 254, y1: 204, count: n(15, d) },
      { kind: "line", x0: 254, y0: 56, x1: 66, y1: 204, count: n(15, d) },
      { kind: "ring", cx: 96, cy: 130, r: 22, count: n(9, d), shape: "brick", mirror: true },
      { kind: "ring", cx: CX, cy: 76, r: 18, count: n(8, d) },
    ],
  },
  {
    id: "cathedral",
    name: "Cathedral",
    build: (_rng, d) => [
      { kind: "arc", cx: 104, cy: 110, r: 30, from: PI, to: PI * 2, count: n(9, d), shape: "brick", mirror: true },
      { kind: "line", x0: 74, y0: 112, x1: 74, y1: 196, count: n(6, d), shape: "brick", mirror: true },
      { kind: "line", x0: 134, y0: 112, x1: 134, y1: 196, count: n(6, d), shape: "brick", mirror: true },
      { kind: "grid", x0: 90, y0: 124, cols: 2, rows: 4, dx: 28, dy: 20, stagger: false, mirror: true },
      { kind: "arc", cx: CX, cy: 96, r: 40, from: PI * 1.1, to: PI * 1.9, count: n(9, d) },
    ],
  },
  {
    id: "rain",
    name: "Rainfall",
    build: (_rng, d) => [{ kind: "scatter", left: 58, top: 48, right: 262, bottom: 208, count: n(70, d), gap: 13 }],
  },
  {
    id: "honeycomb",
    name: "Hive",
    build: (rng, d) => [
      { kind: "hex", cx: CX, cy: 126, radius: 80, spacing: Math.round(19 / Math.sqrt(d)) },
      { kind: "ring", cx: CX, cy: 126, r: 94, count: n(18, d), shape: "brick", phase: rng.range(0, 1) },
    ],
  },
  {
    id: "zigzag",
    name: "Lightning",
    build: (rng, d) =>
      [0, 1, 2, 3, 4, 5].map((i): SpgPattern => ({
        kind: "line",
        x0: i % 2 === 0 ? 62 : 258,
        y0: 56 + i * 26,
        x1: i % 2 === 0 ? 258 : 62,
        y1: 56 + (i + 1) * 26 + rng.range(-3, 3),
        count: n(11, d),
        shape: i % 2 === 0 ? "brick" : "round",
      })),
  },
  {
    id: "bowl",
    name: "The Bowl",
    build: (rng, d) => [
      { kind: "arc", cx: CX, cy: 96, r: 100, from: PI * 0.12, to: PI * 0.88, count: n(18, d), shape: "brick" },
      { kind: "grid", x0: 88, y0: 56, cols: 8, rows: 4, dx: 21, dy: 18, stagger: true },
      { kind: "wave", x0: 64, x1: 256, y: 150, amp: rng.range(6, 12), waves: 2, count: n(12, d) },
    ],
  },
];

export function saipeggleTemplate(id: string): SpgTemplate | undefined {
  return SPG_TEMPLATES.find((template) => template.id === id);
}
