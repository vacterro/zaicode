/**
 * SAIPEGGLE (SRC-062): a Peggle Deluxe style game inside ZAICODE. "Full
 * playable pixel game, no anti-aliasing: a cannon shoots balls at pegs, great
 * physics, a levels system, score, sounds, a randomizer, a seed, level
 * config" -- and, after the operator pointed at Peggle Deluxe on Steam, its
 * structure: an adventure of 11 stages x 5 levels, a master (power) per stage,
 * Quick Play, Extreme Fever. Everything is original: no PopCap art, names or
 * sounds; only the rules of the genre.
 *
 * World units are the game's own pixels: a 320 x 240 screen drawn at an
 * integer scale with nearest-neighbour pixels.
 */

export const SPG_W = 320;
export const SPG_H = 240;

/** The play field between the two side panels. */
export const SPG_BOARD = { left: 48, right: 272, top: 14, bottom: 240 } as const;
export const SPG_CANNON = { x: 160, y: 20, barrel: 15 } as const;
export const SPG_BALL_R = 3;
export const SPG_PEG_R = 4;
/** Bricks are capsules: a segment of this half length with this radius. */
export const SPG_BRICK_HALF = 5;
export const SPG_BRICK_R = 2.5;
export const SPG_BUCKET_Y = 229;
export const SPG_BUCKET_HALF = 13;
/** Pegs are placed inside this box (the bucket lane stays clear). */
export const SPG_PEG_AREA = { left: 56, right: 264, top: 44, bottom: 212 } as const;

export const SPG_GRAVITY = 175;
export const SPG_LAUNCH_SPEED = 185;
export const SPG_MAX_SPEED = 380;
/** Physics substep: 240 Hz keeps a fast ball from tunnelling through a peg. */
export const SPG_STEP = 1 / 240;
export const SPG_AIM_LIMIT = (86 * Math.PI) / 180;

export type SpgPegKind = "blue" | "orange" | "green" | "purple";
export type SpgPegShape = "round" | "brick";

export interface SpgPeg {
  id: number;
  x: number;
  y: number;
  shape: SpgPegShape;
  /** Brick direction in radians (0 = horizontal). */
  angle: number;
  kind: SpgPegKind;
  lit: boolean;
  gone: boolean;
}

export const SPG_POWERS = ["guide", "multiball", "pyramid", "blast", "spooky", "fireball", "zen", "lucky"] as const;
export type SpgPower = (typeof SPG_POWERS)[number];

export const SPG_POWER_INFO: Record<SpgPower, { name: string; short: string; master: string; text: string }> = {
  guide: { name: "Super Guide", short: "GUIDE", master: "Owl Oskar", text: "The next shots show the whole path, bounces included." },
  multiball: { name: "Multiball", short: "MULTI", master: "Volt", text: "A second ball splits off the green peg." },
  pyramid: { name: "Pyramid", short: "PYRAMID", master: "Sphinx Nefa", text: "The bucket grows wide for three turns." },
  blast: { name: "Space Blast", short: "BLAST", master: "Zorb", text: "Every peg near the green peg lights up at once." },
  spooky: { name: "Spooky Ball", short: "SPOOKY", master: "Count Batly", text: "The ball falls out of the bottom and drops in again from the top." },
  fireball: { name: "Fireball", short: "FIRE", master: "Dragon Emberwing", text: "The ball burns through pegs without bouncing for a while." },
  zen: { name: "Zen Ball", short: "ZEN", master: "Sensei Koi", text: "The shot nudges itself onto the best path it can find." },
  lucky: { name: "Lucky Spin", short: "LUCKY", master: "Raccoon Fortuna", text: "Spins for one of the other powers." },
};

export interface SaipeggleSettings {
  /** palette: the ZAICODE palette in use; classic: the genre's own blue / orange / green / purple. */
  colors: "palette" | "classic";
  /** "stage": the stage's master; otherwise one power everywhere. */
  power: "stage" | SpgPower;
  aimGuide: boolean;
  balls: number;
  orange: number;
  green: number;
  purple: boolean;
  gravity: number;
  bounce: number;
  bucketSpeed: number;
  density: number;
  /** Random levels: "" = a new seed every time. */
  seed: string;
  fever: boolean;
  slowMo: boolean;
  feverMusic: boolean;
  particles: boolean;
  shake: boolean;
  /** 0 = the biggest integer scale that fits. */
  scale: number;
}

export const SAIPEGGLE_LIMITS = {
  balls: [3, 30],
  orange: [5, 40],
  green: [0, 4],
  gravity: [0.5, 1.6],
  bounce: [0.5, 0.95],
  bucketSpeed: [0, 2.5],
  density: [0.5, 1.6],
  scale: [0, 8],
} as const;

export function saipeggleDefaults(): SaipeggleSettings {
  return {
    colors: "palette",
    power: "stage",
    aimGuide: true,
    balls: 10,
    orange: 25,
    green: 2,
    purple: true,
    gravity: 1,
    bounce: 0.78,
    bucketSpeed: 1,
    density: 1,
    seed: "",
    fever: true,
    slowMo: true,
    feverMusic: true,
    particles: true,
    shake: true,
    scale: 0,
  };
}

function num(value: unknown, [min, max]: readonly [number, number], fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

export function normalizeSaipeggleSettings(raw: unknown): SaipeggleSettings {
  const d = saipeggleDefaults();
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const flag = (key: keyof SaipeggleSettings) => (typeof r[key] === "boolean" ? (r[key] as boolean) : (d[key] as boolean));
  const L = SAIPEGGLE_LIMITS;
  return {
    colors: r.colors === "classic" ? "classic" : "palette",
    power: SPG_POWERS.includes(r.power as SpgPower) ? (r.power as SpgPower) : "stage",
    aimGuide: flag("aimGuide"),
    balls: Math.round(num(r.balls, L.balls, d.balls)),
    orange: Math.round(num(r.orange, L.orange, d.orange)),
    green: Math.round(num(r.green, L.green, d.green)),
    purple: flag("purple"),
    gravity: num(r.gravity, L.gravity, d.gravity),
    bounce: num(r.bounce, L.bounce, d.bounce),
    bucketSpeed: num(r.bucketSpeed, L.bucketSpeed, d.bucketSpeed),
    density: num(r.density, L.density, d.density),
    seed: typeof r.seed === "string" ? r.seed.trim().toUpperCase().slice(0, 32) : d.seed,
    fever: flag("fever"),
    slowMo: flag("slowMo"),
    feverMusic: flag("feverMusic"),
    particles: flag("particles"),
    shake: flag("shake"),
    scale: Math.round(num(r.scale, L.scale, d.scale)),
  };
}

/** Base points per peg kind (the genre's table). */
export const SPG_PEG_POINTS: Record<SpgPegKind, number> = { blue: 10, orange: 100, green: 10, purple: 500 };

/** The fever multiplier after `hit` of `total` orange pegs: x2 / x3 / x5 / x10 at 40 / 60 / 76 / 88 %. */
export function saipeggleMultiplier(hit: number, total: number): number {
  if (total <= 0) return 1;
  const share = hit / total;
  if (share >= 0.88) return 10;
  if (share >= 0.76) return 5;
  if (share >= 0.6) return 3;
  if (share >= 0.4) return 2;
  return 1;
}

/** Orange counts at which the multiplier steps up (for the meter's marks). */
export function saipeggleMultiplierMarks(total: number): { at: number; multiplier: number }[] {
  return [0.4, 0.6, 0.76, 0.88].map((share, index) => ({ at: Math.ceil(share * total - 1e-9), multiplier: [2, 3, 5, 10][index]! }));
}

/** One free ball per shot score threshold passed. */
export const SPG_FREE_BALL_SCORES = [25_000, 75_000, 125_000] as const;
export const SPG_FEVER_BUCKETS = [10_000, 50_000, 100_000, 50_000, 10_000] as const;
export const SPG_BALL_BONUS = 10_000;
export const SPG_LONG_SHOT = 25_000;
