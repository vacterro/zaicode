import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { buildVerdict } from "./zaicode-soak-verdict.mjs";

const horizon = 12 * 3600;
function timeline(seconds) {
  return [0, seconds / 2, seconds].map((elapsedSeconds) => ({
    elapsedSeconds, fps: 60, nodes: 1800, heapUsedBytes: 40 * 1048576,
    rssBytes: 300 * 1048576, blank: false, longFrames: 0,
  }));
}
function verdict(seconds, config = {}) {
  return buildVerdict(timeline(seconds), { soakHours: 12, ...config });
}

test("90-99 percent of a 12-hour horizon is incomplete, not PASS", () => {
  for (const fraction of [0.901, 0.95, 0.99]) {
    assert.equal(verdict(horizon * fraction).verdict, "FAIL_INCOMPLETE_WINDOW");
  }
});

test("coverage grants exactly one default sample interval, not percentage slack", () => {
  assert.equal(verdict(horizon - 16).verdict, "FAIL_INCOMPLETE_WINDOW");
  assert.equal(verdict(horizon - 15).verdict, "PASS");
  assert.equal(verdict(horizon - 14).verdict, "PASS");
  assert.equal(verdict(horizon).verdict, "PASS");
  assert.equal(verdict(horizon).coverageToleranceSeconds, 15);
});

test("configured sample cadence defines and reports its own boundary", () => {
  assert.equal(verdict(horizon - 61, { sampleSeconds: 60 }).verdict, "FAIL_INCOMPLETE_WINDOW");
  assert.equal(verdict(horizon - 60, { sampleSeconds: 60 }).verdict, "PASS");
  assert.equal(verdict(horizon - 59, { sampleSeconds: 60 }).verdict, "PASS");
  assert.equal(verdict(horizon, { sampleSeconds: 60 }).coverageToleranceSeconds, 60);
});

test("invalid cadence cannot expand coverage tolerance", () => {
  for (const sampleSeconds of [0, -1, Infinity, NaN, "60", null]) {
    const result = verdict(horizon - 16, { sampleSeconds });
    assert.equal(result.verdict, "FAIL_INCOMPLETE_WINDOW");
    assert.equal(result.coverageToleranceSeconds, 15);
  }
});

test("a cadence at least as long as the horizon cannot waive the entire horizon", () => {
  for (const sampleSeconds of [horizon, horizon + 1]) {
    const result = verdict(0, { sampleSeconds });
    assert.equal(result.verdict, "FAIL_INCOMPLETE_WINDOW");
    assert.equal(result.coverageToleranceSeconds, 0);
  }
  const short = verdict(0, { soakHours: 10 / 3600 });
  assert.equal(short.verdict, "FAIL_INCOMPLETE_WINDOW");
  assert.equal(short.coverageToleranceSeconds, 0);
});

test("coverage is the harness span, not the last successful probe", () => {
  // The final round stamps elapsedSeconds, then its probe fails, so the row carries
  // probeError and no fps. Coverage must still be the full span the run walked.
  const rows = timeline(horizon);
  const failedProbe = { elapsedSeconds: horizon, probeError: "detached", blank: false };
  const withFailedFinalProbe = [...rows.slice(0, -1), failedProbe];
  const result = buildVerdict(withFailedFinalProbe, { soakHours: 12 });
  assert.equal(result.coveredSeconds, horizon);
  assert.equal(result.durationSeconds, horizon);
  assert.equal(result.verdict, "PASS");
  // And the shortfall is real, not forgiven: one round short still fails.
  const short = buildVerdict(
    [...rows.slice(0, -1), { elapsedSeconds: horizon - 600, probeError: "detached" }],
    { soakHours: 12 },
  );
  assert.equal(short.coveredSeconds, horizon - 600);
  assert.equal(short.verdict, "FAIL_INCOMPLETE_WINDOW");
});

test("a timeline with no usable elapsed stamp reports zero coverage, not NaN", () => {
  for (const rows of [[], [{ fps: 60, nodes: 1800 }]]) {
    const result = buildVerdict(rows, { soakHours: 12 });
    assert.equal(result.coveredSeconds, 0);
    assert.ok(Number.isFinite(result.coveredSeconds));
    assert.notEqual(result.verdict, "PASS");
  }
});

const execute = promisify(execFile);
async function replay(t, seconds, cadenceArgs) {
  const cache = path.resolve(import.meta.dirname, "../.e2e-cache");
  await mkdir(cache, { recursive: true });
  const temp = await mkdtemp(path.join(cache, "soak-window-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const input = path.join(temp, "timeline.jsonl");
  const out = path.join(temp, "out");
  await writeFile(input, timeline(seconds).map((row) => JSON.stringify(row)).join("\n"));
  let code = 0;
  try {
    await execute(process.execPath, [
      path.join(import.meta.dirname, "zaicode-soak.mjs"),
      "--replay", input, "--out", out, "--minutes", "0", "--soak-hours", "12",
      ...cadenceArgs,
    ], { timeout: 15_000 });
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    code = error.code;
  }
  return {
    code,
    result: JSON.parse(await readFile(path.join(out, "verdict.json"), "utf8")),
    report: await readFile(path.join(out, "report.md"), "utf8"),
  };
}

test("replay CLI carries custom cadence to the verdict, report and exit status", async (t) => {
  for (const [shortfall, expectedCode] of [[60, 0], [61, 1]]) {
    const { code, result, report } = await replay(t, horizon - shortfall, ["--sample-seconds", "60"]);
    assert.equal(code, expectedCode);
    assert.equal(result.verdict, expectedCode === 0 ? "PASS" : "FAIL_INCOMPLETE_WINDOW");
    assert.equal(result.config.sampleSeconds, 60);
    assert.equal(result.coverageToleranceSeconds, 60);
    assert.match(report, /43200s requested, tolerance 60s/);
  }
});

test("replay CLI preserves the default boundary and reports its tolerance", async (t) => {
  for (const [shortfall, expectedCode] of [[15, 0], [16, 1]]) {
    const { code, result, report } = await replay(t, horizon - shortfall, []);
    assert.equal(code, expectedCode);
    assert.equal(result.verdict, expectedCode === 0 ? "PASS" : "FAIL_INCOMPLETE_WINDOW");
    assert.equal(result.config.sampleSeconds, 15);
    assert.equal(result.coverageToleranceSeconds, 15);
    assert.match(report, /43200s requested, tolerance 15s/);
  }
});
