/**
 * SRC-058: "working for" must show how long the work has been going, not how
 * long ago the user opened the session.
 *
 * The composer used to anchor its timer at its own first render (so entering a
 * session reset it to 0m), and the project row anchored at the session's
 * `createdAt` (so a days-old MAIN session read "working for 3d" five minutes
 * into a run). Neither is when the work started.
 *
 * The sessions-index feed carries no run-start timestamp, so this clock records
 * one: the first moment a session is observed working. Short idle gaps between
 * chained turns (`/goal`, Auto continue, a retry) do not start a new streak, so
 * the read-out is the total working time of the streak, not of the last turn.
 * The sidebar observes every session of every project on each feed update;
 * the composer reads the same entry, so the two read-outs never disagree.
 */

/** Idle time that still counts as the same working streak (chained turns). */
export const ZAICODE_RUN_CLOCK_GRACE_MS = 90_000;

interface ZaicodeRunClockEntry {
  /** When the current working streak began (ms). */
  since: number;
  /** When the session was first seen idle after working (ms; 0 = working). */
  idleSince: number;
}

export class ZaicodeRunClock {
  private readonly entries = new Map<string, ZaicodeRunClockEntry>();

  constructor(private readonly graceMs: number = ZAICODE_RUN_CLOCK_GRACE_MS) {}

  /**
   * Records one observation of a session and returns the start of its current
   * working streak (0 while it is not working).
   *
   * `activityAt` is the feed's own timestamp for the observation (the row's
   * last activity). On the first working observation it is the best available
   * start: it is when the run began if the app saw the run begin, and never
   * earlier than the truth. `0` means "no timestamp", and `now` is used.
   */
  observe(sessionId: string, working: boolean, activityAt: number, now: number): number {
    const entry = this.entries.get(sessionId);
    if (!working) {
      if (!entry) return 0;
      if (entry.idleSince === 0) entry.idleSince = now;
      else if (now - entry.idleSince > this.graceMs) this.entries.delete(sessionId);
      return 0;
    }
    if (entry && (entry.idleSince === 0 || now - entry.idleSince <= this.graceMs)) {
      entry.idleSince = 0;
      return entry.since;
    }
    const since = activityAt > 0 ? Math.min(activityAt, now) : now;
    this.entries.set(sessionId, { since, idleSince: 0 });
    return since;
  }

  /** The recorded streak start, or 0 when the session is not known to be working. */
  sinceOf(sessionId: string): number {
    const entry = this.entries.get(sessionId);
    return entry && entry.idleSince === 0 ? entry.since : 0;
  }
}

/** The one clock the sidebar feeds and every "working for" read-out reads. */
export const zaicodeRunClock = new ZaicodeRunClock();
