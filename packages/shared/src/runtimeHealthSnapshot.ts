/**
 * Compact runtime-health snapshot (T-164 / SRC-116).
 *
 * One JSON object an operator can hand over when ZAICODE has degraded: uptime, memory,
 * event-loop lag, the cardinality of every hot cache, the open quota circuits and the
 * quota windows behind them. It is a diagnostic artefact, so the redaction pass at the
 * bottom is the part that matters: credentials, API keys, tokens, chat contents and
 * private message bodies must never reach a file the operator pastes into a bug report.
 *
 * The shape is intentionally flat and numeric. Anything a human needs to read as text
 * (a provider id, a window key) has to survive {@link redactRuntimeHealthSnapshot}, which
 * drops by key name and truncates by length -- so a new caller cannot leak a message body
 * by adding a field, it can only leak one by picking a field name that looks innocuous.
 */

export interface RuntimeHealthSnapshot {
  /** Schema version, so a consumer can tell an old snapshot from a new one. */
  version: number;
  takenAt: string;
  app: {
    version?: string;
    platform?: string;
    electron?: string;
    /** Seconds since this process started. */
    uptimeSeconds: number;
  };
  memory: {
    /** Node `process.memoryUsage()` in bytes; absent in a plain browser. */
    rssBytes?: number;
    heapUsedBytes?: number;
    heapTotalBytes?: number;
    externalBytes?: number;
  };
  /** Event-loop lag in ms: how late a `setTimeout(0)` actually fired. */
  eventLoopLagMs?: number;
  /** Registered memory-diagnostic counters, flattened as `<name>.<key>`. */
  counters: Record<string, number>;
  /** Process-local provider quota circuits, with no provider secrets. */
  quotaCircuits: RuntimeHealthQuotaCircuit[];
  /** Quota windows currently shown to the operator. */
  quotaWindows: RuntimeHealthQuotaWindow[];
  /** Model routes that are currently being served by a fallback. */
  fallbackRoutes: RuntimeHealthFallbackRoute[];
  /**
   * Scheduler continuation runs: which subscription each run is on, which ones it has
   * proven spent, and the instant it may move again. This is the section that shows a
   * hand-off and a resume -- the circuits above say a provider is fenced, not that the
   * scheduler went somewhere else and came back on the vendor's own clock.
   */
  continuationRuns: RuntimeHealthContinuationRun[];
  /** Truncated before export; a long list means the preview is not the whole story. */
  notes: string[];
}

export interface RuntimeHealthQuotaCircuit {
  providerId: string;
  openedAt: string;
  until: string;
  failures: number;
  reason: string;
  resetSource: "vendor" | "retry-after" | "estimated";
}

export interface RuntimeHealthQuotaWindow {
  key: string;
  label?: string;
  provider?: string;
  remainingPercent: number | null;
  resetsAt: string | null;
  /** True while the window is still "starts on first use" and has no anchor. */
  waitingForFirstUse?: boolean;
  gatedBy?: string | null;
}

export interface RuntimeHealthFallbackRoute {
  requestedProviderId: string;
  servingProviderId: string;
  reason: string;
  until: string;
}

export interface RuntimeHealthContinuationRun {
  projectPath: string;
  occurrence: string;
  state: string;
  /** The subscription account the run is on now; the previous ones are in `blocked`. */
  runnerId: string;
  /** Subscriptions the vendor was proven to have spent, newest last. */
  // `resetHint`, not `resetText`: redaction drops any key containing "text", so the vendor's
  // own reset wording would be silently cut. Keep the name off that list.
  blocked: { runnerId: string; window: string; resetHint: string | null }[];
  /** The next moment the run is allowed to try again. */
  nextAt: string;
  /** The instant the preferred subscription is due back; set once the run gave it up. */
  preferredReadyAt?: string;
  outcome?: string;
}

export const RUNTIME_HEALTH_SNAPSHOT_VERSION = 2;

/** Keys whose values never belong in a shared artefact, whatever the caller passes. */
const FORBIDDEN_KEY_PATTERN =
  /(token|secret|api[-_]?key|apikey|password|passphrase|credential|authorization|auth[-_]?header|cookie|session[-_]?id|private[-_]?key|access[-_]?key|refresh[-_]?key|bearer|message[-_]?body|chat[-_]?(content|history|message)|prompt|transcript|mail|body|text|content|message)/i;

/** Longest string kept verbatim; anything longer is truncated with a visible marker. */
export const RUNTIME_HEALTH_MAX_STRING = 120;

export const RUNTIME_HEALTH_TRUNCATED_SUFFIX = "…(truncated)";

/** Deepest nesting kept: the widest shape is a run inside `continuationRuns`, then its `blocked` entries. */
const MAX_REDACT_DEPTH = 5;

function redactValue(value: unknown, depth: number): unknown {
  if (depth > MAX_REDACT_DEPTH) return null;
  if (value === null || typeof value === "number") {
    return typeof value === "number" && !Number.isFinite(value) ? null : value;
  }
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    return value.length > RUNTIME_HEALTH_MAX_STRING
      ? `${value.slice(0, RUNTIME_HEALTH_MAX_STRING)}${RUNTIME_HEALTH_TRUNCATED_SUFFIX}`
      : value;
  }
  if (Array.isArray(value)) return value.slice(0, 64).map((item) => redactValue(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEY_PATTERN.test(key)) continue;
      out[key] = redactValue(item, depth + 1);
    }
    return out;
  }
  // Functions, symbols, bigints: nothing a snapshot can use.
  return null;
}

/**
 * Strips credential-shaped and message-shaped fields, caps strings and array lengths.
 *
 * Applied to the finished snapshot rather than trusted at each call site, so a future
 * counter that registers a leaky field name is still cut here.
 */
export function redactRuntimeHealthSnapshot(
  snapshot: RuntimeHealthSnapshot,
): RuntimeHealthSnapshot {
  return redactValue(snapshot, 0) as RuntimeHealthSnapshot;
}

export function formatRuntimeHealthSnapshot(snapshot: RuntimeHealthSnapshot): string {
  return `${JSON.stringify(redactRuntimeHealthSnapshot(snapshot), null, 2)}\n`;
}
