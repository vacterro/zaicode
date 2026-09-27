import {
  SPG_BRICK_HALF,
  SPG_PEG_AREA,
  SPG_POWERS,
  type SaipeggleSettings,
  type SpgPeg,
  type SpgPower,
} from "./saipeggleModel.js";
import { saipegglePlaces, type SpgPlace } from "./saipegglePatterns.js";
import { saipeggleRng } from "./saipeggleRandom.js";
import { SPG_TEMPLATES, saipeggleTemplate } from "./saipeggleTemplates.js";

/**
 * SAIPEGGLE levels. The adventure is 11 stages of 5 levels; each stage
 * belongs to a master whose power the green pegs give. A level is a seed and
 * a board design: the same seed always builds the same board. Which pegs are
 * orange and green is dealt again on every attempt (the genre's rule), from
 * the seed and the attempt number, so a retry is fresh but reproducible.
 */

export interface SpgStage {
  index: number;
  name: string;
  power: SpgPower;
}

export const SPG_STAGES: readonly SpgStage[] = [
  { index: 1, name: "Owl Grove", power: "guide" },
  { index: 2, name: "Volt Works", power: "multiball" },
  { index: 3, name: "Sand Tomb", power: "pyramid" },
  { index: 4, name: "Orbit", power: "blast" },
  { index: 5, name: "Moon Manor", power: "spooky" },
  { index: 6, name: "Fortune Alley", power: "lucky" },
  { index: 7, name: "Dragon Peak", power: "fireball" },
  { index: 8, name: "Koi Garden", power: "zen" },
  { index: 9, name: "Storm Front", power: "multiball" },
  { index: 10, name: "Ember Deep", power: "fireball" },
  { index: 11, name: "Masters' Trial", power: "lucky" },
];

export const SPG_LEVELS_PER_STAGE = 5;

export interface SpgLevelSpec {
  /** "3-2" for the adventure, "R:<seed>" for a random level, "C:<code hash>" for an imported one. */
  id: string;
  name: string;
  seed: string;
  template: string;
  /** 1-based adventure stage, null outside the adventure. */
  stage: number | null;
  power: SpgPower;
  /** A shared board: exact places instead of the template. */
  places?: SpgPlace[];
}

const ROMAN = ["", " II", " III"];

/** The 55 adventure levels, in order. */
export function saipeggleCampaign(): SpgLevelSpec[] {
  const order = saipeggleRng("SAIPEGGLE-ADVENTURE").shuffle(SPG_TEMPLATES.map((template) => template.id));
  const specs: SpgLevelSpec[] = [];
  for (const stage of SPG_STAGES) {
    for (let level = 1; level <= SPG_LEVELS_PER_STAGE; level += 1) {
      const index = specs.length;
      const template = saipeggleTemplate(order[index % order.length]!)!;
      specs.push({
        id: `${stage.index}-${level}`,
        name: `${template.name}${ROMAN[Math.floor(index / order.length)] ?? ""}`,
        seed: `ADV-${stage.index}-${level}`,
        template: template.id,
        stage: stage.index,
        power: stage.power,
      });
    }
  }
  return specs;
}

/** A random level from `seed` (any text). */
export function saipeggleRandomSpec(seed: string): SpgLevelSpec {
  const rng = saipeggleRng(`RANDOM/${seed}`);
  const template = rng.pick(SPG_TEMPLATES);
  return { id: `R:${seed}`, name: `${template.name} · ${seed}`, seed, template: template.id, stage: null, power: rng.pick(SPG_POWERS) };
}

const MARGIN = 5;

function inside(p: SpgPlace): boolean {
  const reach = p.shape === "brick" ? SPG_BRICK_HALF : 0;
  return (
    p.x >= SPG_PEG_AREA.left + reach - MARGIN &&
    p.x <= SPG_PEG_AREA.right - reach + MARGIN &&
    p.y >= SPG_PEG_AREA.top - MARGIN &&
    p.y <= SPG_PEG_AREA.bottom + MARGIN
  );
}

function gap(a: SpgPlace, b: SpgPlace): number {
  return a.shape === "round" && b.shape === "round" ? 10 : 11.5;
}

/** The board's peg places: the template's patterns, kept inside the field, overlaps removed. */
export function saipeggleLayout(spec: SpgLevelSpec, density: number): SpgPlace[] {
  const raw = spec.places ?? (() => {
    const rng = saipeggleRng(`${spec.seed}/layout`);
    const template = saipeggleTemplate(spec.template) ?? SPG_TEMPLATES[0]!;
    return template.build(rng, density).flatMap((pattern) => saipegglePlaces(pattern, rng));
  })();
  const kept: SpgPlace[] = [];
  for (const p of raw) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !inside(p)) continue;
    if (kept.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < gap(p, q))) continue;
    kept.push({ x: Math.round(p.x * 2) / 2, y: Math.round(p.y * 2) / 2, shape: p.shape, angle: p.angle });
    if (kept.length >= 180) break;
  }
  return kept;
}

/** The pegs for one attempt: orange and green dealt from the seed and the attempt. */
export function saipeggleDeal(places: readonly SpgPlace[], spec: SpgLevelSpec, settings: Pick<SaipeggleSettings, "orange" | "green">, attempt: number): SpgPeg[] {
  const pegs: SpgPeg[] = places.map((p, id) => ({ id, x: p.x, y: p.y, shape: p.shape, angle: p.angle, kind: "blue", lit: false, gone: false }));
  const rng = saipeggleRng(`${spec.seed}/deal/${attempt}`);
  const order = rng.shuffle(pegs.map((peg) => peg.id));
  const orange = Math.min(settings.orange, Math.floor(pegs.length * 0.45));
  const green = Math.max(0, Math.min(settings.green, pegs.length - orange - 1));
  order.slice(0, orange).forEach((id) => (pegs[id]!.kind = "orange"));
  order.slice(orange, orange + green).forEach((id) => (pegs[id]!.kind = "green"));
  return pegs;
}

// ---- Level codes: a board anyone can paste in (Settings -> Levels -> Paste code).

const CODE_PREFIX = "SPG1.";

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  bytes.forEach((byte) => (binary += String.fromCharCode(byte)));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(code: string): string {
  const binary = atob(code.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

export function saipeggleLevelCode(spec: SpgLevelSpec, places: readonly SpgPlace[]): string {
  const data = {
    n: spec.name.slice(0, 40),
    s: spec.seed,
    w: spec.power,
    p: places.map((p) => [p.x, p.y, p.shape === "brick" ? Math.round((p.angle * 180) / Math.PI) : null]),
  };
  return CODE_PREFIX + toBase64Url(JSON.stringify(data));
}

/** A pasted code -> a level, or null when it is not a SAIPEGGLE code. */
export function saipeggleParseLevelCode(code: string): SpgLevelSpec | null {
  const text = code.trim();
  if (!text.startsWith(CODE_PREFIX)) return null;
  try {
    const data = JSON.parse(fromBase64Url(text.slice(CODE_PREFIX.length))) as { n?: unknown; s?: unknown; w?: unknown; p?: unknown };
    if (!Array.isArray(data.p) || data.p.length === 0 || data.p.length > 300) return null;
    const places: SpgPlace[] = [];
    for (const item of data.p) {
      if (!Array.isArray(item)) return null;
      const [x, y, angle] = item as unknown[];
      if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return null;
      const brick = typeof angle === "number" && Number.isFinite(angle);
      places.push({ x, y, shape: brick ? "brick" : "round", angle: brick ? (angle * Math.PI) / 180 : 0 });
    }
    const seed = typeof data.s === "string" && data.s ? data.s.slice(0, 32) : "SHARED";
    const name = typeof data.n === "string" && data.n ? data.n.slice(0, 40) : "Shared board";
    const power = SPG_POWERS.includes(data.w as SpgPower) ? (data.w as SpgPower) : "guide";
    return { id: `C:${seed}:${places.length}`, name, seed, template: "code", stage: null, power, places };
  } catch {
    return null;
  }
}
