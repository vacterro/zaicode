/**
 * SAIASUI tuning model: one flat config, its shipped defaults, per-field
 * limits, named presets and a normalizer that clamps every persisted value on
 * read. Defaults reproduce the engine's former hard-coded constants exactly,
 * so a stored blob from before this model still plays identically.
 */

export type PacingMode = "linear" | "step";
export type SaiasuiPreset = "relaxed" | "default" | "fast" | "brutal" | "custom";
export type TargetBodyStyle = "filled" | "hollow";
export type TargetColorMode = "highlight" | "mono";

export interface SaiasuiConfig {
  version: number;
  preset: SaiasuiPreset;
  // Gameplay
  enabled: boolean;
  pacing: PacingMode;
  initialInterval: number;
  minInterval: number;
  accelRate: number;
  stepAmount: number;
  targetLifetime: number;
  runDuration: number;
  hpActivateHits: number;
  startHp: number;
  maxHp: number;
  hpDrain: number;
  missDamage: number;
  blankMiss: boolean;
  blankDamage: number;
  targetMissDamage: boolean;
  comboResetOnMiss: boolean;
  gameOverHp: number;
  // Targets
  targetSize: number;
  sizeVariation: number;
  ringSize: number;
  ringDuration: number;
  movementEnabled: boolean;
  movementSpeed: number;
  movementAmount: number;
  tinyEnabled: boolean;
  tinyFrequency: number;
  tinySize: number;
  tinyHeal: number;
  // Visuals
  bodyStyle: TargetBodyStyle;
  colorMode: TargetColorMode;
  targetOutline: boolean;
  ringVisible: boolean;
  ringThickness: number;
  targetOpacity: number;
  animIntensity: number;
  hitFeedback: boolean;
  missFeedback: boolean;
  hudVisible: boolean;
  showHp: boolean;
  showScore: boolean;
  showCombo: boolean;
  showGrade: boolean;
  // Events
  slowEnabled: boolean;
  slowDuration: number;
  slowStrength: number;
  godEnabled: boolean;
  godDuration: number;
  fullEnabled: boolean;
  movingEventEnabled: boolean;
  eventIntervalMin: number;
  eventIntervalMax: number;
  // Audio
  audioEnabled: boolean;
  volume: number;
  hitSound: boolean;
  missSound: boolean;
  eventSound: boolean;
  gameOverSound: boolean;
}

export const SAIASUI_CONFIG_VERSION = 2;

export const SAIASUI_DEFAULTS: SaiasuiConfig = {
  version: SAIASUI_CONFIG_VERSION,
  preset: "default",
  enabled: true,
  pacing: "linear",
  initialInterval: 2.8,
  minInterval: 0.65,
  accelRate: 0.0014,
  stepAmount: 0.13,
  targetLifetime: 1.55,
  runDuration: 0,
  hpActivateHits: 50,
  startHp: 100,
  maxHp: 100,
  hpDrain: 1.5,
  missDamage: 6,
  blankMiss: true,
  blankDamage: 2,
  targetMissDamage: true,
  comboResetOnMiss: true,
  gameOverHp: 0,
  targetSize: 34,
  sizeVariation: 0,
  ringSize: 4,
  ringDuration: 28,
  movementEnabled: true,
  movementSpeed: 1.3,
  movementAmount: 0.045,
  tinyEnabled: true,
  tinyFrequency: 0.5,
  tinySize: 12,
  tinyHeal: 18,
  bodyStyle: "filled",
  colorMode: "highlight",
  targetOutline: true,
  ringVisible: true,
  ringThickness: 2,
  targetOpacity: 1,
  animIntensity: 1,
  hitFeedback: true,
  missFeedback: true,
  hudVisible: true,
  showHp: true,
  showScore: true,
  showCombo: true,
  showGrade: true,
  slowEnabled: true,
  slowDuration: 3,
  slowStrength: 0.5,
  godEnabled: true,
  godDuration: 3,
  fullEnabled: true,
  movingEventEnabled: true,
  eventIntervalMin: 8,
  eventIntervalMax: 15,
  audioEnabled: true,
  volume: 100,
  hitSound: true,
  missSound: true,
  eventSound: true,
  gameOverSound: true,
};

/** [min, max, step] for every numeric field; also the clamp bounds on read. */
export const SAIASUI_LIMITS = {
  initialInterval: [0.6, 5, 0.05],
  minInterval: [0.2, 3, 0.05],
  accelRate: [0, 0.02, 0.0002],
  stepAmount: [0, 1, 0.01],
  targetLifetime: [1.1, 3, 0.05],
  runDuration: [0, 3600, 30],
  hpActivateHits: [0, 500, 1],
  startHp: [1, 500, 1],
  maxHp: [1, 500, 1],
  hpDrain: [0, 10, 0.1],
  missDamage: [0, 100, 1],
  blankDamage: [0, 100, 1],
  gameOverHp: [0, 90, 1],
  targetSize: [12, 80, 1],
  sizeVariation: [0, 0.6, 0.02],
  ringSize: [0, 40, 1],
  ringDuration: [0, 80, 1],
  movementSpeed: [0, 5, 0.1],
  movementAmount: [0, 0.2, 0.005],
  tinyFrequency: [0, 1, 0.05],
  tinySize: [6, 40, 1],
  tinyHeal: [0, 100, 1],
  ringThickness: [0.5, 8, 0.5],
  targetOpacity: [0.2, 1, 0.05],
  animIntensity: [0, 2, 0.1],
  slowDuration: [0.5, 15, 0.5],
  slowStrength: [0.1, 1, 0.05],
  godDuration: [0.5, 15, 0.5],
  eventIntervalMin: [1, 60, 1],
  eventIntervalMax: [1, 80, 1],
  volume: [0, 100, 1],
} as const satisfies Record<string, readonly [number, number, number]>;

export type SaiasuiNumericKey = keyof typeof SAIASUI_LIMITS;

/**
 * Fields whose change alters run difficulty/scoring. Editing any of these
 * during an active run taints it (non-record-eligible); the rest apply live.
 */
export const SAIASUI_SCORE_KEYS = new Set<keyof SaiasuiConfig>([
  "pacing",
  "initialInterval",
  "minInterval",
  "accelRate",
  "stepAmount",
  "targetLifetime",
  "runDuration",
  "hpActivateHits",
  "startHp",
  "maxHp",
  "hpDrain",
  "missDamage",
  "blankMiss",
  "blankDamage",
  "targetMissDamage",
  "comboResetOnMiss",
  "gameOverHp",
  "targetSize",
  "sizeVariation",
  "movementEnabled",
  "movementSpeed",
  "movementAmount",
  "tinyEnabled",
  "tinyFrequency",
  "tinySize",
  "tinyHeal",
  "slowEnabled",
  "slowDuration",
  "slowStrength",
  "godEnabled",
  "godDuration",
  "fullEnabled",
  "movingEventEnabled",
  "eventIntervalMin",
  "eventIntervalMax",
]);

/** Preset deltas over the shipped defaults; "custom" and "default" carry none. */
export const SAIASUI_PRESETS: Record<Exclude<SaiasuiPreset, "custom" | "default">, Partial<SaiasuiConfig>> = {
  relaxed: {
    initialInterval: 3.4,
    minInterval: 1.1,
    accelRate: 0.0008,
    stepAmount: 0.08,
    hpDrain: 1,
    missDamage: 4,
    blankDamage: 1,
    godDuration: 4,
  },
  fast: {
    initialInterval: 2.2,
    minInterval: 0.5,
    accelRate: 0.0022,
    stepAmount: 0.18,
    hpDrain: 2,
    missDamage: 8,
  },
  brutal: {
    initialInterval: 1.7,
    minInterval: 0.35,
    accelRate: 0.0032,
    stepAmount: 0.26,
    hpDrain: 3,
    missDamage: 12,
    blankDamage: 5,
    targetLifetime: 1.35,
  },
};

/** The full config a named preset produces (defaults + its deltas). */
export function saiasuiPresetConfig(preset: Exclude<SaiasuiPreset, "custom">): SaiasuiConfig {
  const delta = preset === "default" ? {} : SAIASUI_PRESETS[preset];
  return { ...SAIASUI_DEFAULTS, ...delta, preset, version: SAIASUI_CONFIG_VERSION };
}

function clampNum(value: unknown, key: SaiasuiNumericKey): number {
  const [min, max] = SAIASUI_LIMITS[key];
  const fallback = SAIASUI_DEFAULTS[key] as number;
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function oneOf<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return options.includes(value as T) ? (value as T) : fallback;
}

/**
 * A stored blob (any version, malformed, or partial) -> a render-safe config.
 * Every numeric field clamps to its limit, enums repair to the safe default,
 * and eventIntervalMax is never below eventIntervalMin. Older single-field
 * settings ({enabled, sound, pacing}) migrate: their sound flag becomes
 * audioEnabled, pacing carries over, everything else takes the shipped default.
 */
export function normalizeSaiasuiConfig(raw: unknown): SaiasuiConfig {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const d = SAIASUI_DEFAULTS;
  // v1 migration: the legacy `sound` boolean is today's audioEnabled.
  const legacySound = typeof r.sound === "boolean" ? r.sound : undefined;
  const num = (key: SaiasuiNumericKey) => clampNum(r[key], key);
  const eMin = num("eventIntervalMin");
  const preset = oneOf<SaiasuiPreset>(
    r.preset,
    ["relaxed", "default", "fast", "brutal", "custom"],
    "default",
  );
  return {
    version: SAIASUI_CONFIG_VERSION,
    preset,
    enabled: flag(r.enabled, d.enabled),
    pacing: r.pacing === "step" ? "step" : "linear",
    initialInterval: num("initialInterval"),
    minInterval: num("minInterval"),
    accelRate: num("accelRate"),
    stepAmount: num("stepAmount"),
    targetLifetime: num("targetLifetime"),
    runDuration: num("runDuration"),
    hpActivateHits: Math.round(num("hpActivateHits")),
    startHp: num("startHp"),
    maxHp: num("maxHp"),
    hpDrain: num("hpDrain"),
    missDamage: num("missDamage"),
    blankMiss: flag(r.blankMiss, d.blankMiss),
    blankDamage: num("blankDamage"),
    targetMissDamage: flag(r.targetMissDamage, d.targetMissDamage),
    comboResetOnMiss: flag(r.comboResetOnMiss, d.comboResetOnMiss),
    gameOverHp: num("gameOverHp"),
    targetSize: num("targetSize"),
    sizeVariation: num("sizeVariation"),
    ringSize: num("ringSize"),
    ringDuration: num("ringDuration"),
    movementEnabled: flag(r.movementEnabled, d.movementEnabled),
    movementSpeed: num("movementSpeed"),
    movementAmount: num("movementAmount"),
    tinyEnabled: flag(r.tinyEnabled, d.tinyEnabled),
    tinyFrequency: num("tinyFrequency"),
    tinySize: num("tinySize"),
    tinyHeal: num("tinyHeal"),
    bodyStyle: oneOf(r.bodyStyle, ["filled", "hollow"] as const, d.bodyStyle),
    colorMode: oneOf(r.colorMode, ["highlight", "mono"] as const, d.colorMode),
    targetOutline: flag(r.targetOutline, d.targetOutline),
    ringVisible: flag(r.ringVisible, d.ringVisible),
    ringThickness: num("ringThickness"),
    targetOpacity: num("targetOpacity"),
    animIntensity: num("animIntensity"),
    hitFeedback: flag(r.hitFeedback, d.hitFeedback),
    missFeedback: flag(r.missFeedback, d.missFeedback),
    hudVisible: flag(r.hudVisible, d.hudVisible),
    showHp: flag(r.showHp, d.showHp),
    showScore: flag(r.showScore, d.showScore),
    showCombo: flag(r.showCombo, d.showCombo),
    showGrade: flag(r.showGrade, d.showGrade),
    slowEnabled: flag(r.slowEnabled, d.slowEnabled),
    slowDuration: num("slowDuration"),
    slowStrength: num("slowStrength"),
    godEnabled: flag(r.godEnabled, d.godEnabled),
    godDuration: num("godDuration"),
    fullEnabled: flag(r.fullEnabled, d.fullEnabled),
    movingEventEnabled: flag(r.movingEventEnabled, d.movingEventEnabled),
    eventIntervalMin: eMin,
    eventIntervalMax: Math.max(eMin, num("eventIntervalMax")),
    audioEnabled: flag(r.audioEnabled, legacySound ?? d.audioEnabled),
    volume: num("volume"),
    hitSound: flag(r.hitSound, d.hitSound),
    missSound: flag(r.missSound, d.missSound),
    eventSound: flag(r.eventSound, d.eventSound),
    gameOverSound: flag(r.gameOverSound, d.gameOverSound),
  };
}

/** Which named preset (if any) a config currently matches, ignoring `preset`/`version`. */
export function detectSaiasuiPreset(config: SaiasuiConfig): SaiasuiPreset {
  for (const name of ["default", "relaxed", "fast", "brutal"] as const) {
    const candidate = saiasuiPresetConfig(name);
    const same = (Object.keys(SAIASUI_DEFAULTS) as (keyof SaiasuiConfig)[]).every(
      (key) => key === "preset" || key === "version" || config[key] === candidate[key],
    );
    if (same) return name;
  }
  return "custom";
}
