/**
 * Productivity timer: work / break phases (FastPrompter's pomodoro.py). Not a
 * deadline like a Timer: a stopwatch you drive. It counts down only while
 * running, pauses indefinitely, and its phases hand off to each other. Driven
 * by elapsed wall-clock time, never by counting ticks.
 */

export type ZaicodeProductivityPhase = "work" | "break";
export type ZaicodeProductivityState = "idle" | "running" | "paused";

export const ZAICODE_PRODUCTIVITY_DEFAULTS = {
  workSeconds: 45 * 60 + 30,
  breakSeconds: 15 * 60 + 30,
  workSound: "fastprompter:QUEST.wav",
  breakSound: "fastprompter:NEWDAY.wav",
  volume: 0.05,
} as const;

export interface ZaicodeProductivitySettings {
  workSeconds: number;
  breakSeconds: number;
  breaksEnabled: boolean;
  /** Keep ringing until acknowledged (for someone who walked away from the desk). */
  repeatAlarm: boolean;
  workSound: string;
  breakSound: string;
  volume: number;
  soundEnabled: boolean;
  showInTopBar: boolean;
  showNotification: boolean;
}

export interface ZaicodeProductivityTimer extends ZaicodeProductivitySettings {
  phase: ZaicodeProductivityPhase;
  state: ZaicodeProductivityState;
  /** Seconds left in the current phase. */
  remaining: number;
  completedCycles: number;
  alarmPending: boolean;
  /** Phase whose end is still ringing. */
  alarmPhase: ZaicodeProductivityPhase | null;
}

function sane(value: unknown, fallback: number): number {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? Math.max(1, number) : fallback;
}

export function createZaicodeProductivity(raw: unknown = null): ZaicodeProductivityTimer {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const d = ZAICODE_PRODUCTIVITY_DEFAULTS;
  const volume = Number(record.volume);
  const workSeconds = sane(record.workSeconds, d.workSeconds);
  const cycles = Math.trunc(Number(record.completedCycles));
  return {
    workSeconds,
    breakSeconds: sane(record.breakSeconds, d.breakSeconds),
    breaksEnabled: record.breaksEnabled !== false,
    repeatAlarm: record.repeatAlarm !== false,
    workSound: typeof record.workSound === "string" && record.workSound ? record.workSound : d.workSound,
    breakSound: typeof record.breakSound === "string" && record.breakSound ? record.breakSound : d.breakSound,
    volume: Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : d.volume,
    soundEnabled: record.soundEnabled !== false,
    showInTopBar: record.showInTopBar !== false,
    showNotification: record.showNotification !== false,
    // The run state never survives a restart: a timer that silently kept
    // counting while the app was closed would be a lie.
    phase: "work",
    state: "idle",
    remaining: workSeconds,
    completedCycles: Number.isFinite(cycles) ? Math.max(0, cycles) : 0,
    alarmPending: false,
    alarmPhase: null,
  };
}

export function zaicodeProductivityPersisted(timer: ZaicodeProductivityTimer): Record<string, unknown> {
  const { phase: _phase, state: _state, remaining: _remaining, alarmPending: _a, alarmPhase: _b, ...rest } = timer;
  return rest;
}

function phaseLength(timer: ZaicodeProductivityTimer, phase = timer.phase): number {
  return phase === "break" ? timer.breakSeconds : timer.workSeconds;
}

/** 0 at the start of the phase, 1 at its end. */
export function zaicodeProductivityProgress(timer: ZaicodeProductivityTimer): number {
  const total = phaseLength(timer);
  return total <= 0 ? 1 : Math.max(0, Math.min(1, 1 - timer.remaining / total));
}

/** Begin, or resume after a pause. Acknowledges a ringing alarm. */
export function startZaicodeProductivity(timer: ZaicodeProductivityTimer): ZaicodeProductivityTimer {
  return {
    ...timer,
    alarmPending: false,
    alarmPhase: null,
    remaining: timer.state === "idle" ? phaseLength(timer) : timer.remaining,
    state: "running",
  };
}

export function pauseZaicodeProductivity(timer: ZaicodeProductivityTimer): ZaicodeProductivityTimer {
  return timer.state === "running" ? { ...timer, state: "paused" } : timer;
}

/** The single action button: start -> pause -> resume. */
export function toggleZaicodeProductivity(timer: ZaicodeProductivityTimer): ZaicodeProductivityTimer {
  return timer.state === "running" ? pauseZaicodeProductivity(timer) : startZaicodeProductivity(timer);
}

export function resetZaicodeProductivity(timer: ZaicodeProductivityTimer): ZaicodeProductivityTimer {
  return { ...timer, alarmPending: false, alarmPhase: null, phase: "work", state: "idle", remaining: timer.workSeconds };
}

export function acknowledgeZaicodeProductivity(timer: ZaicodeProductivityTimer): ZaicodeProductivityTimer {
  return { ...timer, alarmPending: false, alarmPhase: null };
}

/**
 * New phase lengths. A running phase keeps counting from where it is; only an
 * idle timer snaps to the new length, so editing mid-session keeps time served.
 */
export function applyZaicodeProductivityDurations(
  timer: ZaicodeProductivityTimer,
  workSeconds?: number,
  breakSeconds?: number,
): ZaicodeProductivityTimer {
  const next = {
    ...timer,
    workSeconds: workSeconds === undefined ? timer.workSeconds : sane(workSeconds, timer.workSeconds),
    breakSeconds: breakSeconds === undefined ? timer.breakSeconds : sane(breakSeconds, timer.breakSeconds),
  };
  next.remaining = next.state === "idle" ? phaseLength(next) : Math.min(next.remaining, phaseLength(next));
  return next;
}

function enterNextPhase(timer: ZaicodeProductivityTimer, countCycle: boolean): ZaicodeProductivityTimer {
  const cycles = timer.completedCycles + (countCycle ? 1 : 0);
  if (timer.phase === "work") {
    if (timer.breaksEnabled) {
      return { ...timer, completedCycles: cycles, phase: "break", remaining: timer.breakSeconds, state: "running" };
    }
    // no break configured: stop and re-arm the work phase
    return { ...timer, completedCycles: cycles, phase: "work", remaining: timer.workSeconds, state: "paused" };
  }
  return { ...timer, completedCycles: cycles, phase: "work", remaining: timer.workSeconds, state: "running" };
}

/** Jump straight to the other phase, still running. */
export function skipZaicodeProductivityPhase(timer: ZaicodeProductivityTimer): ZaicodeProductivityTimer {
  return { ...enterNextPhase(timer, timer.phase === "work"), alarmPending: false, alarmPhase: null };
}

/**
 * Advances by real elapsed seconds and returns the phases that ended. A long
 * stall can carry it through more than one phase, so this loops.
 */
export function tickZaicodeProductivity(
  timer: ZaicodeProductivityTimer,
  elapsedSeconds: number,
): { timer: ZaicodeProductivityTimer; ended: ZaicodeProductivityPhase[] } {
  const ended: ZaicodeProductivityPhase[] = [];
  if (timer.state !== "running" || !(elapsedSeconds > 0)) return { timer, ended };
  let current = timer;
  let elapsed = elapsedSeconds;
  for (let guard = 0; guard < 1000; guard += 1) {
    if (elapsed < current.remaining) {
      current = { ...current, remaining: current.remaining - elapsed };
      break;
    }
    elapsed -= current.remaining;
    ended.push(current.phase);
    const alarm = { alarmPending: current.repeatAlarm || current.alarmPending, alarmPhase: current.phase };
    current = { ...enterNextPhase(current, current.phase === "work"), ...alarm };
    if (current.state !== "running") break;
  }
  return { timer: current, ended };
}

/** mm:ss, or h:mm:ss past an hour. */
export function formatZaicodeClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function describeZaicodeProductivity(timer: ZaicodeProductivityTimer): string {
  const bits = [`${timer.phase === "work" ? "Work" : "Break"} ${formatZaicodeClock(timer.remaining)}`];
  if (timer.state === "paused") bits.push("paused");
  else if (timer.state === "idle") bits.push("not started");
  if (timer.completedCycles) bits.push(`${timer.completedCycles} done`);
  if (timer.alarmPending) bits.push("alarm ringing");
  return bits.join(" - ");
}
