/**
 * Fine control for ZAICODE light and motion (SRC-048): own easing curves, and
 * separate settings for every part of a mix. Before this, spin + pulse, or a
 * pulse that also flickers, all read one speed / one easing / one reach; now
 * every combined motion and every combined effect keeps its own, every
 * highlight shape its own colour and strength, and every stacked picture is a
 * layer with its own opacity, size, blend and extra motion.
 *
 * Pure: types, defaults, normalizers and the CSS timing functions. The stores
 * live in zaicodeHighlights.ts, the rules in zaicodeMotionCss.ts.
 */

// ---------------------------------------------------------------- easing

export const ZAICODE_EASINGS = [
  { id: "linear", label: "Even", hint: "The same speed all the way" },
  { id: "smooth", label: "Smooth", hint: "Speeds up and slows down" },
  { id: "in", label: "Ease in", hint: "Starts slow, ends fast" },
  { id: "out", label: "Ease out", hint: "Starts fast, lands softly" },
  { id: "back", label: "Overshoot", hint: "Goes a little past the end and settles" },
  { id: "elastic", label: "Elastic", hint: "Springs past the end a few times" },
  { id: "bounce", label: "Bounce", hint: "Lands like a dropped ball" },
  { id: "steps", label: "Ticks", hint: "Jumps like a clock hand" },
  { id: "custom", label: "Own curve", hint: "Drag the two handles of your own curve" },
] as const;
export type ZaicodeMotionEasing = (typeof ZAICODE_EASINGS)[number]["id"];
export const ZAICODE_EASING_IDS = ZAICODE_EASINGS.map((easing) => easing.id) as readonly ZaicodeMotionEasing[];

/** cubic-bezier(x1, y1, x2, y2): x in 0..1, y in -1..2 (outside 0..1 = overshoot). */
export type ZaicodeBezier = [number, number, number, number];
export const ZAICODE_DEFAULT_CURVE: ZaicodeBezier = [0.3, 0, 0.2, 1];

/** Ready-made curves for the curve editor. */
export const ZAICODE_CURVE_PRESETS: readonly { label: string; curve: ZaicodeBezier }[] = [
  { label: "Ease", curve: [0.25, 0.1, 0.25, 1] },
  { label: "In-out sine", curve: [0.37, 0, 0.63, 1] },
  { label: "In-out expo", curve: [0.87, 0, 0.13, 1] },
  { label: "Out back", curve: [0.34, 1.56, 0.64, 1] },
  { label: "In back", curve: [0.36, 0, 0.66, -0.56] },
  { label: "Anticipate", curve: [0.68, -0.6, 0.32, 1.6] },
  { label: "Snap", curve: [0.9, 0, 0.1, 1] },
];

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function normalizeZaicodeBezier(value: unknown, fallback: ZaicodeBezier = ZAICODE_DEFAULT_CURVE): ZaicodeBezier {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((n) => typeof n === "number" && Number.isFinite(n))) {
    return [...fallback];
  }
  const [x1, y1, x2, y2] = value as number[];
  const x = (n: number) => round3(Math.min(1, Math.max(0, n)));
  const y = (n: number) => round3(Math.min(2, Math.max(-1, n)));
  return [x(x1!), y(y1!), x(x2!), y(y2!)];
}

/** One point of a cubic bezier at parameter t (per axis). */
function bezierAxis(t: number, p1: number, p2: number): number {
  const u = 1 - t;
  return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t;
}

/** y of the curve at x (bisection on t; the x axis is monotonic because x1, x2 are in 0..1). */
export function zaicodeBezierAt(curve: ZaicodeBezier, x: number): number {
  const [x1, y1, x2, y2] = curve;
  let low = 0;
  let high = 1;
  for (let i = 0; i < 30; i += 1) {
    const mid = (low + high) / 2;
    if (bezierAxis(mid, x1, x2) < x) low = mid;
    else high = mid;
  }
  return bezierAxis((low + high) / 2, y1, y2);
}

function easeOutElastic(x: number): number {
  if (x === 0 || x === 1) return x;
  return 2 ** (-10 * x) * Math.sin((x * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
}

function easeOutBounce(x: number): number {
  const n = 7.5625;
  const d = 2.75;
  if (x < 1 / d) return n * x * x;
  if (x < 2 / d) return n * (x - 1.5 / d) ** 2 + 0.75;
  if (x < 2.5 / d) return n * (x - 2.25 / d) ** 2 + 0.9375;
  return n * (x - 2.625 / d) ** 2 + 0.984375;
}

/** A CSS `linear()` timing function sampled from `fn` (Chromium 113+). */
function sampledLinear(fn: (x: number) => number, samples = 40): string {
  const points: string[] = [];
  for (let i = 0; i <= samples; i += 1) points.push(String(round3(fn(i / samples))));
  return `linear(${points.join(", ")})`;
}

const ELASTIC = sampledLinear(easeOutElastic);
const BOUNCE = sampledLinear(easeOutBounce);

/** The CSS timing function for an easing; `steps` ticks `steps` times per cycle. */
export function zaicodeEasingCss(easing: ZaicodeMotionEasing, curve: ZaicodeBezier, steps: number): string {
  switch (easing) {
    case "linear":
      return "linear";
    case "smooth":
      return "ease-in-out";
    case "in":
      return "cubic-bezier(0.55, 0, 1, 0.45)";
    case "out":
      return "cubic-bezier(0, 0.55, 0.45, 1)";
    case "back":
      return "cubic-bezier(0.34, 1.56, 0.64, 1)";
    case "elastic":
      return ELASTIC;
    case "bounce":
      return BOUNCE;
    case "steps":
      return `steps(${Math.max(2, Math.round(steps))}, end)`;
    case "custom": {
      const [x1, y1, x2, y2] = normalizeZaicodeBezier(curve);
      return `cubic-bezier(${x1}, ${y1}, ${x2}, ${y2})`;
    }
  }
}

// ---------------------------------------------------------------- helpers

export function tuneNumber(value: unknown, min: number, max: number, decimals = 0): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.min(max, Math.max(min, Math.round(value * factor) / factor));
}

function tunePick<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

function tuneHex(value: unknown): string | null {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;
}

/** Keeps only known keys whose value normalizes to something; an empty map stays empty. */
function tuneMap<K extends string, V>(
  raw: unknown,
  keys: readonly K[],
  normalize: (value: unknown) => V | null,
): Partial<Record<K, V>> {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: Partial<Record<K, V>> = {};
  for (const key of keys) {
    const value = normalize(source[key]);
    if (value !== null) out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------- working icon: one motion

export type ZaicodeMotionDirection = "cw" | "ccw" | "alternate";
export const ZAICODE_DIRECTIONS: readonly ZaicodeMotionDirection[] = ["cw", "ccw", "alternate"];

/** Own settings of one motion in a mix; null = follows the icon's common setting. */
export interface ZaicodeMotionTuning {
  seconds: number | null;
  easing: ZaicodeMotionEasing | null;
  curve: ZaicodeBezier | null;
  direction: ZaicodeMotionDirection | null;
  amplitude: number | null;
  /** Where in its cycle it starts, 0..100 % (two motions out of step). */
  phase: number;
}

export const ZAICODE_MOTION_TUNING_NONE: ZaicodeMotionTuning = {
  seconds: null,
  easing: null,
  curve: null,
  direction: null,
  amplitude: null,
  phase: 0,
};

export function normalizeZaicodeMotionTuning(raw: unknown): ZaicodeMotionTuning | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const tuning: ZaicodeMotionTuning = {
    seconds: tuneNumber(r.seconds, 0.2, 20, 1),
    easing: tunePick(r.easing, ZAICODE_EASING_IDS),
    curve: r.curve === null || r.curve === undefined ? null : normalizeZaicodeBezier(r.curve),
    direction: tunePick(r.direction, ZAICODE_DIRECTIONS),
    amplitude: tuneNumber(r.amplitude, 5, 100),
    phase: tuneNumber(r.phase, 0, 100) ?? 0,
  };
  return isZaicodeTuningEmpty(tuning) ? null : tuning;
}

export function isZaicodeTuningEmpty(tuning: ZaicodeMotionTuning | ZaicodeEffectTuning): boolean {
  return Object.entries(tuning).every(([key, value]) => (key === "phase" ? value === 0 : value === null));
}

export function normalizeZaicodeMotionTunings<K extends string>(raw: unknown, keys: readonly K[]): Partial<Record<K, ZaicodeMotionTuning>> {
  return tuneMap(raw, keys, normalizeZaicodeMotionTuning);
}

// ---------------------------------------------------------------- working icon: layers

export const ZAICODE_BLENDS = [
  { id: "normal", label: "Normal" },
  { id: "screen", label: "Screen" },
  { id: "lighten", label: "Lighten" },
  { id: "multiply", label: "Multiply" },
  { id: "overlay", label: "Overlay" },
  { id: "difference", label: "Difference" },
  { id: "color-dodge", label: "Dodge" },
  { id: "exclusion", label: "Exclusion" },
] as const;
export type ZaicodeBlend = (typeof ZAICODE_BLENDS)[number]["id"];
const BLEND_IDS = ZAICODE_BLENDS.map((blend) => blend.id) as readonly ZaicodeBlend[];

/** One stacked picture: its own look and an extra motion on top of the icon's. */
export interface ZaicodeLayerTuning {
  opacity: number;
  size: number;
  blend: ZaicodeBlend;
  /** An own motion id ("none" = only the icon's motion); validated against the motion list by the caller. */
  motion: string;
  seconds: number;
  direction: ZaicodeMotionDirection;
  /** Offset from the centre in % of the icon, -50..50. */
  x: number;
  y: number;
}

export const ZAICODE_LAYER_DEFAULTS: ZaicodeLayerTuning = {
  opacity: 100,
  size: 100,
  blend: "normal",
  motion: "none",
  seconds: 2.4,
  direction: "cw",
  x: 0,
  y: 0,
};

export function normalizeZaicodeLayerTuning(raw: unknown, motions: readonly string[]): ZaicodeLayerTuning | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const d = ZAICODE_LAYER_DEFAULTS;
  return {
    opacity: tuneNumber(r.opacity, 10, 100) ?? d.opacity,
    size: tuneNumber(r.size, 30, 200) ?? d.size,
    blend: tunePick(r.blend, BLEND_IDS) ?? d.blend,
    motion: typeof r.motion === "string" && motions.includes(r.motion) ? r.motion : d.motion,
    seconds: tuneNumber(r.seconds, 0.2, 20, 1) ?? d.seconds,
    direction: tunePick(r.direction, ZAICODE_DIRECTIONS) ?? d.direction,
    x: tuneNumber(r.x, -50, 50) ?? d.x,
    y: tuneNumber(r.y, -50, 50) ?? d.y,
  };
}

// ---------------------------------------------------------------- highlights

/** Own settings of one effect in a highlight mix; null = the highlight's common setting. */
export interface ZaicodeEffectTuning {
  seconds: number | null;
  easing: ZaicodeMotionEasing | null;
  curve: ZaicodeBezier | null;
  /** How far it dims at its lowest, 5..100 %; null = the effect's own depth. */
  depth: number | null;
  phase: number;
}

export function normalizeZaicodeEffectTuning(raw: unknown): ZaicodeEffectTuning | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const tuning: ZaicodeEffectTuning = {
    seconds: tuneNumber(r.seconds, 0.1, 10, 1),
    easing: tunePick(r.easing, ZAICODE_EASING_IDS),
    curve: r.curve === null || r.curve === undefined ? null : normalizeZaicodeBezier(r.curve),
    depth: tuneNumber(r.depth, 5, 100),
    phase: tuneNumber(r.phase, 0, 100) ?? 0,
  };
  return isZaicodeTuningEmpty(tuning) ? null : tuning;
}

export function normalizeZaicodeEffectTunings<K extends string>(raw: unknown, keys: readonly K[]): Partial<Record<K, ZaicodeEffectTuning>> {
  return tuneMap(raw, keys, normalizeZaicodeEffectTuning);
}

/** Own colour / strength of one highlight shape; null = the highlight's. */
export interface ZaicodeShapeTuning {
  color: string | null;
  strength: number | null;
}

export function normalizeZaicodeShapeTuning(raw: unknown): ZaicodeShapeTuning | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const tuning = { color: tuneHex(r.color), strength: tuneNumber(r.strength, 10, 100) };
  return tuning.color === null && tuning.strength === null ? null : tuning;
}

export function normalizeZaicodeShapeTunings<K extends string>(raw: unknown, keys: readonly K[]): Partial<Record<K, ZaicodeShapeTuning>> {
  return tuneMap(raw, keys, normalizeZaicodeShapeTuning);
}

/** Negative delay = start `phase` % into the cycle, so two mixed motions run out of step. */
export function zaicodePhaseDelay(phase: number, seconds: number): string {
  return phase > 0 ? `${-round3((phase / 100) * seconds)}s` : "0s";
}
