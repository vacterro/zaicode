import type { CSSProperties } from "react";
import { create } from "zustand";
import { readZaicodeSetting } from "./zaicodeSettingsSnapshot.js";
import { ensureZaicodeMotionStyles } from "./zaicodeMotionCss.js";

/**
 * Light and motion (SRC-038): every highlight the operator can see -- the
 * title of a session while it works, a project with work running, a session
 * waiting for an answer, the title bar -- and the Working icon itself, each
 * with its own effect (steady, slow pulse, breathe, blink, strobe, heartbeat,
 * flicker), shape (text colour, glow, underline, box, fill, side bar, dot),
 * colour (theme, state, own, rainbow), strength, speed and whether it keeps
 * moving while the calm interface / reduced motion is on.
 *
 * Rendering is CSS only: an element gets `data-zh-*` attributes plus a few
 * custom properties (zaicodeMotionCss.ts owns the rules), so a hundred
 * highlighted rows cost no JavaScript per frame.
 */

// ---------------------------------------------------------------- highlights

export const ZAICODE_HIGHLIGHT_TARGETS = [
  { id: "sessionWorking", label: "Session title while it works", hint: "Sidebar row of a session whose agent is working right now" },
  { id: "sessionWaiting", label: "Session waiting for you", hint: "A question or a permission is waiting in that session" },
  { id: "sessionOpen", label: "The session you have open", hint: "The selected row in the sidebar" },
  { id: "projectWorking", label: "Project title while work runs", hint: "A project with at least one working session" },
  { id: "projectWaiting", label: "Project waiting for you", hint: "A project with a session that waits for your answer" },
  { id: "headerWorking", label: "Title bar while the open session works", hint: "The session name at the top of the chat" },
  { id: "meterPrepared", label: "Limit meter with a prompt ready", hint: "An AI limit meter whose scheduled prompt fires right after its reset (Scheduler)" },
] as const;

export type ZaicodeHighlightTarget = (typeof ZAICODE_HIGHLIGHT_TARGETS)[number]["id"];

export const ZAICODE_HIGHLIGHT_EFFECTS = [
  { id: "steady", label: "Steady", hint: "Always on, no movement" },
  { id: "pulse", label: "Slow pulse", hint: "Fades down and back up" },
  { id: "breathe", label: "Breathe", hint: "Rises from almost nothing and sinks again" },
  { id: "heartbeat", label: "Heartbeat", hint: "Two quick beats, then rest" },
  { id: "blink", label: "Blink", hint: "On / off, half and half" },
  { id: "strobe", label: "Strobe", hint: "A short flash, then dark" },
  { id: "flicker", label: "Flicker", hint: "An old neon sign" },
] as const;
export type ZaicodeHighlightEffect = (typeof ZAICODE_HIGHLIGHT_EFFECTS)[number]["id"];

export const ZAICODE_HIGHLIGHT_SHAPES = [
  { id: "text", label: "Text colour", hint: "The words themselves take the colour" },
  { id: "glow", label: "Glow", hint: "A halo around the letters" },
  { id: "underline", label: "Underline", hint: "A line under the title" },
  { id: "box", label: "Box", hint: "A frame around the title" },
  { id: "fill", label: "Fill", hint: "A tinted background" },
  { id: "bar", label: "Side bar", hint: "A bar on the left edge" },
  { id: "dot", label: "Dot", hint: "A small square before the title" },
] as const;
export type ZaicodeHighlightShape = (typeof ZAICODE_HIGHLIGHT_SHAPES)[number]["id"];

export const ZAICODE_HIGHLIGHT_COLORS = [
  { id: "accent", label: "Theme", hint: "The theme's highlight colour" },
  { id: "state", label: "State", hint: "Gold while working, amber while waiting, green when done" },
  { id: "custom", label: "Own", hint: "Pick any colour" },
  { id: "rainbow", label: "Rainbow", hint: "Walks through every colour" },
] as const;
export type ZaicodeHighlightColor = (typeof ZAICODE_HIGHLIGHT_COLORS)[number]["id"];

export interface ZaicodeHighlightRule {
  enabled: boolean;
  /**
   * One effect, or several running together (Shift+Click combines, SRC-043).
   * `["steady"]` = no movement; steady never shares the list with another.
   */
  effects: ZaicodeHighlightEffect[];
  /** One shape or several drawn at once (glow + box + dot, ...); never empty. */
  shapes: ZaicodeHighlightShape[];
  color: ZaicodeHighlightColor;
  /** #rrggbb for `color: "custom"`. */
  custom: string;
  /** 10..100 %. */
  strength: number;
  /** One effect cycle, 0.1..10 s. */
  seconds: number;
  /** Keeps moving while the calm interface (no animations) or the OS reduced-motion setting is on. */
  keepMoving: boolean;
}

/** Colour a `state` highlight takes per target (the same one the rest of ZAICODE uses). */
export const ZAICODE_HIGHLIGHT_STATE_COLORS: Record<ZaicodeHighlightTarget, string> = {
  sessionWorking: "#f0c040",
  sessionWaiting: "#e0a040",
  sessionOpen: "#f0c040",
  projectWorking: "#f0c040",
  projectWaiting: "#e0a040",
  headerWorking: "#f0c040",
  meterPrepared: "#50c878",
};

const rule = (
  patch: Partial<Omit<ZaicodeHighlightRule, "effects" | "shapes">> & {
    effect?: ZaicodeHighlightEffect;
    shape?: ZaicodeHighlightShape;
  },
): ZaicodeHighlightRule => {
  const { effect = "pulse", shape = "text", ...rest } = patch;
  return {
    enabled: false,
    effects: [effect],
    shapes: [shape],
    color: "accent",
    custom: "#f0c040",
    strength: 70,
    seconds: 2.4,
    keepMoving: true,
    ...rest,
  };
};

export const ZAICODE_HIGHLIGHT_DEFAULTS: Record<ZaicodeHighlightTarget, ZaicodeHighlightRule> = {
  sessionWorking: rule({ enabled: true, effect: "breathe", shape: "text", color: "state", seconds: 3 }),
  sessionWaiting: rule({ enabled: true, effect: "pulse", shape: "box", color: "state", seconds: 1.6 }),
  sessionOpen: rule({ enabled: false, effect: "steady", shape: "bar" }),
  projectWorking: rule({ enabled: false, effect: "breathe", shape: "text", color: "state", seconds: 3 }),
  projectWaiting: rule({ enabled: false, effect: "pulse", shape: "underline", color: "state", seconds: 1.6 }),
  headerWorking: rule({ enabled: false, effect: "breathe", shape: "glow", color: "state", seconds: 3 }),
  meterPrepared: rule({ enabled: true, effect: "breathe", shape: "box", color: "state", seconds: 2.2, strength: 90 }),
};

/** Combining rules per list (zaicodeCombo.ts): steady / still are the neutral values. */
export const ZAICODE_EFFECT_COMBO = { neutral: "steady" } as const;
export const ZAICODE_SHAPE_COMBO = {} as const;
export const ZAICODE_MOTION_COMBO = { neutral: "none" } as const;
/** At most three pictures stacked on top of each other. */
export const ZAICODE_IMAGE_COMBO = { max: 3 } as const;

// ---------------------------------------------------------------- working icon

export const ZAICODE_WORKING_IMAGES = [
  { id: "saipen", label: "SAIPEN mark" },
  { id: "loader", label: "Spinner" },
  { id: "cog", label: "Cog" },
  { id: "orbit", label: "Orbit" },
  { id: "atom", label: "Atom" },
  { id: "sparkle", label: "Sparkle" },
  { id: "asterisk", label: "Asterisk" },
  { id: "fan", label: "Fan" },
  { id: "hourglass", label: "Hourglass" },
  { id: "square", label: "Pixel square" },
  { id: "custom", label: "Own picture" },
] as const;
export type ZaicodeWorkingImage = (typeof ZAICODE_WORKING_IMAGES)[number]["id"];

export const ZAICODE_WORKING_MOTIONS = [
  { id: "spin", label: "Spin", hint: "Turns round and round" },
  { id: "swing", label: "Swing", hint: "Rocks left and right" },
  { id: "wobble", label: "Wobble", hint: "A nervous shake, then still" },
  { id: "pulse", label: "Pulse", hint: "Grows and shrinks" },
  { id: "breathe", label: "Breathe", hint: "Fades out and in" },
  { id: "bounce", label: "Bounce", hint: "Hops up and down" },
  { id: "flip", label: "Flip", hint: "Turns over like a coin" },
  { id: "blink", label: "Blink", hint: "On / off" },
  { id: "none", label: "Still", hint: "Does not move" },
] as const;
export type ZaicodeWorkingMotion = (typeof ZAICODE_WORKING_MOTIONS)[number]["id"];

export type ZaicodeMotionDirection = "cw" | "ccw" | "alternate";
export type ZaicodeMotionEasing = "linear" | "smooth" | "steps";

export interface ZaicodeWorkingIconPrefs {
  /** One picture, or up to three stacked on top of each other (Shift+Click, SRC-043). */
  images: ZaicodeWorkingImage[];
  /** data: URL of the operator's own picture (≤ 256 KB). */
  customImage: string | null;
  /** One motion or several at once (spin + pulse + blink ...); `["none"]` = still. */
  motions: ZaicodeWorkingMotion[];
  /** One cycle, 0.2..20 s. */
  seconds: number;
  direction: ZaicodeMotionDirection;
  easing: ZaicodeMotionEasing;
  /** Ticks per turn for `steps` easing, 2..24 (a clock hand). */
  steps: number;
  /** How far a swing / wobble / pulse / bounce / breathe / blink goes, 5..100 %. */
  amplitude: number;
  /** Size, 60..200 % of the place it sits in. */
  size: number;
  /** 20..100 %. */
  opacity: number;
  /** Colour for the drawn icons (the picture ones keep their own). */
  color: "text" | "accent" | "custom";
  custom: string;
  /** A soft glow around it. */
  glow: boolean;
  /** Keeps moving while the calm interface or the OS reduced-motion setting is on. */
  keepMoving: boolean;
}

export const ZAICODE_WORKING_ICON_DEFAULTS: ZaicodeWorkingIconPrefs = {
  images: ["saipen"],
  customImage: null,
  motions: ["spin"],
  seconds: 2.4,
  direction: "cw",
  easing: "linear",
  steps: 8,
  amplitude: 50,
  size: 100,
  opacity: 100,
  color: "text",
  custom: "#f0c040",
  glow: false,
  keepMoving: true,
};

export const ZAICODE_WORKING_CUSTOM_IMAGE_MAX = 256 * 1024;

// ---------------------------------------------------------------- normalize

function num(value: unknown, min: number, max: number, fallback: number, decimals = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const factor = 10 ** decimals;
  return Math.min(max, Math.max(min, Math.round(value * factor) / factor));
}

function pick<T extends string>(value: unknown, allowed: readonly { id: T }[] | readonly T[], fallback: T): T {
  const ids = (allowed as readonly (T | { id: T })[]).map((entry) => (typeof entry === "string" ? entry : entry.id));
  return typeof value === "string" && (ids as string[]).includes(value) ? (value as T) : fallback;
}

function hex(value: unknown, fallback: string): string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * A combined choice: the stored list (known values, no repeats), else the
 * pre-SRC-043 single value, else the fallback. The neutral value never shares
 * the list; `max` keeps the newest.
 */
function pickList<T extends string>(
  list: unknown,
  single: unknown,
  allowed: readonly { id: T }[],
  fallback: readonly T[],
  combo: { neutral?: T; max?: number } = {},
): T[] {
  const ids = allowed.map((entry) => entry.id as string);
  const source = Array.isArray(list) ? list : typeof single === "string" ? [single] : [];
  let values = [...new Set(source.filter((value): value is T => typeof value === "string" && ids.includes(value)))];
  if (combo.neutral !== undefined && values.length > 1) values = values.filter((value) => value !== combo.neutral);
  if (combo.max !== undefined && values.length > combo.max) values = values.slice(values.length - combo.max);
  return values.length > 0 ? values : [...fallback];
}

export function normalizeZaicodeHighlightRule(raw: unknown, fallback: ZaicodeHighlightRule): ZaicodeHighlightRule {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof ZaicodeHighlightRule | "effect" | "shape", unknown>>;
  return {
    enabled: flag(r.enabled, fallback.enabled),
    effects: pickList(r.effects, r.effect, ZAICODE_HIGHLIGHT_EFFECTS, fallback.effects, ZAICODE_EFFECT_COMBO),
    shapes: pickList(r.shapes, r.shape, ZAICODE_HIGHLIGHT_SHAPES, fallback.shapes, ZAICODE_SHAPE_COMBO),
    color: pick(r.color, ZAICODE_HIGHLIGHT_COLORS, fallback.color),
    custom: hex(r.custom, fallback.custom),
    strength: num(r.strength, 10, 100, fallback.strength),
    seconds: num(r.seconds, 0.1, 10, fallback.seconds, 1),
    keepMoving: flag(r.keepMoving, fallback.keepMoving),
  };
}

export function normalizeZaicodeWorkingIcon(raw: unknown): ZaicodeWorkingIconPrefs {
  const d = ZAICODE_WORKING_ICON_DEFAULTS;
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof ZaicodeWorkingIconPrefs | "image" | "motion", unknown>>;
  const customImage =
    typeof r.customImage === "string" && r.customImage.startsWith("data:image/") && r.customImage.length <= ZAICODE_WORKING_CUSTOM_IMAGE_MAX * 1.4
      ? r.customImage
      : null;
  // An own picture that is gone drops out of the stack; an empty stack is the mark again.
  const images = pickList(r.images, r.image, ZAICODE_WORKING_IMAGES, d.images, ZAICODE_IMAGE_COMBO).filter(
    (image) => image !== "custom" || customImage,
  );
  return {
    images: images.length > 0 ? images : [...d.images],
    customImage,
    motions: pickList(r.motions, r.motion, ZAICODE_WORKING_MOTIONS, d.motions, ZAICODE_MOTION_COMBO),
    seconds: num(r.seconds, 0.2, 20, d.seconds, 1),
    direction: pick(r.direction, ["cw", "ccw", "alternate"] as const, d.direction),
    easing: pick(r.easing, ["linear", "smooth", "steps"] as const, d.easing),
    steps: num(r.steps, 2, 24, d.steps),
    amplitude: num(r.amplitude, 5, 100, d.amplitude),
    size: num(r.size, 60, 200, d.size),
    opacity: num(r.opacity, 20, 100, d.opacity),
    color: pick(r.color, ["text", "accent", "custom"] as const, d.color),
    custom: hex(r.custom, d.custom),
    glow: flag(r.glow, d.glow),
    keepMoving: flag(r.keepMoving, d.keepMoving),
  };
}

export interface ZaicodeLightsPrefs {
  highlights: Record<ZaicodeHighlightTarget, ZaicodeHighlightRule>;
  working: ZaicodeWorkingIconPrefs;
}

export function normalizeZaicodeLights(raw: unknown): ZaicodeLightsPrefs {
  const r = (raw && typeof raw === "object" ? raw : {}) as { highlights?: Record<string, unknown>; working?: unknown };
  const highlights = {} as Record<ZaicodeHighlightTarget, ZaicodeHighlightRule>;
  for (const target of ZAICODE_HIGHLIGHT_TARGETS) {
    highlights[target.id] = normalizeZaicodeHighlightRule(r.highlights?.[target.id], ZAICODE_HIGHLIGHT_DEFAULTS[target.id]);
  }
  return { highlights, working: normalizeZaicodeWorkingIcon(r.working) };
}

// ---------------------------------------------------------------- pure styling

const EASING_CSS: Record<ZaicodeMotionEasing, string> = {
  linear: "linear",
  smooth: "ease-in-out",
  steps: "steps(var(--zw-steps), end)",
};

/** Keyframes (zaicodeMotionCss.ts) per effect; `steady` has none. */
const EFFECT_KEYFRAMES: Record<ZaicodeHighlightEffect, string | null> = {
  steady: null,
  pulse: "zh-pulse",
  breathe: "zh-breathe",
  heartbeat: "zh-heartbeat",
  blink: "zh-blink",
  strobe: "zh-strobe",
  flicker: "zh-flicker",
};

export interface ZaicodeLightAttrs {
  [attribute: `data-${string}`]: string | undefined;
  style: CSSProperties;
}

/**
 * The attributes and custom properties that light an element up for `target`,
 * or null when that highlight is off. `stateColor` overrides the target's
 * default state colour (e.g. the runtime verdict colour).
 */
export function zaicodeHighlightAttrs(
  target: ZaicodeHighlightTarget,
  prefs: ZaicodeHighlightRule,
  stateColor?: string | null,
): ZaicodeLightAttrs | null {
  if (!prefs.enabled) return null;
  const rainbow = prefs.color === "rainbow";
  const color =
    prefs.color === "custom"
      ? prefs.custom
      : prefs.color === "state"
        ? (stateColor ?? ZAICODE_HIGHLIGHT_STATE_COLORS[target])
        : prefs.color === "accent"
          ? "var(--zaicode-highlight, #f0c040)"
          : "hsl(var(--zh-hue) 90% 60%)";
  // Each effect animates its own strength channel; the CSS multiplies them into --zh-k,
  // so combined effects stack (a pulse that also flickers) instead of fighting over one value.
  const animations = [
    ...prefs.effects.flatMap((effect) => {
      const keyframes = EFFECT_KEYFRAMES[effect];
      return keyframes
        ? [`${keyframes} ${prefs.seconds}s ${effect === "blink" || effect === "strobe" ? "linear" : "ease-in-out"} infinite`]
        : [];
    }),
    ...(rainbow ? [`zh-hue ${Math.max(2, prefs.seconds * 3)}s linear infinite`] : []),
  ];
  const style = {
    "--zh-color": color,
    "--zh-s": String(prefs.strength / 100),
    ...(animations.length > 0 ? { "--zh-anim": animations.join(", "), animation: "var(--zh-anim)" } : {}),
  } as CSSProperties;
  return {
    "data-zh": target,
    // Space-separated: the CSS matches each shape with ~=, so shapes draw together.
    "data-zh-shape": prefs.shapes.join(" "),
    "data-zh-keep": prefs.keepMoving && animations.length > 0 ? "" : undefined,
    style,
  };
}

const MOTION_KEYFRAMES: Record<ZaicodeWorkingMotion, string | null> = {
  spin: "zw-spin",
  swing: "zw-swing",
  wobble: "zw-wobble",
  pulse: "zw-pulse",
  breathe: "zw-breathe",
  bounce: "zw-bounce",
  flip: "zw-flip",
  blink: "zw-blink",
  none: null,
};

/**
 * Combined motions (SRC-043): each one animates its own registered channel
 * (zaicodeMotionCss.ts) and one transform / opacity reads them all, so spin +
 * pulse + blink run together instead of the last one winning the property.
 */
const COMBO_KEYFRAMES: Record<ZaicodeWorkingMotion, string | null> = {
  spin: "zwc-spin",
  swing: "zwc-swing",
  wobble: "zwc-wobble",
  pulse: "zwc-pulse",
  breathe: "zwc-breathe",
  bounce: "zwc-bounce",
  flip: "zwc-flip",
  blink: "zwc-blink",
  none: null,
};

export const ZAICODE_WORKING_COMBO_TRANSFORM =
  "translateY(var(--zw-ty)) perspective(40px) rotateY(var(--zw-ry)) rotate(calc(var(--zw-r1) + var(--zw-r2) + var(--zw-r3))) scale(var(--zw-s))";

const round2 = (value: number) => String(Math.round(value * 100) / 100);

/** Custom properties and animation of the Working icon (size stays with the host's class). */
export function zaicodeWorkingIconStyle(prefs: ZaicodeWorkingIconPrefs): CSSProperties {
  const motions = prefs.motions.filter((motion) => motion !== "none");
  const combined = motions.length > 1;
  const direction = prefs.direction === "ccw" ? "reverse" : prefs.direction === "alternate" ? "alternate" : "normal";
  // Swing / wobble / pulse / bounce / breathe / blink read how far to go from the amplitude.
  const amplitude = prefs.amplitude / 100;
  const easingOf = (motion: ZaicodeWorkingMotion) =>
    motion === "spin" || motion === "flip" ? EASING_CSS[prefs.easing] : prefs.easing === "steps" ? EASING_CSS.steps : "ease-in-out";
  const animations = motions.map(
    (motion) => `${(combined ? COMBO_KEYFRAMES : MOTION_KEYFRAMES)[motion]} ${prefs.seconds}s ${easingOf(motion)} infinite ${direction}`,
  );
  // The resting opacity is a filter, not the opacity property: breathe and blink animate
  // `opacity`, which used to overwrite the Opacity slider completely (SRC-043).
  const filters = [
    prefs.opacity < 100 ? `opacity(${prefs.opacity / 100})` : null,
    prefs.glow ? `drop-shadow(0 0 ${Math.round(1 + amplitude * 3)}px var(--zw-color))` : null,
  ].filter(Boolean);
  const color =
    prefs.color === "accent" ? "var(--zaicode-highlight, #f0c040)" : prefs.color === "custom" ? prefs.custom : "currentColor";
  return {
    "--zw-deg": `${Math.round(amplitude * 180)}deg`,
    "--zw-scale": round2(1 + amplitude * 0.6),
    "--zw-px": `${Math.max(1, Math.round(amplitude * 6))}px`,
    "--zw-fade": round2(1 - amplitude * 0.9),
    // Blink's dark phase: Reach 100 % = gone, 5 % = barely dims.
    "--zw-blink-low": round2(1 - amplitude),
    "--zw-steps": String(prefs.steps),
    "--zw-color": color,
    ...(animations.length > 0 ? { "--zw-anim": animations.join(", "), animation: "var(--zw-anim)" } : { animation: "none" }),
    ...(combined ? { transform: ZAICODE_WORKING_COMBO_TRANSFORM, opacity: "calc(var(--zw-o1) * var(--zw-o2))" } : {}),
    color,
    ...(filters.length > 0 ? { filter: filters.join(" ") } : {}),
    ...(prefs.size !== 100 ? { scale: String(prefs.size / 100) } : {}),
  } as unknown as CSSProperties;
}

/** Whether the Reach slider changes anything for this set of motions. */
export function zaicodeWorkingMotionsReach(motions: readonly ZaicodeWorkingMotion[]): boolean {
  return motions.some((motion) => motion !== "spin" && motion !== "flip" && motion !== "none");
}

// ---------------------------------------------------------------- store

const STORAGE_KEY = "zaicode-lights-v1";

function load(): ZaicodeLightsPrefs {
  try {
    return normalizeZaicodeLights(JSON.parse(readZaicodeSetting(STORAGE_KEY) ?? "null"));
  } catch {
    return normalizeZaicodeLights(null);
  }
}

interface ZaicodeLightsState extends ZaicodeLightsPrefs {
  setHighlight: (target: ZaicodeHighlightTarget, patch: Partial<ZaicodeHighlightRule>) => void;
  resetHighlight: (target: ZaicodeHighlightTarget) => void;
  setWorking: (patch: Partial<ZaicodeWorkingIconPrefs>) => void;
  resetWorking: () => void;
}

export const useZaicodeLights = create<ZaicodeLightsState>((set, get) => {
  const persist = (next: ZaicodeLightsPrefs) => {
    const normalized = normalizeZaicodeLights(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    } catch {
      // preference only
    }
    set(normalized);
  };
  if (typeof document !== "undefined") ensureZaicodeMotionStyles();
  return {
    ...load(),
    setHighlight: (target, patch) => {
      const { highlights, working } = get();
      persist({ working, highlights: { ...highlights, [target]: { ...highlights[target], ...patch } } });
    },
    resetHighlight: (target) => {
      const { highlights, working } = get();
      persist({ working, highlights: { ...highlights, [target]: ZAICODE_HIGHLIGHT_DEFAULTS[target] } });
    },
    setWorking: (patch) => {
      const { highlights, working } = get();
      persist({ highlights, working: { ...working, ...patch } });
    },
    resetWorking: () => persist({ highlights: get().highlights, working: ZAICODE_WORKING_ICON_DEFAULTS }),
  };
});

/** Attributes for `target` while `active`, from the live preferences; spread onto the element. */
export function useZaicodeHighlight(
  target: ZaicodeHighlightTarget,
  active: boolean,
  stateColor?: string | null,
): ZaicodeLightAttrs | null {
  const prefs = useZaicodeLights((state) => state.highlights[target]);
  return active ? zaicodeHighlightAttrs(target, prefs, stateColor) : null;
}

/** The element props a highlight merges into. */
export interface ZaicodeLightTarget {
  className?: string | undefined;
  title?: string | undefined;
  style?: CSSProperties | undefined;
}

/** Merges highlight attributes into an element's own class / title / style. */
export function withZaicodeHighlight(
  props: ZaicodeLightTarget,
  lights: ZaicodeLightAttrs | null,
): ZaicodeLightTarget & { [attribute: `data-${string}`]: string | undefined } {
  if (!lights) return { ...props };
  const { style, ...attributes } = lights;
  return { ...props, ...attributes, style: { ...props.style, ...style } };
}
