/**
 * Elapsed time for work that is still counted (SRC-070 item C).
 *
 * One rule, everywhere: a running item shows `now - startedAt`, a terminal one
 * shows its own final timestamp minus `startedAt` and never moves again. The
 * old displays derived the age from `endedAt ?? now`, so an item that reached
 * a terminal state without a recorded final stamp kept counting for as long
 * as the component existed, and a reload re-derived it from the current clock
 * instead of from the stored result.
 *
 * `ponytail:` a worker record whose process dies without its terminal ever
 * reporting an exit has no final stamp and still reads as running. The stamp
 * is written by one call site (`exitZaicodeWorkerRecord`); a second,
 * process-liveness-backed writer is the upgrade path if an operator reports it.
 */

import {
  ZAICODE_JOB_TERMINAL_STATUSES,
  type ZaicodeJobTerminalStatus,
} from "@zcode/shared";

export interface ZaicodeElapsedSource {
  readonly startedAt: number;
  /** The authoritative final timestamp; null while the work is still running. */
  readonly completedAt: number | null;
}

/** Running: now - startedAt. Terminal: completedAt - startedAt, frozen. */
export function zaicodeElapsedMs(item: ZaicodeElapsedSource, now: number): number {
  return Math.max(0, (item.completedAt ?? now) - item.startedAt);
}

export function zaicodeElapsedRunning(item: ZaicodeElapsedSource): boolean {
  return item.completedAt === null;
}

/** True while anything in the list still counts: the only reason to run a clock. */
export function zaicodeAnyElapsedRunning(items: readonly ZaicodeElapsedSource[]): boolean {
  return items.some(zaicodeElapsedRunning);
}

/**
 * A worker's own elapsed. `exitCode` is the terminal transition and `endedAt`
 * the stamp it left, so a finished worker reads the same value on every render
 * and after a reload -- it never falls back to the current clock. (Every exit
 * code the terminal can report, 0 and non-zero alike, is terminal.)
 */
export function zaicodeWorkerElapsedMs(
  worker: { startedAt: number; endedAt: number | null; exitCode: number | null },
  now: number,
): number {
  if (worker.exitCode === null) return Math.max(0, now - worker.startedAt);
  return Math.max(0, (worker.endedAt ?? now) - worker.startedAt);
}

/** True while any of these workers is still running: the only reason to tick. */
export function zaicodeAnyWorkerRunning(workers: readonly { exitCode: number | null }[]): boolean {
  return workers.some((worker) => worker.exitCode === null);
}

/**
 * A queue job's elapsed. `finishedAt` is written by the transition into every
 * terminal state and reloaded with the job, so a finished job re-derives the
 * same number after a reload instead of counting on from the current clock.
 * A job that never started has no elapsed to show.
 */
export function zaicodeJobElapsedSource(job: {
  status: string;
  startedAt?: number;
  createdAt: number;
  finishedAt?: number;
}): ZaicodeElapsedSource | null {
  if (job.startedAt === undefined) return null;
  return {
    startedAt: job.startedAt,
    completedAt: ZAICODE_JOB_TERMINAL_STATUSES.includes(job.status as ZaicodeJobTerminalStatus)
      ? (job.finishedAt ?? job.startedAt)
      : null,
  };
}
