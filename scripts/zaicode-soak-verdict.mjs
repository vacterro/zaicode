/**
 * Verdict logic for scripts/zaicode-soak.mjs.
 *
 * Split out so the rules that decide PASS can be exercised directly: a 12-hour run costs a
 * day, so the conditions that would make it green without having tested anything have to be
 * provable without spending that day.
 */

/** Least-squares slope per minute, so "degraded" is a number and not a vibe. */
export function slopePerMinute(points) {
  const n = points.length;
  if (n < 2) return 0;
  const meanX = points.reduce((sum, p) => sum + p.x, 0) / n;
  const meanY = points.reduce((sum, p) => sum + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - meanX) * (p.y - meanY);
    den += (p.x - meanX) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

/**
 * Median DOM nodes below which the run never exercised the product.
 *
 * A packaged Electron window that fails to reach the ZAICODE renderer still answers CDP
 * with ~11 nodes; a rendered home screen is in the thousands. The floor sits far below any
 * real render so a genuine run never trips it, and far above an empty shell so the empty
 * shell cannot pass.
 */
export const RENDERED_NODE_FLOOR = 200;

/**
 * The churn a timeline actually recorded, recovered from the samples themselves.
 *
 * A live run keeps its own tally, but `--replay` is handed nothing but the timeline, and
 * without this a replayed 12-hour run reported `churn interactions: 0` while the log beside
 * it showed hundreds of clicks: the evidence existed and the verdict could not see it. The
 * same verdict then reads a run that churned and a run that never clicked as identical.
 */
function tallyChurn(samples) {
  const actions = {};
  for (const sample of samples) {
    for (const [action, count] of Object.entries(sample.churnActions ?? {})) {
      actions[action] = (actions[action] ?? 0) + count;
    }
  }
  return actions;
}

export function buildVerdict(timeline, config) {
  const samples = timeline.filter((row) => typeof row.fps === "number");
  const blankSamples = timeline.filter((row) => row.blank === true);
  const first = samples[0];
  const last = samples.at(-1);
  const midpoint = samples[Math.floor(samples.length / 2)];
  const fpsSlope = slopePerMinute(samples.map((s) => ({ x: s.elapsedSeconds / 60, y: s.fps })));
  const heapSlope = slopePerMinute(
    samples.filter((s) => typeof s.heapUsedBytes === "number").map((s) => ({ x: s.elapsedSeconds / 60, y: s.heapUsedBytes })),
  );
  const rssSlope = slopePerMinute(
    samples.filter((s) => typeof s.rssBytes === "number").map((s) => ({ x: s.elapsedSeconds / 60, y: s.rssBytes })),
  );
  // SRC-116's symptom is a specific number: ~1-2 FPS after hours. Judging "degraded" by
  // a raw fps/minute slope flags ordinary render jitter (a 3% drift over two minutes is
  // noise), so the rule is the operator's own: half the baseline, or under 10 FPS, or
  // jank that did not exist at the start. Anything looser would make a green run and a
  // broken one indistinguishable.
  const worstFps = samples.reduce((min, s) => Math.min(min, s.fps), Number.POSITIVE_INFINITY);
  const janky = samples.filter((s) => (s.longFrames ?? 0) > 0).length;
  // `longFrames` counts frames slower than 50ms inside a TWO-SECOND probe window, so
  // "longFrames > 0" means one frame in two seconds took longer than 50ms: an ordinary GC
  // pause. The rule used to read degradation as "most samples janky AND the very first
  // sample happened to be clean" -- a single 2-second window as the baseline, which is a
  // coin flip rather than a baseline. The first 11.2-hour run measured this way held 88-90
  // fps flat with a flat heap and 1171 real clicks, and was still called degraded at an
  // 85% jank density that never moved. SRC-116's symptom is jank that APPEARS, so the
  // comparison is now density early against density late: constant noise is not decay.
  const jankDensity = (window) =>
    window.length === 0 ? 0 : window.filter((s) => (s.longFrames ?? 0) > 0).length / window.length;
  const edge = Math.max(1, Math.floor(samples.length * 0.1));
  const jankRose =
    samples.length >= 20 && jankDensity(samples.slice(0, edge)) < 0.25 && jankDensity(samples.slice(-edge)) > 0.75;
  const degraded =
    (first && midpoint ? last.fps < midpoint.fps * 0.5 : false) ||
    (last ? last.fps < 10 : false) ||
    jankRose;
  // A PASS has to mean the surface actually ran. Three ways a run collects plausible
  // numbers without ever exercising the app, all of which used to read green: the
  // renderer never painted its tree (a bare Electron shell is ~11 nodes, a rendered
  // ZAICODE home is thousands), the churn clicked nothing, or every probe failed and
  // there are no samples to judge. A 12-hour run that does any of these costs a day
  // to learn nothing, so each is its own verdict rather than a footnote.
  const nodeCounts = samples.map((s) => s.nodes).filter((n) => typeof n === "number").sort((a, b) => a - b);
  const medianNodes = nodeCounts.length > 0 ? nodeCounts[Math.floor(nodeCounts.length / 2)] : 0;
  // Churn is tallied over EVERY row, not the fps-filtered ones: the harness writes it onto
  // whichever sample a round produced, so a round that churned and then failed its probe
  // still performed churn and must still count.
  const churnActions = config.churnActions ?? tallyChurn(timeline);
  const churnErrors =
    config.churnErrors ?? timeline.filter((s) => typeof s.churnError === "string").length;
  const churnTotal = Object.values(churnActions).reduce((sum, n) => sum + n, 0);
  const churnRequested = Number(config.churnMinutes ?? 0) > 0;
  // A PASS also has to mean the window was covered. Twenty-five healthy samples replayed
  // from the middle of an 11.2-hour run read PASS exactly like the full 2341-sample
  // verdict, because durationSeconds was reported and never compared with anything: the
  // artifact could not tell a run that covered the horizon from one that covered minutes.
  // Coverage is the span the HARNESS walked, not the span its last successful probe
  // measured. A round stamps elapsedSeconds before it probes, and a round whose probe
  // failed still wrote that stamp -- it simply has no fps, so the fps filter drops it.
  // Reading `last.elapsedSeconds` therefore took the coverage of the round BEFORE the
  // one that died, and a run that ended on a failed probe reported less window than it
  // covered: a real span silently read short against the horizon gate. The churn tally
  // below already reads the unfiltered timeline for exactly this reason.
  const requestedSeconds = Number(config.soakHours ?? 0) * 3600;
  const coveredSeconds = Number(timeline.at(-1)?.elapsedSeconds) || 0;
  // Coverage slack is ONE sample interval, not a percentage of the horizon. A round's
  // clock starts when the round starts, then the probe runs and the harness waits for
  // the next round, so a run cut off at its deadline is legitimately one interval short;
  // that is the whole of what is forgiven. The rule used to forgive 10% instead, which
  // on a 12-hour horizon excused 72 missing minutes and made the artifact unable to
  // tell a stalled run from a completed one. A cadence at least as long as the horizon
  // forgives nothing, or the slack would swallow the run it was meant to measure.
  const sampleSeconds = typeof config.sampleSeconds === "number" &&
    Number.isFinite(config.sampleSeconds) && config.sampleSeconds > 0
    ? config.sampleSeconds : 15;
  const coverageToleranceSeconds = requestedSeconds > sampleSeconds ? sampleSeconds : 0;
  const windowShort = requestedSeconds > 0 &&
    coveredSeconds < requestedSeconds - coverageToleranceSeconds;
  const verdict =
    samples.length === 0
      ? "FAIL_NO_SAMPLES"
      : medianNodes < RENDERED_NODE_FLOOR
        ? "FAIL_SURFACE_NOT_RENDERED"
        : blankSamples.length > 0
          ? "FAIL_BLANK_SURFACE"
          : degraded
            ? "FAIL_DEGRADED"
            : churnRequested && churnTotal === 0
              ? "FAIL_NO_CHURN"
              : windowShort
                ? "FAIL_INCOMPLETE_WINDOW"
                : "PASS";
  return {
    verdict,
    generatedAt: new Date().toISOString(),
    config,
    samples: samples.length,
    medianNodes,
    durationSeconds: coveredSeconds,
    coveredSeconds,
    requestedSeconds: requestedSeconds || null,
    coverageToleranceSeconds,
    fps: {
      first: first?.fps ?? null,
      midpoint: midpoint?.fps ?? null,
      last: last?.fps ?? null,
      worst: Number.isFinite(worstFps) ? worstFps : null,
      slopePerMinute: Number(fpsSlope.toFixed(4)),
    },
    heapUsedMb: {
      first: first ? Number((first.heapUsedBytes / 1048576).toFixed(1)) : null,
      last: last ? Number((last.heapUsedBytes / 1048576).toFixed(1)) : null,
      growthMbPerMinute: Number((heapSlope / 1048576).toFixed(3)),
    },
    rssMb: {
      first: first ? Number((first.rssBytes / 1048576).toFixed(1)) : null,
      last: last ? Number((last.rssBytes / 1048576).toFixed(1)) : null,
      growthMbPerMinute: Number((rssSlope / 1048576).toFixed(3)),
    },
    jankySamples: janky,
    jankDensity: {
      early: Number(jankDensity(samples.slice(0, edge)).toFixed(3)),
      late: Number(jankDensity(samples.slice(-edge)).toFixed(3)),
    },
    blankSurfaceSamples: blankSamples.length,
    churnActions,
    churnErrors,
    churnTotal,
    finalHealthSnapshot: last?.health ?? null,
  };
}
