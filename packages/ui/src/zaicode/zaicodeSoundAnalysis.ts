/**
 * Loudness analysis and normalization for the sounds the operator has
 * configured (Wave 3, part A).
 *
 * Two rules shape everything here. First, NOTHING about a source file is
 * rewritten: analysis produces numbers, and the numbers become a per-event
 * compensation applied at playback, so Reset is always exact. Second, the
 * measurement is not a peak: a 3 dB peak tells you nothing about how loud a
 * sound feels, and normalizing to peaks would turn a click into a roar.
 *
 * The estimator is the ITU-R BS.1770 shape (gated mean square, absolute gate
 * at -70 dBFS then a relative gate 10 dB below the ungated level), which is a
 * good approximation for the short UI sounds this is aimed at. It is not a
 * certified LUFS meter: mono, no K-weighting curve. A separate peak guard
 * runs on every proposal, because boosting is the only way normalization can
 * hurt anybody's ears.
 */

/** Absolute gate, BS.1770. Below this a block is silence or noise floor. */
const ABSOLUTE_GATE_DB = -70;
/** Relative gate: 10 dB below the ungated mean square, so one loud block cannot set the level. */
const RELATIVE_GATE_DB = -10;
/**
 * Ceiling for the peak AFTER gain. -1 dBFS rather than 0: a lossy file's
 * decoded samples can sit above the true inter-sample peak the codec wrote,
 * so a 0 dBFS ceiling still clips on some hardware.
 */
export const ZAICODE_PEAK_CEILING_DB = -1;

/** Gating block: 400 ms like BS.1770, or the whole clip when it is shorter. */
const BLOCK_SECONDS = 0.4;

export interface ZaicodeSoundAnalysis {
  /** Gated mean-square level in dBFS. */
  loudnessDb: number;
  /** Highest absolute sample, in dBFS (0 for digital silence). */
  peakDb: number;
  /** False when the absolute gate removed everything: nothing measured. */
  measured: boolean;
  /** Blocks the relative gate kept, over blocks the absolute gate kept. */
  keptBlocks: number;
  blocks: number;
}

/** Mean square -> dB (BS.1770 works on power). */
function toDb(value: number): number {
  return value > 0 ? 10 * Math.log10(value) : -Infinity;
}

/** An AMPLITUDE -> dBFS. A peak is an amplitude, so it is 20*log10, not 10*log10. */
function amplitudeToDb(value: number): number {
  return value > 0 ? 20 * Math.log10(value) : -Infinity;
}

/**
 * Gated mean square over a decoded buffer. Pure and synchronous: the caller
 * decides when to run it, which is how the settings screen keeps a large
 * configured set off the main thread.
 */
export function analyzeZaicodeSoundPcm(samples: Float32Array, sampleRate: number): ZaicodeSoundAnalysis {
  const empty: ZaicodeSoundAnalysis = { loudnessDb: -Infinity, peakDb: -Infinity, measured: false, keptBlocks: 0, blocks: 0 };
  if (!samples || samples.length === 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) return empty;

  let peak = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.abs(samples[index]!);
    if (value > peak) peak = value;
  }
  const blockSize = Math.max(1, Math.min(samples.length, Math.round(sampleRate * BLOCK_SECONDS)));
  const blockCount = Math.ceil(samples.length / blockSize);

  const sums: number[] = [];
  for (let block = 0; block < blockCount; block += 1) {
    const start = block * blockSize;
    const end = Math.min(samples.length, start + blockSize);
    let sum = 0;
    for (let index = start; index < end; index += 1) sum += samples[index]! * samples[index]!;
    sums.push(sum / Math.max(1, end - start));
  }

  // Absolute gate first: a block below it is not part of the level at all.
  const absolute = 10 ** (ABSOLUTE_GATE_DB / 10);
  const aboveAbsolute = sums.filter((value) => value > absolute);
  if (aboveAbsolute.length === 0) {
    return { loudnessDb: -Infinity, peakDb: amplitudeToDb(peak), measured: false, keptBlocks: 0, blocks: blockCount };
  }
  const ungated = aboveAbsolute.reduce((total, value) => total + value, 0) / aboveAbsolute.length;

  // Relative gate: keep what is within 10 dB of the ungated mean square.
  const relative = 10 ** ((toDb(ungated) + RELATIVE_GATE_DB) / 10);
  const kept = sums.filter((value) => value > absolute && value > relative);
  const gated = (kept.length > 0 ? kept : aboveAbsolute).reduce((total, value) => total + value, 0) / (kept.length > 0 ? kept.length : aboveAbsolute.length);

  return {
    loudnessDb: toDb(gated),
    peakDb: amplitudeToDb(peak),
    measured: Number.isFinite(toDb(gated)),
    keptBlocks: kept.length,
    blocks: blockCount,
  };
}

/**
 * Correction strength. ONE algorithm, three strengths: how much of the
 * distance to the reference is actually corrected, and how far a single sound
 * may be pushed up. Nothing here changes the measurement or the caps.
 */
export interface ZaicodeNormalizeProfile {
  id: ZaicodeNormalizeProfileId;
  label: string;
  hint: string;
  /** 0..1 of the distance to the reference that is corrected. */
  strength: number;
  /** Hard ceiling on upward correction, dB. */
  boostCapDb: number;
}

export const ZAICODE_NORMALIZE_PROFILE_IDS = ["soft", "standard", "aggressive"] as const;
export type ZaicodeNormalizeProfileId = (typeof ZAICODE_NORMALIZE_PROFILE_IDS)[number];

export const ZAICODE_NORMALIZE_PROFILES: Record<ZaicodeNormalizeProfileId, ZaicodeNormalizeProfile> = {
  soft: { id: "soft", label: "Soft", hint: "Correct half the distance. The quietest sounds stay audibly quieter.", strength: 0.5, boostCapDb: 3 },
  standard: { id: "standard", label: "Standard", hint: "Correct most of the distance, with a moderate ceiling on boosts.", strength: 0.8, boostCapDb: 6 },
  aggressive: { id: "aggressive", label: "Aggressive", hint: "Correct the whole distance. Loudest safe boost; the peak guard still decides.", strength: 1, boostCapDb: 9 },
};

/**
 * The negative cap: the largest automatic ATTENUATION, in dB. -24 dB is the
 * default; the operator may deepen it to -48 dB to pull one very loud sound
 * down without touching the rest. This is a limit on how far down the pass may
 * go, not a target the set is pushed to.
 */
export const ZAICODE_NORMALIZE_ATTENUATION_CAP_MIN = -48;
export const ZAICODE_NORMALIZE_ATTENUATION_CAP_MAX = -24;
export const ZAICODE_NORMALIZE_ATTENUATION_CAP_DEFAULT = -24;

export function normalizeZaicodeAttenuationCap(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return ZAICODE_NORMALIZE_ATTENUATION_CAP_DEFAULT;
  return Math.round(Math.min(ZAICODE_NORMALIZE_ATTENUATION_CAP_MAX, Math.max(ZAICODE_NORMALIZE_ATTENUATION_CAP_MIN, value)));
}

export interface ZaicodeNormalizeInput {
  /** Event id: the compensation is stored per event, not per file. */
  id: string;
  analysis: ZaicodeSoundAnalysis;
}

export interface ZaicodeNormalizeRow {
  id: string;
  /** Measured, dB. -Infinity when nothing could be measured. */
  beforeDb: number;
  /** afterDb + gainDb, i.e. what the set will actually play. */
  afterDb: number;
  /** Proposed compensation, dB, already capped both ways and peak-guarded. */
  gainDb: number;
  peakDb: number;
  measured: boolean;
  /** Why the number is what it is, in words the settings screen shows. */
  reason: "ok" | "capped-attenuation" | "capped-boost" | "peak-limited" | "unmeasured";
}

export interface ZaicodeNormalizePlan {
  /** Median of the measured set: one pathological sound cannot drag it. */
  referenceDb: number;
  profile: ZaicodeNormalizeProfile;
  attenuationCapDb: number;
  rows: ZaicodeNormalizeRow[];
  /** Rows that would actually change. */
  changed: number;
  /** Items the pass could not analyse; reported, never fatal. */
  failed: number;
}

function median(values: number[]): number {
  if (values.length === 0) return -Infinity;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * The plan. Pure: same inputs and options give the same rows, and it writes
 * nothing. The caller previews these numbers, then applies them.
 */
export function planZaicodeNormalization(
  inputs: readonly ZaicodeNormalizeInput[],
  options: { profile: ZaicodeNormalizeProfileId; attenuationCapDb: number },
): ZaicodeNormalizePlan {
  const profile = ZAICODE_NORMALIZE_PROFILES[options.profile] ?? ZAICODE_NORMALIZE_PROFILES.standard;
  const attenuationCapDb = normalizeZaicodeAttenuationCap(options.attenuationCapDb);
  const measured = inputs.filter((input) => input.analysis.measured && Number.isFinite(input.analysis.loudnessDb));
  const referenceDb = median(measured.map((input) => input.analysis.loudnessDb));

  let changed = 0;
  const rows = inputs.map((input): ZaicodeNormalizeRow => {
    const { analysis } = input;
    if (!analysis.measured || !Number.isFinite(referenceDb)) {
      return { id: input.id, beforeDb: analysis.loudnessDb, afterDb: analysis.loudnessDb, gainDb: 0, peakDb: analysis.peakDb, measured: false, reason: "unmeasured" };
    }
    const wanted = (referenceDb - analysis.loudnessDb) * profile.strength;
    let gainDb = wanted;
    let reason: ZaicodeNormalizeRow["reason"] = "ok";
    if (wanted > profile.boostCapDb) {
      gainDb = profile.boostCapDb;
      reason = "capped-boost";
    } else if (wanted < attenuationCapDb) {
      gainDb = attenuationCapDb;
      reason = "capped-attenuation";
    }
    // Peak guard: never a boost that pushes a sample past the ceiling.
    if (Number.isFinite(analysis.peakDb) && analysis.peakDb + gainDb > ZAICODE_PEAK_CEILING_DB) {
      gainDb = ZAICODE_PEAK_CEILING_DB - analysis.peakDb;
      reason = "peak-limited";
    }
    gainDb = Math.round(gainDb * 2) / 2;
    if (gainDb !== 0) changed += 1;
    return {
      id: input.id,
      beforeDb: analysis.loudnessDb,
      afterDb: analysis.loudnessDb + gainDb,
      gainDb,
      peakDb: analysis.peakDb,
      measured: true,
      reason: gainDb === 0 && reason !== "ok" ? reason : reason,
    };
  });

  return { referenceDb, profile, attenuationCapDb, rows, changed, failed: inputs.length - measured.length };
}

/** Content hash of a sound file: analysis is cached by CONTENT, never by name. */
export async function zaicodeSoundContentHash(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface ZaicodeAnalysisCacheEntry {
  hash: string;
  analysis: ZaicodeSoundAnalysis;
  at: number;
}

/** Cached measurements, keyed by content hash. A renamed file re-analyses only if its bytes changed. */
export class ZaicodeAnalysisCache {
  private readonly entries = new Map<string, ZaicodeAnalysisCacheEntry>();

  constructor(seed: readonly ZaicodeAnalysisCacheEntry[] = []) {
    for (const entry of seed) this.entries.set(entry.hash, entry);
  }

  get(hash: string): ZaicodeSoundAnalysis | null {
    return this.entries.get(hash)?.analysis ?? null;
  }

  put(hash: string, analysis: ZaicodeSoundAnalysis, now: number): void {
    this.entries.set(hash, { hash, analysis, at: now });
  }

  serialize(now: number, maxAgeMs = 30 * 24 * 3_600_000): ZaicodeAnalysisCacheEntry[] {
    return [...this.entries.values()].filter((entry) => now - entry.at <= maxAgeMs);
  }

  get size(): number {
    return this.entries.size;
  }
}
