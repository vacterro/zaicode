/**
 * SRC-161:W2-002 — retry SAFETY has to outlive the renderer.
 *
 * A renderer reload (a crash, a dev reload, a reopened window) restarts the UI modules while the
 * host and its runtimes keep going. Every way the operator had of stopping the automatic senders
 * lived in module memory, so a reload silently re-armed all of them: "stop all", "stop this error",
 * the quota wall, and the per-session attempt budget came back as if nobody had ever said stop.
 * That is the SRC-082 hole again — knocking on an empty door with nowhere to turn it off — only
 * across a reload instead of across a session.
 *
 * These are safety facts, never preferences: machine-local runtime state, deliberately NOT part of
 * the Save All preference snapshot (a "stop" on this machine must not travel to another one, and a
 * profile must not resurrect it on a fresh install). Every entry is bounded, because this record is
 * read on every start.
 *
 * Ceiling: localStorage is the renderer's only durable channel here — the host has no endpoint for
 * this. A host-owned lease would be stronger (it would survive a profile wipe too); until such an
 * endpoint exists, this is what makes "I told it to stop" survive a reload.
 */

export const ZAICODE_RETRY_SAFETY_STORAGE_KEY = "zaicode-retry-safety-v1";

/** Attempts remembered per session across reloads. Bounded: the oldest sessions fall off. */
const ATTEMPT_LIMIT = 50;
/** Stopped-error keys, same ceiling as the live set. */
const STOPPED_LIMIT = 40;
/** Quota walls, same ceiling as the live map. */
const WALL_LIMIT = 200;

export interface ZaicodeRetrySafetyRecord {
  /** The sidebar's stop-all: no automatic send goes out until the operator allows it again. */
  halted: boolean;
  /** Attempts already spent per session, so a reload does not hand out a fresh budget. */
  attempts: Record<string, number>;
  /** Errors the operator closed: their retry stays off after the reload. */
  stoppedErrors: string[];
  /** Session -> epoch ms of the quota wall, so a reload does not ask an exhausted account again. */
  quotaWalls: Record<string, number>;
}

const EMPTY: ZaicodeRetrySafetyRecord = { halted: false, attempts: {}, stoppedErrors: [], quotaWalls: {} };

function bounded<T>(entries: [string, T][], limit: number): Record<string, T> {
  return Object.fromEntries(entries.slice(Math.max(0, entries.length - limit)));
}

export function readZaicodeRetrySafety(): ZaicodeRetrySafetyRecord {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(ZAICODE_RETRY_SAFETY_STORAGE_KEY);
  } catch {
    // Storage disabled (private mode, no window): the in-memory state is all there is.
    return { ...EMPTY };
  }
  if (!raw) return { ...EMPTY };
  try {
    const parsed = JSON.parse(raw) as Partial<ZaicodeRetrySafetyRecord>;
    const attempts = parsed.attempts && typeof parsed.attempts === "object" ? parsed.attempts : {};
    const walls = parsed.quotaWalls && typeof parsed.quotaWalls === "object" ? parsed.quotaWalls : {};
    return {
      halted: parsed.halted === true,
      attempts: Object.fromEntries(
        Object.entries(attempts)
          .filter(([, value]) => typeof value === "number" && Number.isFinite(value) && value > 0)
          .slice(-ATTEMPT_LIMIT),
      ),
      stoppedErrors: Array.isArray(parsed.stoppedErrors)
        ? parsed.stoppedErrors.filter((key): key is string => typeof key === "string" && key.length > 0).slice(-STOPPED_LIMIT)
        : [],
      quotaWalls: Object.fromEntries(
        Object.entries(walls)
          .filter(([, value]) => typeof value === "number" && Number.isFinite(value))
          .slice(-WALL_LIMIT),
      ),
    };
  } catch {
    // A record we cannot read is not a reason to fail: the safe reading is the empty one.
    return { ...EMPTY };
  }
}

let cache: ZaicodeRetrySafetyRecord | null = null;

/** The record as this renderer currently holds it (loaded once, then updated in place). */
export function currentZaicodeRetrySafety(): ZaicodeRetrySafetyRecord {
  cache ??= readZaicodeRetrySafety();
  return cache;
}

export function writeZaicodeRetrySafety(patch: Partial<ZaicodeRetrySafetyRecord>): void {
  const next: ZaicodeRetrySafetyRecord = { ...currentZaicodeRetrySafety(), ...patch };
  next.attempts = bounded(Object.entries(next.attempts), ATTEMPT_LIMIT);
  next.quotaWalls = bounded(Object.entries(next.quotaWalls), WALL_LIMIT);
  next.stoppedErrors = next.stoppedErrors.slice(-STOPPED_LIMIT);
  cache = next;
  try {
    localStorage.setItem(ZAICODE_RETRY_SAFETY_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // The in-memory copy still holds for this renderer's lifetime.
  }
}

/** Forgets everything: the operator re-enabled the senders, or a test needs a clean sheet. */
export function clearZaicodeRetrySafety(): void {
  cache = { ...EMPTY, attempts: {}, stoppedErrors: [], quotaWalls: {} };
  try {
    localStorage.removeItem(ZAICODE_RETRY_SAFETY_STORAGE_KEY);
  } catch {
    // Nothing to remove.
  }
}
