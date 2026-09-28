import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createRun,
  advanceRun,
  applyLiveConfig,
  hitTarget,
  targetPoint,
  pacing,
  grade,
  type SaiasuiRun,
} from "../src/zaicode/saiasui/saiasuiEngine.js";
import {
  detectSaiasuiPreset,
  normalizeSaiasuiConfig,
  saiasuiPresetConfig,
  SAIASUI_DEFAULTS,
  SAIASUI_LIMITS,
  type PacingMode,
  type SaiasuiConfig,
} from "../src/zaicode/saiasui/saiasuiConfig.js";
import { trackBlankClick } from "../src/zaicode/saiasui/saiasuiGesture.js";
import { readZaicodeSetting } from "../src/zaicode/zaicodeSettingsSnapshot.js";
import { normalizeSaiasuiSettings } from "../src/zaicode/saiasui/saiasuiStore.js";

function cfg(patch: Partial<SaiasuiConfig> = {}): SaiasuiConfig {
  return { ...SAIASUI_DEFAULTS, ...patch };
}
function makeRun(seed: string, mode: PacingMode = "linear", patch: Partial<SaiasuiConfig> = {}) {
  return createRun(seed, cfg({ pacing: mode, ...patch }));
}

test("unavailable storage and malformed settings fall back without blocking the app", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new Error("storage denied");
    },
  });
  try {
    assert.equal(readZaicodeSetting("zaicode-saiasui-settings-v1"), null);
    assert.deepEqual(normalizeSaiasuiSettings(null), {
      enabled: true,
      sound: true,
      pacing: "linear",
    });
    assert.equal(normalizeSaiasuiSettings({ pacing: "invalid", enabled: false }).pacing, "linear");
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

function nextTarget(run: SaiasuiRun) {
  for (let i = 0; i < 100 && !run.target && !run.over; i++) advanceRun(run, 0.1);
  assert.ok(run.target);
  return run.target;
}

test("blank-click gesture needs five spaced clicks in six seconds", () => {
  let clicks: { x: number; y: number; at: number }[] = [];
  for (let i = 0; i < 4; i++) clicks = trackBlankClick(clicks, { x: i * 60, y: 0, at: i });
  assert.equal(clicks.length, 4);
  assert.equal(trackBlankClick(clicks, { x: 180, y: 0, at: 4 }).length, 4);
  assert.equal(trackBlankClick(clicks, { x: 240, y: 0, at: 4 }).length, 5);
  assert.equal(trackBlankClick(clicks, { x: 240, y: 0, at: 10 }).length, 1);
});

test("seed reproduces choices; other seeds change difficulty and positions", () => {
  const a = makeRun("seed-a"),
    b = makeRun("seed-a"),
    c = makeRun("seed-b");
  for (let i = 0; i < 80; i++) {
    assert.deepEqual(nextTarget(a), nextTarget(b));
    hitTarget(a, a.target!.id);
    hitTarget(b, b.target!.id);
  }
  assert.notEqual(a.variation, c.variation);
  assert.notDeepEqual(nextTarget(a), nextTarget(c));
});

test("HP begins on hit 50; hits heal, idle drains, misses break combo", () => {
  const run = makeRun("health");
  for (let i = 0; i < 49; i++) hitTarget(run, nextTarget(run).id);
  assert.equal(run.hpActive, false);
  hitTarget(run, nextTarget(run).id);
  assert.equal(run.hpActive, true);
  assert.equal(run.hp, 100);
  run.godUntil = 0;
  advanceRun(run, 0.1);
  assert.ok(run.hp < 100);
  hitTarget(run, nextTarget(run).id);
  assert.equal(run.hp, 100);
  run.godUntil = 0;
  const before = run.hp;
  hitTarget(run, null);
  assert.equal(run.combo, 0);
  assert.equal(run.hp, before - 2);
});

test("power-ups expire on active clock; tiny bonuses have no miss penalty", () => {
  const run = makeRun("events");
  run.hpActive = true;
  run.hp = 30;
  nextTarget(run).kind = "god";
  hitTarget(run, run.target!.id);
  assert.equal(run.godUntil, run.elapsed + 3);
  const hp = run.hp;
  hitTarget(run, null);
  advanceRun(run, 0.1);
  assert.equal(run.hp, hp);
  nextTarget(run).kind = "slow";
  hitTarget(run, run.target!.id);
  assert.equal(run.slowUntil, run.elapsed + 3);
  nextTarget(run).kind = "full";
  hitTarget(run, run.target!.id);
  assert.equal(run.hp, 100);
  run.bonus = { ...nextTarget(run), id: 999, kind: "tiny", expires: run.elapsed + 0.05 };
  const misses = run.misses;
  advanceRun(run, 0.1);
  assert.equal(run.bonus, null);
  assert.equal(run.misses, misses);
});

test("linear is gradual; step holds between 2-minute boundaries; both cap", () => {
  const linear = makeRun("tempo", "linear"),
    step = makeRun("tempo", "step");
  const initial = pacing(step).interval;
  linear.hits = step.hits = 100;
  linear.elapsed = step.elapsed = 119;
  assert.equal(pacing(step).interval, initial);
  assert.ok(pacing(linear).interval < initial);
  step.elapsed = 120;
  assert.ok(pacing(step).interval < initial);
  for (const run of [linear, step]) {
    run.elapsed = 1e8;
    run.hits = 1e8;
    assert.ok(pacing(run).interval >= SAIASUI_DEFAULTS.minInterval);
    assert.ok(pacing(run).drain <= SAIASUI_DEFAULTS.hpDrain + 2.5);
  }
});

test("sustained play survives 30 minutes in both modes over multiple seeds", () => {
  for (const mode of ["linear", "step"] as const)
    for (const seed of ["a", "b", "c", "d"]) {
      const run = makeRun(seed, mode);
      while (run.elapsed < 1800 && !run.over) {
        advanceRun(run, 0.1);
        if (run.target && run.elapsed - run.target.born >= 0.45) hitTarget(run, run.target.id);
      }
      assert.equal(run.over, false, `${seed}/${mode}`);
      assert.ok(run.hp > 70);
      assert.equal(run.checkpoint?.segment, 15);
    }
});

test("grades are per segment, hits idempotent, game over freezes score", () => {
  const run = makeRun("grades");
  const target = nextTarget(run);
  hitTarget(run, target.id);
  const score = run.score;
  hitTarget(run, target.id);
  assert.equal(run.score, score);
  assert.equal(grade(1), "SS");
  assert.equal(grade(0.91), "A");
  run.elapsed = 119.95;
  advanceRun(run, 0.1);
  assert.equal(run.checkpoint?.grade, "SS");
  run.elapsed = 239.95;
  run.segmentPossible = 300;
  run.segmentPoints = 50;
  advanceRun(run, 0.1);
  assert.equal(run.checkpoint?.grade, "D");
  run.hpActive = true;
  run.godUntil = 0;
  run.hp = 0.001;
  advanceRun(run, 0.1);
  assert.equal(run.over, true);
  hitTarget(run, nextTarget(makeRun("other")).id);
  assert.equal(run.score, score);
});

test("moving targets stay in the playfield and long frame gaps are bounded", () => {
  const run = makeRun("movement");
  const target = nextTarget(run);
  target.kind = "moving";
  for (let time = 0; time < 100; time += 0.1) {
    const p = targetPoint(target, time, run);
    assert.ok(p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1);
  }
  const elapsed = run.elapsed;
  advanceRun(run, 600);
  assert.ok(run.elapsed - elapsed <= 0.101);
});

test("occasional missed circles remain recoverable and god protection expires", () => {
  for (const mode of ["linear", "step"] as const) {
    const run = makeRun("imperfect", mode);
    let seen = 0;
    let previous = 0;
    while (run.elapsed < 600 && !run.over) {
      advanceRun(run, 0.1);
      if (!run.target) continue;
      if (run.target.id !== previous) {
        previous = run.target.id;
        seen++;
      }
      if (seen % 8 && run.elapsed - run.target.born >= 0.45) hitTarget(run, run.target.id);
    }
    assert.equal(run.over, false);
    assert.ok(run.misses > 0);
  }
  const run = makeRun("expiry");
  run.hpActive = true;
  run.hp = 70;
  run.godUntil = 3;
  for (let i = 0; i < 29; i++) advanceRun(run, 0.1);
  assert.equal(run.hp, 70);
  for (let i = 0; i < 3; i++) advanceRun(run, 0.1);
  assert.ok(run.hp < 70);
});

// --- T-105 tuning regressions ---

test("blank-click damage toggle changes HP behaviour", () => {
  const harmless = makeRun("blank", "linear", { blankMiss: false });
  harmless.hpActive = true;
  harmless.hp = 50;
  hitTarget(harmless, null);
  assert.equal(harmless.hp, 50, "blankMiss off: no HP change and no miss counted");
  assert.equal(harmless.misses, 0);

  const damaging = makeRun("blank", "linear", { blankMiss: true, blankDamage: 9 });
  damaging.hpActive = true;
  damaging.hp = 50;
  hitTarget(damaging, null);
  assert.equal(damaging.hp, 41);
  assert.equal(damaging.misses, 1);
});

test("tempo / minimum-interval controls actually modify engine pacing", () => {
  const slow = makeRun("pace", "linear", { initialInterval: 4 });
  const fast = makeRun("pace", "linear", { initialInterval: 1.5 });
  assert.ok(pacing(slow).interval > pacing(fast).interval);
  const floored = makeRun("pace", "linear", { minInterval: 2 });
  floored.hits = 1e6;
  floored.elapsed = 1e6;
  assert.ok(pacing(floored).interval >= 2);
});

test("target-size settings drive geometry and moving range stays bounded", () => {
  const big = makeRun("size", "linear", { targetSize: 70, movementAmount: 0.2, movementSpeed: 4 });
  const target = nextTarget(big);
  target.kind = "moving";
  for (let time = 0; time < 200; time += 0.05) {
    const p = targetPoint(target, time, big);
    // movement offset is bounded by movementAmount around the spawn point
    assert.ok(Math.abs(p.x - target.x) <= big.config.movementAmount + 1e-9);
    assert.ok(Math.abs(p.y - target.y) <= big.config.movementAmount + 1e-9);
  }
  // disabled movement pins the target
  const still = makeRun("size", "linear", { movementEnabled: false });
  const t2 = nextTarget(still);
  t2.kind = "moving";
  assert.deepEqual(targetPoint(t2, still.elapsed + 5, still), { x: t2.x, y: t2.y });
});

test("preset -> custom transition and preset detection", () => {
  assert.equal(detectSaiasuiPreset(saiasuiPresetConfig("fast")), "fast");
  assert.equal(detectSaiasuiPreset(SAIASUI_DEFAULTS), "default");
  const edited = normalizeSaiasuiConfig({ ...saiasuiPresetConfig("fast"), missDamage: 99 });
  assert.equal(detectSaiasuiPreset(edited), "custom");
});

test("invalid persisted numeric values normalize safely", () => {
  const dirty = normalizeSaiasuiConfig({
    initialInterval: "fast",
    minInterval: -100,
    targetSize: 9999,
    volume: Number.NaN,
    eventIntervalMin: 40,
    eventIntervalMax: 5,
    pacing: "bogus",
    preset: "nonsense",
  });
  assert.equal(dirty.initialInterval, SAIASUI_DEFAULTS.initialInterval);
  assert.equal(dirty.minInterval, SAIASUI_LIMITS.minInterval[0]);
  assert.equal(dirty.targetSize, SAIASUI_LIMITS.targetSize[1]);
  assert.equal(dirty.volume, SAIASUI_DEFAULTS.volume);
  assert.ok(dirty.eventIntervalMax >= dirty.eventIntervalMin);
  assert.equal(dirty.pacing, "linear");
  assert.equal(dirty.preset, "default");
});

test("legacy three-field settings migrate: sound -> audioEnabled", () => {
  const migrated = normalizeSaiasuiConfig({ enabled: true, sound: false, pacing: "step" });
  assert.equal(migrated.audioEnabled, false);
  assert.equal(migrated.pacing, "step");
  assert.equal(migrated.targetSize, SAIASUI_DEFAULTS.targetSize);
});

test("score-affecting live change taints the run; visual change does not", () => {
  const run = makeRun("live");
  applyLiveConfig(run, { targetOpacity: 0.5, hudVisible: false });
  assert.equal(run.tainted, false, "visual-only change keeps the run record-eligible");
  applyLiveConfig(run, { minInterval: 0.4 });
  assert.equal(run.tainted, true, "pacing change taints the run");
});

test("run duration ends the game deterministically", () => {
  const run = makeRun("timed", "linear", { runDuration: 30 });
  while (!run.over && run.elapsed < 60) advanceRun(run, 0.1);
  assert.equal(run.over, true);
  assert.ok(run.elapsed >= 30 && run.elapsed < 31);
});

test("custom start/max HP honoured; HP can be always-on", () => {
  const run = makeRun("hp", "linear", { hpActivateHits: 0, startHp: 40, maxHp: 40 });
  assert.equal(run.hpActive, true);
  assert.equal(run.hp, 40);
  hitTarget(run, nextTarget(run).id);
  assert.ok(run.hp <= 40, "heal never exceeds maxHp");
});
