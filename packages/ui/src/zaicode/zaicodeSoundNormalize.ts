import {
  analyzeZaicodeSoundPcm,
  planZaicodeNormalization,
  zaicodeSoundContentHash,
  ZaicodeAnalysisCache,
  ZAICODE_NORMALIZE_ATTENUATION_CAP_DEFAULT,
  normalizeZaicodeAttenuationCap,
  type ZaicodeNormalizeInput,
  type ZaicodeNormalizePlan,
  type ZaicodeNormalizeProfileId,
  type ZaicodeSoundAnalysis,
} from "./zaicodeSoundAnalysis.js";
import {
  normalizeZaicodeSoundSettings,
  readZaicodeSoundSettings,
  setZaicodeSoundSettings,
  zaicodeEffectiveGainDb,
  type ZaicodeSoundSettings,
} from "./zaicodeSoundSettingsModel.js";

/**
 * The "Normalize configured sounds" action (Wave 3, part A).
 *
 * The pass is deliberately dull about failure and careful about effect: one
 * undecodable file is reported and skipped rather than aborting the run, the
 * work is sliced so a large configured set cannot freeze the window, and the
 * result lands in ONE write, so there is no moment where half the table is
 * normalized and half is not.
 *
 * Nothing here touches an audio file. What it writes is a per-event dB number
 * applied on top of the operator's own gain, which is what makes Undo exact.
 */

const CACHE_KEY = "zaicode-sound-analysis-v1";

export interface ZaicodeNormalizeTarget {
  eventId: string;
  sound: string;
}

/** Every sound the operator has actually configured, pool members included. */
export function collectZaicodeNormalizeTargets(settings: ZaicodeSoundSettings): ZaicodeNormalizeTarget[] {
  const targets: ZaicodeNormalizeTarget[] = [];
  for (const [eventId, row] of Object.entries(settings.events)) {
    if (!row.enabled) continue;
    for (const sound of new Set([row.sound, ...row.pool.filter((entry) => !entry.missing).map((entry) => entry.id)])) {
      if (sound && sound !== "default") targets.push({ eventId, sound });
    }
  }
  return targets;
}

export interface ZaicodeDecodedSound {
  samples: Float32Array;
  sampleRate: number;
}

export interface ZaicodeNormalizePassResult {
  inputs: ZaicodeNormalizeInput[];
  /** eventId -> sound that could not be decoded or measured. */
  failed: { eventId: string; sound: string; reason: string }[];
  /** Measurements served from the content-hash cache. */
  cached: number;
  measured: number;
}

/**
 * Analyse every target. `decode` and `yield` are injected so the whole pass is
 * testable without an AudioContext, and so a caller can swap in an idle
 * scheduler: the default yields to the event loop between files, which is
 * what keeps a hundred-file table from blocking a click.
 */
export async function runZaicodeNormalizePass(
  targets: readonly ZaicodeNormalizeTarget[],
  options: {
    decode: (sound: string) => Promise<ZaicodeDecodedSound | null>;
    cache?: ZaicodeAnalysisCache;
    fetchBytes?: (sound: string) => Promise<ArrayBuffer | null>;
    yieldTo?: () => Promise<void>;
    now?: () => number;
    onProgress?: (done: number, total: number) => void;
  },
): Promise<ZaicodeNormalizePassResult> {
  const now = options.now ?? (() => Date.now());
  const yieldTo = options.yieldTo ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  const inputs: ZaicodeNormalizeInput[] = [];
  const failed: ZaicodeNormalizePassResult["failed"] = [];
  let cached = 0;
  let done = 0;

  for (const target of targets) {
    // Hand the thread back between files: analysis is fast, decoding is not.
    await yieldTo();
    done += 1;
    try {
      const key = await contentKey(target.sound, options.fetchBytes);
      const hit = key ? options.cache?.get(key) : null;
      if (hit) {
        cached += 1;
        inputs.push({ id: target.eventId, analysis: hit });
        options.onProgress?.(done, targets.length);
        continue;
      }
      const decoded = await options.decode(target.sound);
      if (!decoded) {
        failed.push({ eventId: target.eventId, sound: target.sound, reason: "could not be decoded" });
        options.onProgress?.(done, targets.length);
        continue;
      }
      const analysis = analyzeZaicodeSoundPcm(decoded.samples, decoded.sampleRate);
      if (key) options.cache?.put(key, analysis, now());
      inputs.push({ id: target.eventId, analysis });
      options.onProgress?.(done, targets.length);
    } catch (error) {
      failed.push({ eventId: target.eventId, sound: target.sound, reason: error instanceof Error ? error.message : String(error) });
      options.onProgress?.(done, targets.length);
    }
  }
  return { inputs, failed, cached, measured: inputs.length - cached };
}

async function contentKey(sound: string, fetchBytes?: (sound: string) => Promise<ArrayBuffer | null>): Promise<string | null> {
  if (!fetchBytes) return null;
  try {
    const bytes = await fetchBytes(sound);
    if (!bytes) return null;
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

/** Persist the measurements so reopening Settings does not decode everything again. */
export function readZaicodeAnalysisCache(): ZaicodeAnalysisCache {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return new ZaicodeAnalysisCache(raw ? (JSON.parse(raw) as never) : []);
  } catch {
    return new ZaicodeAnalysisCache();
  }
}

export function writeZaicodeAnalysisCache(cache: ZaicodeAnalysisCache, now: number): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache.serialize(now)));
  } catch {
    // A cache that cannot be written only costs a re-measure next time.
  }
}

/**
 * Apply a plan in one write. An event whose sound is loud in several rows
 * takes the STRONGEST correction among them, because compensation is added to
 * one gain per event: two events sharing a file must not double-apply it.
 */
export function applyZaicodeNormalization(plan: ZaicodeNormalizePlan, settings = readZaicodeSoundSettings()): ZaicodeSoundSettings {
  const strongest = new Map<string, number>();
  for (const row of plan.rows) {
    if (!row.measured || row.gainDb === 0) continue;
    // A NEGATIVE correction is a real correction: flooring the accumulator at
    // zero would silently drop every loud sound the pass was meant to pull down.
    const seen = strongest.get(row.id);
    strongest.set(row.id, seen === undefined ? row.gainDb : Math.max(seen, row.gainDb));
  }
  const events = Object.fromEntries(
    Object.entries(settings.events).map(([id, row]) => [id, { ...row, normalizeDb: strongest.get(id) ?? 0 }]),
  );
  return normalizeZaicodeSoundSettings({ ...settings, events });
}

export function commitZaicodeSoundSettings(settings: ZaicodeSoundSettings): void {
  setZaicodeSoundSettings(settings);
}

/** Undo: drop every automatic compensation. Sound choices and manual gains stay. */
export function undoZaicodeNormalization(settings = readZaicodeSoundSettings()): ZaicodeSoundSettings {
  const events = Object.fromEntries(Object.entries(settings.events).map(([id, row]) => [id, { ...row, normalizeDb: 0 }]));
  return normalizeZaicodeSoundSettings({ ...settings, events });
}

/** What the operator is about to hear, for the preview table. */
export function zaicodeEffectiveGainAfter(row: { gainDb: number; normalizeDb: number }, plannedDb: number): number {
  return zaicodeEffectiveGainDb({ gainDb: row.gainDb, normalizeDb: row.normalizeDb }) - row.normalizeDb + plannedDb;
}

export function zaicodeNormalizeOptions(profile: ZaicodeNormalizeProfileId, cap: number) {
  return { profile, attenuationCapDb: normalizeZaicodeAttenuationCap(cap) };
}

export { ZAICODE_NORMALIZE_ATTENUATION_CAP_DEFAULT };
