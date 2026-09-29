/**
 * Health of the desktop-wide ProTrail overlays (T-129), free of `electron` so it runs in a unit test.
 *
 * "Running" used to be inferred from what the main process itself had done: a window was created, its
 * document finished loading, the input reader said ready. The operator's report -- ProTrail is switched
 * on, yet draws nothing until it is switched off and on -- is the case that inference cannot see: an
 * overlay that exists and counts as ready, but never took its settings, sits off its monitor, has a
 * compositor that produces no frames, or never finished loading. Each rule below reads something the
 * overlay page itself confirms (its probe) or something the window reports about itself, and answers
 * with exactly one repair. The orchestrator applies the repair, with a budget so a monitor that cannot
 * be fixed costs a log line, not a loop.
 */

/** What an overlay page answers when asked (see `window.__zaicodeProtrailProbe` in zaicode-protrail.ts). */
export interface OverlayProbe {
  /** The page holds a ProTrail config. */
  configured: boolean;
  /** That config is on, so the engine draws what it is fed. */
  enabled: boolean;
  /** window.innerWidth / innerHeight, CSS px. */
  width: number;
  height: number;
  /** A requestAnimationFrame callback ran within the probe's own deadline. */
  frames: boolean;
}

export type OverlayRepair =
  | { action: "ok" }
  | { action: "wait"; why: string }
  | { action: "reveal"; why: string }
  | { action: "place"; why: string }
  | { action: "resend"; why: string }
  | { action: "rebuild"; why: string };

export interface OverlayVerdict {
  /** Loaded, visible, on its monitor, holding an enabled config, drawing frames at the monitor's size. */
  verified: boolean;
  repair: OverlayRepair;
}

export interface OverlayJudgement {
  now: number;
  createdAt: number;
  ready: boolean;
  visible: boolean;
  /** The window's bounds equal its display's. */
  placed: boolean;
  /** The monitor's size in DIP: what the page's innerWidth/innerHeight must be. */
  expected: { width: number; height: number };
  /** Last probe answer; null = no answer. */
  probe: OverlayProbe | null;
  /** Probes in a row that got no answer or reported no frames. */
  strikes: number;
  /** Times the config was sent again to this overlay in its current life. */
  resends: number;
}

/** A document that has not finished loading by then is dropped and built again. */
export const OVERLAY_LOAD_DEADLINE_MS = 8000;
/** Unanswered (or frameless) probes in a row before the overlay is rebuilt. */
export const OVERLAY_STRIKE_LIMIT = 3;
/** Config re-sends before an overlay that still does not take it is rebuilt. */
export const OVERLAY_RESEND_LIMIT = 2;
const SIZE_TOLERANCE_PX = 2;

export function judgeOverlay(o: OverlayJudgement): OverlayVerdict {
  const not = (repair: OverlayRepair): OverlayVerdict => ({ verified: false, repair });
  if (!o.ready) {
    if (o.now - o.createdAt > OVERLAY_LOAD_DEADLINE_MS) {
      return not({ action: "rebuild", why: `its page did not finish loading in ${OVERLAY_LOAD_DEADLINE_MS / 1000} s` });
    }
    return not({ action: "wait", why: "its page is still loading" });
  }
  if (!o.visible) return not({ action: "reveal", why: "it is loaded but hidden" });
  if (!o.placed) return not({ action: "place", why: "it is not on its monitor" });
  const probe = o.probe;
  if (!probe || !probe.frames) {
    const why = probe ? "its page draws no frames" : "its page does not answer";
    return o.strikes >= OVERLAY_STRIKE_LIMIT ? not({ action: "rebuild", why }) : not({ action: "wait", why });
  }
  if (!probe.configured || !probe.enabled) {
    const why = probe.configured ? "its page holds a switched-off config" : "its page never took the config";
    return o.resends < OVERLAY_RESEND_LIMIT ? not({ action: "resend", why }) : not({ action: "rebuild", why });
  }
  if (Math.abs(probe.width - o.expected.width) > SIZE_TOLERANCE_PX || Math.abs(probe.height - o.expected.height) > SIZE_TOLERANCE_PX) {
    // The window is where it should be but its page sees another size: a zoom or scaling a rebuild cannot change.
    return not({ action: "wait", why: `its page is ${probe.width}x${probe.height} px, the monitor ${o.expected.width}x${o.expected.height}` });
  }
  return { verified: true, repair: { action: "ok" } };
}

/** The overlay of one monitor, as the health check sees it. */
export interface OverlayView {
  displayId: number;
  /** Bumps with every window built for the monitor, so a rebuilt overlay starts with a clean record. */
  serial: number;
  createdAt: number;
  ready: boolean;
  visible: boolean;
  placed: boolean;
  expected: { width: number; height: number };
  /** Asks the page; resolves null when it does not answer in time. Never rejects. */
  probe(): Promise<OverlayProbe | null>;
}

export interface OverlayRepairs {
  reveal(view: OverlayView): void;
  place(view: OverlayView): void;
  resend(view: OverlayView): void;
  rebuild(view: OverlayView): void;
}

export interface OverlayHealthDeps {
  now(): number;
  /** Must not keep the process alive. */
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** True while a ZAICODE window wants the desktop-wide mode. */
  wanted(): boolean;
  /** One view per display that currently has an overlay window (or should have one). */
  views(): OverlayView[];
  repairs: OverlayRepairs;
  /** Called when the number of verified overlays changed. */
  onChange(): void;
  log(message: string): void;
}

/** While anything is unverified the check runs every second; once all is well, a slow sanity pass. */
export const OVERLAY_HEALTH_FAST_MS = 1000;
export const OVERLAY_HEALTH_SLOW_MS = 5000;
/** Rebuilds of one monitor's overlay allowed per minute before the check stops trying and says so. */
export const OVERLAY_REBUILDS_PER_MINUTE = 4;
const MINUTE_MS = 60_000;

interface OverlayRecord {
  serial: number;
  strikes: number;
  resends: number;
  verified: boolean;
  why: string;
  places: number;
}

export function createOverlayHealth(deps: OverlayHealthDeps) {
  const records = new Map<number, OverlayRecord>();
  const rebuilds = new Map<number, number[]>();
  let timer: unknown = null;
  let running = false;
  let verifiedCount = 0;
  let generation = 0;

  const recordOf = (view: OverlayView): OverlayRecord => {
    const known = records.get(view.displayId);
    if (known && known.serial === view.serial) return known;
    const fresh: OverlayRecord = { serial: view.serial, strikes: 0, resends: 0, verified: false, why: "", places: 0 };
    records.set(view.displayId, fresh);
    return fresh;
  };

  const schedule = (ms: number): void => {
    if (!running) return;
    if (timer !== null) deps.clearTimer(timer);
    timer = deps.setTimer(() => {
      timer = null;
      void tick();
    }, ms);
  };

  const rebuildAllowed = (displayId: number, now: number): boolean => {
    const recent = (rebuilds.get(displayId) ?? []).filter((at) => now - at < MINUTE_MS);
    rebuilds.set(displayId, recent);
    return recent.length < OVERLAY_REBUILDS_PER_MINUTE;
  };

  const repair = (view: OverlayView, action: OverlayRepair, record: OverlayRecord, now: number): void => {
    if (action.action === "ok" || action.action === "wait") return;
    const label = `overlay ${view.displayId}`;
    if (action.action === "reveal") {
      deps.repairs.reveal(view);
      deps.log(`${label} shown again: ${action.why}`);
    } else if (action.action === "place") {
      deps.repairs.place(view);
      record.places += 1;
      // A window manager that keeps moving it would otherwise fill the log: the first move and every tenth.
      if (record.places === 1 || record.places % 10 === 0) deps.log(`${label} put back on its monitor (${record.places}x): ${action.why}`);
    } else if (action.action === "resend") {
      record.resends += 1;
      deps.repairs.resend(view);
      deps.log(`${label} got the config again (${record.resends}): ${action.why}`);
    } else if (rebuildAllowed(view.displayId, now)) {
      rebuilds.get(view.displayId)!.push(now);
      deps.repairs.rebuild(view);
      deps.log(`${label} rebuilt: ${action.why}`);
    } else if (record.why !== `budget:${action.why}`) {
      record.why = `budget:${action.why}`;
      deps.log(`${label} keeps failing (${action.why}); not rebuilding it again for a minute`);
    }
  };

  const tick = async (): Promise<void> => {
    try {
      await pass();
    } catch (error) {
      // A check that throws must not end the checking: say so and try again at the slow cadence.
      deps.log(`health check failed: ${error instanceof Error ? error.message : String(error)}`);
      schedule(OVERLAY_HEALTH_SLOW_MS);
    }
  };

  const pass = async (): Promise<void> => {
    if (!running) return;
    const run = generation;
    if (!deps.wanted()) {
      schedule(OVERLAY_HEALTH_SLOW_MS);
      return;
    }
    const views = deps.views();
    const answers = await Promise.all(views.map((view) => (view.ready ? view.probe() : Promise.resolve(null))));
    if (!running || run !== generation) return;
    const now = deps.now();
    let verified = 0;
    let settled = true;
    views.forEach((view, index) => {
      const record = recordOf(view);
      const answer = answers[index] ?? null;
      if (view.ready) record.strikes = answer && answer.frames ? 0 : record.strikes + 1;
      const verdict = judgeOverlay({
        now,
        createdAt: view.createdAt,
        ready: view.ready,
        visible: view.visible,
        placed: view.placed,
        expected: view.expected,
        probe: answer,
        strikes: record.strikes,
        resends: record.resends,
      });
      if (verdict.verified !== record.verified) {
        record.verified = verdict.verified;
        if (verdict.verified) {
          record.resends = 0;
          record.places = 0;
        }
      }
      if (verdict.verified) verified += 1;
      else settled = false;
      if (!verdict.verified && verdict.repair.action === "wait" && record.why !== verdict.repair.why) {
        record.why = verdict.repair.why;
        if (view.ready) deps.log(`overlay ${view.displayId} not confirmed yet: ${verdict.repair.why}`);
      }
      repair(view, verdict.repair, record, now);
    });
    if (verified !== verifiedCount) {
      verifiedCount = verified;
      deps.log(`${verified} of ${views.length} overlay${views.length === 1 ? "" : "s"} confirmed`);
      deps.onChange();
    }
    schedule(settled && views.length > 0 ? OVERLAY_HEALTH_SLOW_MS : OVERLAY_HEALTH_FAST_MS);
  };

  return {
    /** Begins checking (a first pass shortly, then the cadence above). */
    start(): void {
      running = true;
      generation += 1;
      verifiedCount = 0;
      records.clear();
      rebuilds.clear();
      schedule(OVERLAY_HEALTH_FAST_MS / 2);
    },
    stop(): void {
      running = false;
      generation += 1;
      if (timer !== null) deps.clearTimer(timer);
      timer = null;
      verifiedCount = 0;
      records.clear();
      rebuilds.clear();
    },
    /** Overlays confirmed by their own page at the last pass. */
    verified: (): number => verifiedCount,
    /** One pass now (tests, and a caller that just repaired something). */
    tick,
  };
}
