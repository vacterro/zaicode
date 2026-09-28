import { saipeggleRng, type SaipeggleRng } from "../saipeggle/saipeggleRandom.js";

export type PacingMode = "linear" | "step";
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
  mode: PacingMode;
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
  segmentPoints: number;
  segmentPossible: number;
  checkpoint: { segment: number; grade: string; accuracy: number } | null;
  feedback: { text: string; until: number } | null;
}

export function createRun(seed: string, mode: PacingMode): SaiasuiRun {
  const rng = saipeggleRng(seed);
  return {
    seed,
    mode,
    rng,
    variation: rng.range(0.92, 1.08),
    elapsed: 0,
    hits: 0,
    misses: 0,
    score: 0,
    combo: 0,
    maxCombo: 0,
    hp: 100,
    hpActive: false,
    godUntil: 0,
    slowUntil: 0,
    nextSpawn: 0.8,
    nextEvent: 12,
    serial: 0,
    target: null,
    bonus: null,
    over: false,
    segmentPoints: 0,
    segmentPossible: 0,
    checkpoint: null,
    feedback: null,
  };
}

export function pacing(run: SaiasuiRun) {
  const ramp =
    run.mode === "step"
      ? Math.floor(run.elapsed / 120) * 0.13
      : run.hits * 0.0014 + (run.elapsed / 120) * 0.035;
  const interval = Math.max(0.65, (2.8 - ramp) * run.variation);
  return {
    interval,
    lifetime: Math.max(1.6, interval * 1.55),
    drain: Math.min(4, 1.5 + ramp * 0.8),
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

export function targetPoint(target: AimTarget, now: number, reducedMotion = false) {
  if (target.kind !== "moving" || reducedMotion) return { x: target.x, y: target.y };
  const angle = (now - target.born) * 1.3 + target.phase;
  return { x: target.x + Math.cos(angle) * 0.045, y: target.y + Math.sin(angle) * 0.045 };
}

function miss(run: SaiasuiRun, hpLoss: number) {
  run.misses++;
  run.combo = 0;
  run.segmentPossible += 300;
  if (run.hpActive && run.elapsed >= run.godUntil) run.hp = Math.max(0, run.hp - hpLoss);
  run.feedback = { text: "MISS", until: run.elapsed + 0.7 };
  if (run.hpActive && run.hp <= 0) run.over = true;
}

/** Pure active-clock update. Suspension cannot create a catch-up burst or drain spike. */
export function advanceRun(run: SaiasuiRun, seconds: number): void {
  if (run.over || !Number.isFinite(seconds) || seconds <= 0) return;
  const dt = Math.min(0.1, seconds);
  const before = run.elapsed;
  const slowed = before < run.slowUntil;
  run.elapsed += dt;
  // Slow time extends target deadlines, but buffs and grading keep the real active clock.
  if (slowed) {
    if (run.target) run.target.expires += dt * 0.5;
    if (run.bonus) run.bonus.expires += dt * 0.5;
    run.nextSpawn += dt * 0.5;
  }
  if (run.hpActive && before >= run.godUntil) {
    run.hp = Math.max(0, run.hp - pacing(run).drain * dt * (slowed ? 0.5 : 1));
    if (run.hp <= 0) {
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
  if (run.bonus && run.elapsed >= run.bonus.expires) run.bonus = null;
  if (run.target && run.elapsed >= run.target.expires) {
    run.target = null;
    miss(run, 6);
    run.nextSpawn = run.elapsed + 0.25;
  }
  if (!run.over && !run.target && run.elapsed >= run.nextSpawn) {
    let kind: TargetKind = "normal";
    if (run.hits >= run.nextEvent) {
      kind = run.rng.pick(["god", "slow", "full", "moving"] as const);
      run.nextEvent = run.hits + run.rng.int(8, 15);
      if (run.rng.chance(0.5)) run.bonus = spawn(run, "tiny");
    }
    run.target = spawn(run, kind);
  }
}

/** A target id can score once; stale ids are ignored. Null is an explicit wrong click. */
export function hitTarget(run: SaiasuiRun, id: number | null): number {
  if (run.over) return 0;
  if (id === null) {
    miss(run, 2);
    return 0;
  }
  const target = run.target?.id === id ? run.target : run.bonus?.id === id ? run.bonus : null;
  if (!target || run.elapsed >= target.expires) return 0;
  if (target.kind === "tiny") {
    run.bonus = null;
    run.hp = Math.min(100, run.hp + 18);
    run.score += 500;
    run.feedback = { text: "+18 HP", until: run.elapsed + 0.9 };
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
  if (run.hits === 50) {
    run.hpActive = true;
    run.hp = 100;
  }
  if (run.hpActive) run.hp = Math.min(100, run.hp + 7);
  if (target.kind === "god") run.godUntil = run.elapsed + 3;
  if (target.kind === "slow") run.slowUntil = run.elapsed + 3;
  if (target.kind === "full") run.hp = 100;
  run.nextSpawn = Math.max(run.elapsed + 0.12, target.born + pacing(run).interval);
  run.feedback = {
    text:
      target.kind === "normal" || target.kind === "moving"
        ? String(points)
        : target.kind.toUpperCase(),
    until: run.elapsed + 0.9,
  };
  return points;
}
