import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ZAICODE_NORMALIZE_PROFILES,
  ZAICODE_PEAK_CEILING_DB,
  analyzeZaicodeSoundPcm,
  normalizeZaicodeAttenuationCap,
  planZaicodeNormalization,
  ZaicodeAnalysisCache,
  type ZaicodeSoundAnalysis,
} from "@/zaicode/zaicodeSoundAnalysis.js";
import {
  normalizeZaicodePool,
  pickZaicodePoolSound,
  redistributeZaicodePool,
  zaicodeRng,
  type ZaicodePoolEntry,
} from "@/zaicode/zaicodeSoundPools.js";

/**
 * Wave 3, parts A and B: the measurement, the proposal and the distribution.
 * All pure, all asserted on numbers rather than on what "looks balanced".
 */

const RATE = 48_000;

function tone(db: number, seconds = 1, sampleRate = RATE): Float32Array {
  const amplitude = 10 ** (db / 20);
  const samples = new Float32Array(Math.round(seconds * sampleRate));
  for (let index = 0; index < samples.length; index += 1) samples[index] = amplitude * Math.sin((2 * Math.PI * 440 * index) / sampleRate);
  return samples;
}

function analyzed(db: number, peakDb = db): ZaicodeSoundAnalysis {
  return { loudnessDb: db, peakDb, measured: true, keptBlocks: 1, blocks: 1 };
}

test("Wave 3 A: loudness is measured, not guessed from the peak", () => {
  // A full-scale SINE is -3 dB RMS while its peak is 0 dBFS. That 3 dB is the
  // whole reason a peak-based normalizer is wrong, so it is asserted here.
  const full = analyzeZaicodeSoundPcm(tone(0), RATE);
  assert.ok(Math.abs(full.loudnessDb + 3.01) < 0.2, `sine at 0 dBFS peak reads about -3 dB RMS, got ${full.loudnessDb}`);
  assert.ok(Math.abs(full.peakDb) < 0.2);
  const half = analyzeZaicodeSoundPcm(tone(-6.02), RATE);
  assert.ok(Math.abs(half.loudnessDb + 9.03) < 0.3, `about -9 dB, got ${half.loudnessDb}`);
  assert.ok(Math.abs(half.peakDb + 6.02) < 0.2, "the peak is measured separately");
  assert.equal(half.measured, true);
});

test("Wave 3 A: a quiet block is gated out instead of dragging the level down", () => {
  // 1.2 s of tone then 0.4 s near silence, aligned to the 400 ms gate blocks.
  // An ungated mean square would read about -5 dB; the relative gate must
  // throw the quiet block away and report the loud part alone.
  const samples = new Float32Array(RATE * 1.6);
  samples.set(tone(0, 1.2), 0);
  samples.set(tone(-40).subarray(0, Math.round(RATE * 0.4)), Math.round(RATE * 1.2));
  const analysis = analyzeZaicodeSoundPcm(samples, RATE);
  assert.ok(Math.abs(analysis.loudnessDb + 3.01) < 0.5, `gated level should be the LOUD half only, got ${analysis.loudnessDb}`);
  assert.equal(analysis.blocks, 4);
  assert.ok(analysis.keptBlocks < analysis.blocks, "the quiet blocks were gated");
});

test("Wave 3 A: silence and rubbish measure as unmeasured rather than as -0 dB", () => {
  assert.equal(analyzeZaicodeSoundPcm(new Float32Array(0), RATE).measured, false);
  assert.equal(analyzeZaicodeSoundPcm(tone(-80), RATE).measured, false, "below the absolute gate");
  const bad = analyzeZaicodeSoundPcm(tone(-6), 0);
  assert.equal(bad.measured, false, "a zero sample rate is not a measurement");
});

test("Wave 3 A: the reference is a median, so one loud sound cannot set the level", () => {
  const set = [
    { id: "a", analysis: analyzed(-18) },
    { id: "b", analysis: analyzed(-18) },
    { id: "c", analysis: analyzed(-19) },
    { id: "outlier", analysis: analyzed(0) },
  ];
  const plan = planZaicodeNormalization(set, { profile: "standard", attenuationCapDb: -24 });
  assert.equal(plan.referenceDb, -18, "the median ignores the outlier entirely");
  assert.equal(plan.rows.find((row) => row.id === "outlier")!.gainDb, -14.5, "attenuated by what the reference asks, not capped");
  // The set is pulled TOWARD the reference, not toward the outlier: the two
  // already at the reference do not move, the one below it is lifted.
  assert.equal(plan.rows.find((row) => row.id === "a")!.gainDb, 0);
  assert.equal(plan.rows.find((row) => row.id === "b")!.gainDb, 0);
  assert.equal(plan.rows.find((row) => row.id === "c")!.gainDb, 1, "0.8 dB of correction, quantized to 0.5 dB steps");
  // A median, not a mean: the mean of that set would be -13.75.
  assert.notEqual(plan.referenceDb, -13.75);
});

test("Wave 3 A: Soft, Standard and Aggressive are one algorithm at three strengths", () => {
  const set = [
    { id: "quiet", analysis: analyzed(-30) },
    { id: "loud", analysis: analyzed(-10) },
  ];
  const gains = (["soft", "standard", "aggressive"] as const).map(
    (profile) => planZaicodeNormalization(set, { profile, attenuationCapDb: -48 }).rows[0]!.gainDb,
  );
  assert.ok(gains[0] < gains[1]!, "soft corrects less than standard");
  assert.ok(gains[1]! < gains[2]!, "standard corrects less than aggressive");
  for (const [index, id] of (["soft", "standard", "aggressive"] as const).entries()) {
    assert.equal(ZAICODE_NORMALIZE_PROFILES[id].strength, [0.5, 0.8, 1][index]);
  }
});

test("Wave 3 A: the negative cap spans -24..-48 dB and changes the proposal", () => {
  const set = [
    { id: "a", analysis: analyzed(-20) },
    { id: "b", analysis: analyzed(-20) },
    { id: "c", analysis: analyzed(-20) },
    { id: "outlier", analysis: analyzed(10) },
  ];
  const at24 = planZaicodeNormalization(set, { profile: "aggressive", attenuationCapDb: -24 }).rows.find((row) => row.id === "outlier")!;
  const at48 = planZaicodeNormalization(set, { profile: "aggressive", attenuationCapDb: -48 }).rows.find((row) => row.id === "outlier")!;
  assert.equal(at24.gainDb, -24, "the -24 dB default cap holds it back from the -30 the reference asks for");
  assert.equal(at24.reason, "capped-attenuation");
  assert.equal(at48.gainDb, -30, "a -48 dB cap lets the full correction through");
  assert.ok(at48.gainDb < at24.gainDb, "a deeper cap allows more attenuation");
  assert.equal(normalizeZaicodeAttenuationCap(-100), -48);
  assert.equal(normalizeZaicodeAttenuationCap(-1), -24);
  assert.equal(normalizeZaicodeAttenuationCap("loud"), -24, "a nonsense value is the default, not a crash");
});

test("Wave 3 A: a boost never crosses the peak ceiling", () => {
  // A very quiet but very peaky sound: the correction would clip it.
  const plan = planZaicodeNormalization(
    [
      { id: "quiet-noisy", analysis: analyzed(-40, -2) },
      { id: "reference", analysis: analyzed(-10, -10) },
    ],
    { profile: "aggressive", attenuationCapDb: -24 },
  );
  const row = plan.rows.find((entry) => entry.id === "quiet-noisy")!;
  assert.equal(row.reason, "peak-limited");
  assert.ok(row.peakDb + row.gainDb <= ZAICODE_PEAK_CEILING_DB, `${row.peakDb} + ${row.gainDb} must stay at or under ${ZAICODE_PEAK_CEILING_DB}`);
  assert.ok(row.gainDb > 0, "it is still corrected, just not past the ceiling");
});

test("Wave 3 A: a set where nothing can be measured is reported, not applied", () => {
  const plan = planZaicodeNormalization(
    [
      { id: "broken", analysis: { loudnessDb: -Infinity, peakDb: -Infinity, measured: false, keptBlocks: 0, blocks: 0 } },
    ],
    { profile: "standard", attenuationCapDb: -24 },
  );
  assert.equal(plan.changed, 0);
  assert.equal(plan.failed, 1);
  assert.equal(plan.rows[0]!.reason, "unmeasured");
  assert.equal(plan.rows[0]!.gainDb, 0);
});

test("Wave 3 A: analysis is cached by CONTENT, so a rename re-uses the measurement", () => {
  const cache = new ZaicodeAnalysisCache();
  const analysis = analyzed(-12);
  cache.put("hash-a", analysis, 1000);
  assert.deepEqual(cache.get("hash-a"), analysis);
  assert.equal(cache.get("hash-b"), null, "a different file measures on its own");
  const fresh = new ZaicodeAnalysisCache(cache.serialize(2000));
  assert.deepEqual(fresh.get("hash-a"), analysis, "the cache survives a reopen");
  assert.equal(new ZaicodeAnalysisCache(cache.serialize(1000 + 40 * 24 * 3_600_000)).size, 0, "and ages out");
});

const pool = (ids: string[], weights: number[], extra: Partial<ZaicodePoolEntry> = {}): ZaicodePoolEntry[] =>
  ids.map((id, index) => ({ id, weight: weights[index]!, locked: false, missing: false, ...extra }));

test("Wave 3 B: effective probabilities sum to exactly 100%", () => {
  for (const weights of [[1, 1, 1], [1, 2, 3], [5, 5, 5, 5, 5], [7, 11, 13, 17, 19, 23], [1, 0, 0, 4]]) {
    const plan = normalizeZaicodePool(pool(["a", "b", "c", "d", "e"].slice(0, weights.length), weights));
    const total = plan.shares.reduce((sum, share) => sum + share.bps, 0);
    assert.equal(total, 10_000, `weights ${weights.join("/")} must add to exactly 100%`);
    assert.equal(Math.round(plan.shares.reduce((sum, share) => sum + share.percent, 0)), 100);
  }
});

test("Wave 3 B: one entry is 100%, and no usable entry is a deterministic fallback", () => {
  const single = normalizeZaicodePool(pool(["only"], [7]));
  assert.equal(single.shares[0]!.percent, 100);
  assert.equal(single.totalBps, 10_000);

  const allZero = normalizeZaicodePool(pool(["a", "b"], [0, 0]));
  assert.equal(allZero.totalBps, 10_000);
  assert.equal(allZero.shares[0]!.percent, 100, "always the same fallback, never silence at random");

  const allMissing = normalizeZaicodePool(pool(["a", "b"], [1, 1], { missing: true }));
  assert.equal(allMissing.totalBps, 0);
  assert.equal(pickZaicodePoolSound(pool(["a", "b"], [1, 1], { missing: true }), zaicodeRng("x")), null);

  const rubbish = normalizeZaicodePool(pool(["a", "b"], [Number.NaN, -3]));
  assert.equal(rubbish.totalBps, 10_000, "invalid weights normalize safely");
});

test("Wave 3 B: a missing file is visible and never chosen", () => {
  const entries = pool(["here", "gone"], [1, 1], {});
  entries[1] = { ...entries[1]!, missing: true };
  const plan = normalizeZaicodePool(entries);
  assert.equal(plan.shares[1]!.note, "missing-file");
  assert.equal(plan.shares[1]!.selectable, false);
  assert.equal(plan.shares[0]!.percent, 100);
  for (let i = 0; i < 200; i += 1) {
    assert.equal(pickZaicodePoolSound(entries, zaicodeRng(`seed-${i}`)), "here");
  }
});

test("Wave 3 B: the pick follows the displayed distribution, deterministically", () => {
  const entries = pool(["a", "b", "c"], [1, 2, 7]);
  const plan = normalizeZaicodePool(entries);
  const shown = Object.fromEntries(plan.shares.map((share) => [share.id, share.percent]));
  assert.deepEqual(shown, { a: 10, b: 20, c: 70 });

  const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
  const rng = zaicodeRng("pool-distribution");
  const rounds = 20_000;
  for (let i = 0; i < rounds; i += 1) counts[pickZaicodePoolSound(entries, rng)!] += 1;
  for (const id of ["a", "b", "c"]) {
    const measured = (counts[id]! / rounds) * 100;
    assert.ok(Math.abs(measured - shown[id]!) < 1.5, `${id}: shown ${shown[id]}%, played ${measured.toFixed(2)}%`);
  }
  // Same seed, same sequence: the pick is not secretly Math.random.
  const again = zaicodeRng("pool-distribution");
  assert.equal(pickZaicodePoolSound(entries, again), pickZaicodePoolSound(entries, zaicodeRng("pool-distribution")));
});

test("Wave 3 B: changing one entry redistributes the rest proportionally", () => {
  const before = normalizeZaicodePool(pool(["a", "b", "c"], [1, 1, 1]));
  assert.deepEqual(before.shares.map((share) => share.percent), [33.34, 33.33, 33.33]);

  const after = redistributeZaicodePool(pool(["a", "b", "c"], [1, 1, 1]), "a", 8);
  const plan = normalizeZaicodePool(after);
  assert.equal(plan.totalBps, 10_000, "the total stays honest");
  assert.equal(plan.shares.find((share) => share.id === "a")!.percent, 80, "8 of 10 weight units");
  assert.equal(plan.shares.find((share) => share.id === "b")!.percent, 10, "the others were pulled down, not ignored");
  assert.equal(plan.shares.find((share) => share.id === "c")!.percent, 10);
});

test("Wave 3 B: a locked entry keeps its share when another changes", () => {
  const entries: ZaicodePoolEntry[] = [
    { id: "pinned", weight: 50, locked: true, missing: false },
    { id: "a", weight: 1, locked: false, missing: false },
    { id: "b", weight: 1, locked: false, missing: false },
  ];
  const before = normalizeZaicodePool(entries);
  const pinnedBefore = before.shares.find((share) => share.id === "pinned")!.percent;
  assert.ok(pinnedBefore > 95, "50 of 52 weight units is most of the pool");
  const plan = normalizeZaicodePool(redistributeZaicodePool(entries, "a", 9));
  assert.equal(plan.totalBps, 10_000);
  assert.equal(plan.shares.find((share) => share.id === "pinned")!.percent, pinnedBefore, "pinned keeps the share it had");
  // The rest of the pool is what is left: 3.85%, split 9:1 by the new weights.
  const leftover = 100 - pinnedBefore;
  assert.ok(Math.abs(plan.shares.find((share) => share.id === "a")!.percent - leftover * 0.9) < 0.01);
  assert.ok(Math.abs(plan.shares.find((share) => share.id === "b")!.percent - leftover * 0.1) < 0.01);
});

test("Wave 3 B: zeroing the only entry hands the pool to a deterministic fallback", () => {
  const entries = pool(["a", "b"], [1, 1]);
  const plan = normalizeZaicodePool(redistributeZaicodePool(entries, "a", 0));
  assert.equal(plan.totalBps, 10_000);
  assert.equal(plan.shares.find((share) => share.id === "b")!.percent, 100);
});
