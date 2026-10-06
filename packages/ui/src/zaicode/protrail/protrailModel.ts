/**
 * ProTrail inside ZAICODE (SRC-062): "copy the ProTrail mechanism fully
 * (vacterro/protrail) into ZAICODE, with its settings as a separate section".
 *
 * This is the configuration of ProTrail v0.1.9 (schema 11) field for field:
 * the same names (camelCase), the same bounds and the same release defaults
 * (resources/release_defaults.json), so a value means here what it means in
 * the native app. The rendering target is the same idea: "everywhere" draws
 * into per-monitor click-through overlays over the whole Windows desktop (the
 * desktop app's main process owns them and reads the mouse through Raw Input,
 * as ProTrail does); "only inside ZAICODE" uses one click-through canvas over
 * the ZAICODE window.
 */

export const PROTRAIL_TRAIL_STYLES = ["classic", "softGlow", "comet", "neon", "dotted", "pulse", "ribbon", "spark"] as const;
export type ProtrailTrailStyle = (typeof PROTRAIL_TRAIL_STYLES)[number];
export const PROTRAIL_TRAIL_STYLE_LABELS: Record<ProtrailTrailStyle, string> = {
  classic: "Classic",
  softGlow: "Soft Glow",
  comet: "Comet",
  neon: "Neon",
  dotted: "Dotted",
  pulse: "Pulse",
  ribbon: "Ribbon",
  spark: "Spark",
};

export const PROTRAIL_COLOR_MODES = ["full", "startAccent", "fadeAccent", "gradient"] as const;
export type ProtrailColorMode = (typeof PROTRAIL_COLOR_MODES)[number];
export const PROTRAIL_COLOR_MODE_LABELS: Record<ProtrailColorMode, string> = {
  full: "Solid",
  startAccent: "Head accent",
  fadeAccent: "Tail accent",
  gradient: "Gradient",
};

export const PROTRAIL_FADE_CURVES = ["linear", "smooth", "easeOut"] as const;
export type ProtrailFadeCurve = (typeof PROTRAIL_FADE_CURVES)[number];

export const PROTRAIL_SPARKLE_MODES = ["off", "stardust", "twinkle", "glitter", "firefly", "shards"] as const;
export type ProtrailSparkleMode = (typeof PROTRAIL_SPARKLE_MODES)[number];

export const PROTRAIL_CLICK_STYLES = [
  "ring",
  "doubleRing",
  "ripple",
  "burst",
  "sparkBurst",
  "softFlash",
  "dotRing",
  "air",
  "fire",
  "water",
  "earth",
] as const;
export type ProtrailClickStyle = (typeof PROTRAIL_CLICK_STYLES)[number];
export const PROTRAIL_CLICK_STYLE_LABELS: Record<ProtrailClickStyle, string> = {
  ring: "Ring",
  doubleRing: "Double Ring",
  ripple: "Ripple",
  burst: "Burst",
  sparkBurst: "Spark Burst",
  softFlash: "Soft Flash",
  dotRing: "Dot + Ring",
  air: "Air",
  fire: "Fire",
  water: "Water",
  earth: "Earth",
};
export function isProtrailElemental(style: ProtrailClickStyle): boolean {
  return style === "air" || style === "fire" || style === "water" || style === "earth";
}

export const PROTRAIL_EASINGS = ["linear", "smooth", "easeOut"] as const;
export type ProtrailEasing = (typeof PROTRAIL_EASINGS)[number];

export interface ProtrailRgb {
  r: number;
  g: number;
  b: number;
}

export interface ProtrailTrailConfig {
  enabled: boolean;
  colorMode: ProtrailColorMode;
  start: ProtrailRgb;
  fade: ProtrailRgb;
  style: ProtrailTrailStyle;
  glowStrength: number;
  segmentSpacingPx: number;
  headThicknessPx: number;
  tailThicknessPx: number;
  taperStrength: number;
  lifetimeMs: number;
  baseOpacity: number;
  smoothing: number;
  fadeStart: number;
  fadeCurve: ProtrailFadeCurve;
  sparkleMode: ProtrailSparkleMode;
  sparkleAmount: number;
  sparkleSizePx: number;
  sparkleSpreadPx: number;
}

export interface ProtrailClickConfig {
  enabled: boolean;
  triggerLeft: boolean;
  triggerRight: boolean;
  triggerMiddle: boolean;
  color: ProtrailRgb;
  style: ProtrailClickStyle;
  particleAmount: number;
  elementTint: number;
  holdEnabled: boolean;
  holdWakeEnabled: boolean;
  holdIntensity: number;
  holdWakeDensity: number;
  holdWakeLifetimeMs: number;
  holdReleaseStrength: number;
  wakeStrength: number;
  wakeSize: number;
  wakeSpread: number;
  speedResponse: number;
  minMotionSpeedPxS: number;
  turnAccent: boolean;
  stopAccent: boolean;
  startRadiusPx: number;
  endRadiusPx: number;
  durationMs: number;
  baseOpacity: number;
  outlineThicknessPx: number;
  fillOpacity: number;
  easing: ProtrailEasing;
}

export interface ProtrailConfig {
  /** ProTrail's master switch (Enable / Disable in its tray). */
  enabled: boolean;
  trail: ProtrailTrailConfig;
  click: ProtrailClickConfig;
  /** ZAICODE: 1 = ProTrail's smooth look; 2-4 = drawn on a coarser grid, hard pixel edges (the ZAICODE pixel style). */
  pixelSize: number;
  /** ZAICODE: pause while the calm interface (no animations) is on. Off = keep drawing. */
  followCalm: boolean;
  /** ZAICODE: draw over the whole desktop (every monitor, every app), like ProTrail itself. Off = only inside the ZAICODE window. */
  everywhere: boolean;
}

/** The bounds ProTrail's own validators use (trail_config.h, click_config.h). */
export const PROTRAIL_LIMITS = {
  thicknessPx: [0.5, 40],
  lifetimeMs: [50, 2000],
  trailOpacity: [0.05, 1],
  smoothing: [0, 1],
  fadeStart: [0, 0.95],
  glowStrength: [0, 1],
  segmentSpacingPx: [2, 64],
  sparkleAmount: [0, 1],
  sparkleSizePx: [1, 16],
  sparkleSpreadPx: [0, 32],
  startRadiusPx: [0, 128],
  endRadiusPx: [1, 512],
  durationMs: [50, 2000],
  clickOpacity: [0.05, 1],
  outlinePx: [0.5, 20],
  fillOpacity: [0, 1],
  particleAmount: [0, 24],
  elementTint: [0, 1],
  holdIntensity: [0.25, 2],
  holdWakeDensity: [0.25, 2],
  holdWakeLifetimeMs: [150, 2500],
  holdReleaseStrength: [0.5, 2],
  wakeStrength: [0.25, 2],
  wakeSize: [0.5, 2],
  wakeSpread: [0, 2],
  speedResponse: [0, 2],
  minMotionSpeedPxS: [0, 1000],
  pixelSize: [1, 4],
} as const;

export function protrailDefaults(): ProtrailConfig {
  return {
    enabled: true,
    trail: {
      enabled: true,
      colorMode: "full",
      start: { r: 255, g: 255, b: 0 },
      fade: { r: 255, g: 255, b: 0 },
      style: "classic",
      glowStrength: 0.5,
      segmentSpacingPx: 12,
      headThicknessPx: 3,
      tailThicknessPx: 3,
      taperStrength: 0,
      lifetimeMs: 350,
      baseOpacity: 0.9,
      smoothing: 0.75,
      fadeStart: 0,
      fadeCurve: "smooth",
      sparkleMode: "off",
      sparkleAmount: 0.7,
      sparkleSizePx: 4.5,
      sparkleSpreadPx: 10,
    },
    click: {
      enabled: true,
      triggerLeft: true,
      triggerRight: true,
      triggerMiddle: true,
      color: { r: 0, g: 200, b: 255 },
      style: "ring",
      particleAmount: 8,
      elementTint: 0.65,
      holdEnabled: true,
      // T-223: factory Motion Wake default OFF; explicit user choice and the
      // Save All snapshot both outrank this via readZaicodeSetting + normalize.
      holdWakeEnabled: false,
      holdIntensity: 1,
      holdWakeDensity: 1,
      holdWakeLifetimeMs: 800,
      holdReleaseStrength: 1,
      wakeStrength: 1,
      wakeSize: 1,
      wakeSpread: 1,
      speedResponse: 1,
      minMotionSpeedPxS: 0,
      turnAccent: false,
      stopAccent: false,
      startRadiusPx: 8,
      endRadiusPx: 26,
      durationMs: 250,
      baseOpacity: 0.85,
      outlineThicknessPx: 2.5,
      fillOpacity: 0.15,
      easing: "easeOut",
    },
    pixelSize: 1,
    followCalm: false,
    everywhere: true,
  };
}

/** ProTrail's 14-swatch palette (effect_palette.h). */
export const PROTRAIL_PALETTE: readonly (ProtrailRgb & { name: string })[] = [
  { name: "White", r: 255, g: 255, b: 255 },
  { name: "Red", r: 255, g: 64, b: 64 },
  { name: "Orange", r: 255, g: 128, b: 32 },
  { name: "Amber", r: 255, g: 190, b: 32 },
  { name: "Yellow", r: 255, g: 255, b: 0 },
  { name: "Lime", r: 180, g: 255, b: 32 },
  { name: "Green", r: 64, g: 220, b: 96 },
  { name: "Mint", r: 64, g: 255, b: 190 },
  { name: "Cyan", r: 0, g: 200, b: 255 },
  { name: "Sky", r: 64, g: 160, b: 255 },
  { name: "Blue", r: 64, g: 96, b: 255 },
  { name: "Violet", r: 150, g: 80, b: 255 },
  { name: "Magenta", r: 255, g: 64, b: 220 },
  { name: "Pink", r: 255, g: 120, b: 170 },
];

/** ProTrail's six one-click colour presets (kColorPresets). */
export const PROTRAIL_COLOR_PRESETS: readonly {
  name: string;
  mode: ProtrailColorMode;
  start: ProtrailRgb;
  fade: ProtrailRgb;
  click: ProtrailRgb;
}[] = [
  { name: "Classic", mode: "full", start: { r: 255, g: 255, b: 0 }, fade: { r: 255, g: 255, b: 0 }, click: { r: 0, g: 200, b: 255 } },
  { name: "Fire", mode: "gradient", start: { r: 255, g: 240, b: 96 }, fade: { r: 255, g: 64, b: 24 }, click: { r: 255, g: 128, b: 32 } },
  { name: "Ice", mode: "gradient", start: { r: 224, g: 250, b: 255 }, fade: { r: 64, g: 128, b: 255 }, click: { r: 64, g: 220, b: 255 } },
  { name: "Neon", mode: "gradient", start: { r: 0, g: 255, b: 220 }, fade: { r: 255, g: 64, b: 220 }, click: { r: 0, g: 200, b: 255 } },
  { name: "Toxic", mode: "gradient", start: { r: 200, g: 255, b: 32 }, fade: { r: 48, g: 180, b: 64 }, click: { r: 180, g: 255, b: 32 } },
  { name: "Violet", mode: "gradient", start: { r: 255, g: 96, b: 240 }, fade: { r: 112, g: 64, b: 255 }, click: { r: 180, g: 96, b: 255 } },
];

export function protrailRgbToHex(color: ProtrailRgb): string {
  return `#${[color.r, color.g, color.b].map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`;
}

export function protrailHexToRgb(hex: string): ProtrailRgb | null {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return match ? { r: parseInt(match[1]!, 16), g: parseInt(match[2]!, 16), b: parseInt(match[3]!, 16) } : null;
}
