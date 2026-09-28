import { saipeggleRng, type SaipeggleRng } from "../saipeggle/saipeggleRandom.js";
import { SAIASUI_DEFAULTS, SAIASUI_SCORE_KEYS, type SaiasuiConfig } from "./saiasuiConfig.js";

export type { PacingMode } from "./saiasuiConfig.js";
export type TargetKind = "normal" | "god" | "slow" | "full" | "moving" | "tiny";
export interface AimTarget {
  id: number;
  x: number;
  y: number;
  born: number;
  expires: number;
  kind: TargetKind;
  phase: number;
}
export interface SaiasuiRun {
  seed: string;
  config: SaiasuiConfig;
  mode: SaiasuiConfig["pacing"];
  rng: SaipeggleRng;
  variation: number;
  elapsed: number;
  hits: number;
  misses: number;
  score: number;
  combo: number;
  maxCombo: number;
  hp: number;
  hpActive: boolean;
  godUntil: number;
  slowUntil: number;
  nextSpawn: number;
  nextEvent: number;
  serial: number;
  target: AimTarget | null;
  bonus: AimTarget | null;
  over: boolean;
  /** A score-affecting setting changed mid-run: the score is no longer comparable. */
  tainted: boolean;
  segmentPoints: number;
  segmentPossible: number;
  checkpoint: { segment: number; grade: string; accuracy: number } | null;
  feedback: { text: string; until: number } | null;
}

export function createRun(seed: string, config: SaiasuiConfig): SaiasuiRun {
  const rng = saipeggleRng(seed);
  return {
    seed,
    config,
    mode: config.pacing,
    rng,
    variation: rng.range(0.92, 1.08),
    elapsed: 0,
    hits: 0,
    misses: 0,
    score: 0,
    combo: 0,
    maxCombo: 0,
    hp: config.startHp,
    hpActive: config.hpActivateHits <= 0,
    godUntil: 0,
    slowUntil: 0,
    nextSpawn: 0.8,
    nextEvent: 12,
    serial: 0,
    target: null,
    bonus: null,
    over: false,
    tainted: false,
    segmentPoints: 0,
    segmentPossible: 0,
    checkpoint: null,
    feedback: null,
  };
}

/**
 * Apply a live settings patch to a running game. Visual/audio fields take
 * effect immediately for free; a score-affecting field taints the run so its
 * score can never masquerade as a comparable record.
 */
export function applyLiveConfig(run: SaiasuiRun, patch: Partial<SaiasuiConfig>): void {
  for (const key of Object.keys(patch) as (keyof SaiasuiConfig)[]) {
    if (SAIASUI_SCORE_KEYS.has(key) && run.config[key] !== patch[key]) run.tainted = true;
  }
  run.config = { ...run.config, ...patch };
  run.mode = run.config.pacing;
}

export function pacing(run: SaiasuiRun) {
  const c = run.config;
  const ramp =
    run.mode === "step"
      ? Math.floor(run.elapsed / 120) * c.stepAmount
      : run.hits * c.accelRate + (run.elapsed / 120) * 0.035;
  const interval = Math.max(c.minInterval, (c.initialInterval - ramp) * run.variation);
  return {
    interval,
    lifetime: interval * c.targetLifetime,
    drain: Math.min(c.hpDrain + 2.5, c.hpDrain + ramp * 0.8),
  };
}

export function grade(accuracy: number): string {
  return accuracy >= 0.995
    ? "SS"
    : accuracy >= 0.95
      ? "S"
      : accuracy >= 0.9
        ? "A"
        : accuracy >= 0.8
          ? "B"
          : accuracy >= 0.65
            ? "C"
            : "D";
}

function spawn(run: SaiasuiRun, kind: TargetKind): AimTarget {
  return {
    id: ++run.serial,
    x: run.rng.range(0.06, 0.94),
    y: run.rng.range(0.06, 0.94),
    phase: run.rng.range(0, Math.PI * 2),
    born: run.elapsed,
    expires: run.elapsed + pacing(run).lifetime * (kind === "tiny" ? 1.5 : 1),
    kind,
  };
}

export function targetPoint(target: AimTarget, now: number, run?: SaiasuiRun, reducedMotion = false) {
  const c = run?.config ?? SAIASUI_DEFAULTS;
  if (target.kind !== "moving" || reducedMotion || !c.movementEnabled) return { x: target.x, y: target.y };
  const angle = (now - target.born) * c.movementSpeed + target.phase;
  return { x: target.x + Math.cos(angle) * c.movementAmount, y: target.y + Math.sin(angle) * c.movementAmount };
}

function miss(run: SaiasuiRun, hpLoss: number, fromTarget: boolean) {
  run.misses++;
  if (run.config.comboResetOnMiss) run.combo = 0;
  run.segmentPossible += 300;
  const damaging = fromTarget ? run.config.targetMissDamage : true;
  if (damaging && run.hpActive && run.elapsed >= run.godUntil) run.hp = Math.max(0, run.hp - hpLoss);
  if (run.config.missFeedback) run.feedback = { text: "MISS", until: run.elapsed + 0.7 };
  if (run.hpActive && run.hp <= run.config.gameOverHp) run.over = true;
}

/** Pure active-clock update. Suspension cannot create a catch-up burst or drain spike. */
export function advanceRun(run: SaiasuiRun, seconds: number): void {
  if (run.over || !Number.isFinite(seconds) || seconds <= 0) return;
  const c = run.config;
  const dt = Math.min(0.1, seconds);
  const before = run.elapsed;
  const slowed = before < run.slowUntil;
  const slowFactor = c.slowStrength;
  run.elapsed += dt;
  // Slow time extends target deadlines, but buffs and grading keep the real active clock.
  if (slowed) {
    if (run.target) run.target.expires += dt * slowFactor;
    if (run.bonus) run.bonus.expires += dt * slowFactor;
    run.nextSpawn += dt * slowFactor;
  }
  if (run.hpActive && before >= run.godUntil) {
    run.hp = Math.max(0, run.hp - pacing(run).drain * dt * (slowed ? slowFactor : 1));
    if (run.hp <= c.gameOverHp) {
      run.over = true;
      return;
    }
  }
  if (Math.floor(run.elapsed / 120) > Math.floor(before / 120)) {
    const accuracy = run.segmentPossible ? run.segmentPoints / run.segmentPossible : 0;
    run.checkpoint = { segment: Math.floor(run.elapsed / 120), grade: grade(accuracy), accuracy };
    run.segmentPoints = 0;
    run.segmentPossible = 0;
  }
  if (c.runDuration > 0 && run.elapsed >= c.runDuration) {
    run.over = true;
    return;
  }
  if (run.bonus && run.elapsed >= run.bonus.expires) run.bonus = null;
  if (run.target && run.elapsed >= run.target.expires) {
    run.target = null;
    miss(run, c.missDamage, true);
    run.nextSpawn = run.elapsed + 0.25;
  }
  if (!run.over && !run.target && run.elapsed >= run.nextSpawn) {
    let kind: TargetKind = "normal";
    if (run.hits >= run.nextEvent) {
      kind = rollEvent(run);
      run.nextEvent = run.hits + run.rng.int(c.eventIntervalMin, c.eventIntervalMax);
      if (c.tinyEnabled && run.rng.chance(c.tinyFrequency)) run.bonus = spawn(run, "tiny");
    }
    run.target = spawn(run, kind);
  }
}

/** Pick an enabled event; if none is enabled the roll yields a normal target. */
function rollEvent(run: SaiasuiRun): TargetKind {
  const c = run.config;
  const pool: TargetKind[] = [];
  if (c.godEnabled) pool.push("god");
  if (c.slowEnabled) pool.push("slow");
  if (c.fullEnabled) pool.push("full");
  if (c.movingEventEnabled && c.movementEnabled) pool.push("moving");
  return pool.length ? run.rng.pick(pool) : "normal";
}

/** A target id can score once; stale ids are ignored. Null is an explicit wrong click. */
export function hitTarget(run: SaiasuiRun, id: number | null): number {
  if (run.over) return 0;
  const c = run.config;
  if (id === null) {
    if (c.blankMiss) miss(run, c.blankDamage, false);
    return 0;
  }
  const target = run.target?.id === id ? run.target : run.bonus?.id === id ? run.bonus : null;
  if (!target || run.elapsed >= target.expires) return 0;
  if (target.kind === "tiny") {
    run.bonus = null;
    run.hp = Math.min(c.maxHp, run.hp + c.tinyHeal);
    run.score += 500;
    if (c.hitFeedback) run.feedback = { text: `+${Math.round(c.tinyHeal)} HP`, until: run.elapsed + 0.9 };
    return 500;
  }
  const reaction = (run.elapsed - target.born) / pacing(run).lifetime;
  const points = reaction <= 0.4 ? 300 : reaction <= 0.75 ? 100 : 50;
  run.target = null;
  run.hits++;
  run.combo++;
  run.maxCombo = Math.max(run.maxCombo, run.combo);
  run.score += Math.round(points * (1 + Math.min(100, run.combo - 1) * 0.025));
  run.segmentPoints += points;
  run.segmentPossible += 300;
  if (!run.hpActive && c.hpActivateHits > 0 && run.hits >= c.hpActivateHits) {
    run.hpActive = true;
    run.hp = c.maxHp;
  }
  if (run.hpActive) run.hp = Math.min(c.maxHp, run.hp + 7);
  if (target.kind === "god") run.godUntil = run.elapsed + c.godDuration;
  if (target.kind === "slow") run.slowUntil = run.elapsed + c.slowDuration;
  if (target.kind === "full") run.hp = c.maxHp;
  run.nextSpawn = Math.max(run.elapsed + 0.12, target.born + pacing(run).interval);
  if (c.hitFeedback)
    run.feedback = {
      text:
        target.kind === "normal" || target.kind === "moving"
          ? String(points)
          : target.kind.toUpperCase(),
      until: run.elapsed + 0.9,
    };
  return points;
}
