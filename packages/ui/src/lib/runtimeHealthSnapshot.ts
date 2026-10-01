/**
 * Live runtime-health snapshot for the renderer (T-164 / SRC-116).
 *
 * Assembles what {@link RuntimeHealthSnapshot} declares from the live surfaces that
 * already exist -- the memory-diagnostics registry, `performance.memory`, the engine
 * bridge's quota windows, and the process-local provider quota circuits. It is a read:
 * it starts nothing, schedules nothing, and never throws into the caller, so it is safe
 * to hit from a settings button while the app is already degraded.
 */
import {
  RUNTIME_HEALTH_SNAPSHOT_VERSION,
  formatRuntimeHealthSnapshot,
  listProviderQuotaCircuits,
  redactRuntimeHealthSnapshot,
  type RuntimeHealthFallbackRoute,
  type RuntimeHealthQuotaCircuit,
  type RuntimeHealthQuotaWindow,
  type RuntimeHealthSnapshot,
} from "@zcode/shared";
import { readEventLoopLagMs, uiMemoryDiagnosticsRegistry } from "./memoryDiagnostics.js";
import { readZaicodeEnginesState } from "@/zaicode/zaicodeEngines.js";
import { useZaicodeToasts } from "@/zaicode/zaicodeNotifications.js";
import { zaicodeAutoRetryAttempts } from "@/zaicode/zaicodeAutoRetry.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useTaskQueryCacheStore } from "@/store/taskQueryCacheStore.js";

export interface RuntimeHealthSnapshotInput {
  now?: number;
  startedAt?: number;
  appVersion?: string;
  processMemory?: { rssBytes?: number; heapUsedBytes?: number; heapTotalBytes?: number };
  readCounters?: () => Record<string, number>;
  readEventLoopLagMs?: () => number | undefined;
  readQuotaCircuits?: () => RuntimeHealthQuotaCircuit[];
  readQuotaWindows?: () => RuntimeHealthQuotaWindow[];
  readFallbackRoutes?: () => RuntimeHealthFallbackRoute[];
  readCountersSummary?: () => Record<string, number>;
  notes?: string[];
}

function isoOrNull(epochMs: number | null | undefined): string | null {
  return typeof epochMs === "number" && Number.isFinite(epochMs)
    ? new Date(epochMs).toISOString()
    : null;
}

function readRendererHeap(): { heapUsedBytes?: number; heapTotalBytes?: number } {
  if (typeof performance === "undefined") return {};
  const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number; totalJSHeapSize?: number } })
    .memory;
  if (!memory || typeof memory.usedJSHeapSize !== "number") return {};
  return {
    heapUsedBytes: memory.usedJSHeapSize,
    ...(typeof memory.totalJSHeapSize === "number" ? { heapTotalBytes: memory.totalJSHeapSize } : {}),
  };
}

function collectLiveQuotaCircuits(now: number): RuntimeHealthQuotaCircuit[] {
  return listProviderQuotaCircuits(now).map((circuit) => ({
    providerId: circuit.providerId,
    openedAt: isoOrNull(circuit.openedAt) ?? "",
    until: isoOrNull(circuit.until) ?? "",
    failures: circuit.failures,
    reason: circuit.reason,
    resetSource: circuit.resetSource,
  }));
}

function collectLiveQuotaWindows(): RuntimeHealthQuotaWindow[] {
  const state = readZaicodeEnginesState();
  const windows: RuntimeHealthQuotaWindow[] = [];
  for (const account of state.accounts ?? []) {
    const snapshot = state.limits?.[account.id];
    for (const window of snapshot?.windows ?? []) {
      windows.push({
        key: window.key,
        label: window.label,
        provider: account.id,
        remainingPercent: window.remainingPercent,
        resetsAt: isoOrNull(window.resetsAt),
        waitingForFirstUse: window.startsOnUse === true && window.rollingFrom === undefined,
        gatedBy: window.gatedBy ?? null,
      });
    }
  }
  return windows;
}

/**
 * Counts the accumulations a degradation report has to name. Registered providers already
 * cover most of them; these two are direct reads so the snapshot is useful even if a
 * module was never imported in this session.
 */
function collectHotCacheSummary(): Record<string, number> {
  const session = useZCodeSessionStore.getState();
  const query = useTaskQueryCacheStore.getState();
  let workspaces = 0;
  let taskUi = 0;
  for (const key of Object.keys(session.workspaces)) {
    workspaces += 1;
    taskUi += Object.keys(session.workspaces[key]?.taskUiByTaskId ?? {}).length;
  }
  let queryKeys = 0;
  for (const key of Object.keys(query.resultsByQueryKey)) queryKeys += 1;
  return {
    "hot.workspaces": workspaces,
    "hot.taskUi": taskUi,
    "hot.queryKeys": queryKeys,
    "hot.toasts": useZaicodeToasts.getState().toasts.length,
  };
}

/** Retry attempts are the visible trace of B6 in action; a climbing count is a symptom. */
function collectPendingRetries(): Record<string, number> {
  let max = 0;
  for (const key of Object.keys(useZCodeSessionStore.getState().workspaces)) {
    const workspace = useZCodeSessionStore.getState().workspaces[key];
    for (const taskId of Object.keys(workspace?.taskRuntimeByTaskId ?? {})) {
      max = Math.max(max, zaicodeAutoRetryAttempts(taskId));
    }
  }
  return { "retry.maxAttempts": max };
}

function collectFallbackRoutes(now: number): RuntimeHealthFallbackRoute[] {
  // Fallback is resolved per dispatch, not stored on a surface, so the snapshot reports
  // the circuits that would force it rather than pretending to know the last one served.
  return listProviderQuotaCircuits(now).map((circuit) => ({
    requestedProviderId: circuit.providerId,
    servingProviderId: circuit.providerId,
    reason: "circuit-open",
    until: isoOrNull(circuit.until) ?? "",
  }));
}

/**
 * Builds a snapshot from live renderer state.
 *
 * Every source is optional so a test (or a web session with no engine bridge) can supply
 * only what it cares about; the result is redacted before it is returned, never after.
 */
export function buildRuntimeHealthSnapshot(
  input: RuntimeHealthSnapshotInput = {},
): RuntimeHealthSnapshot {
  const now = input.now ?? Date.now();
  const eventLoopLagMs = input.readEventLoopLagMs?.();
  const counters: Record<string, number> = {
    ...(input.readCountersSummary?.() ?? {}),
    ...collectHotCacheSummary(),
    ...collectPendingRetries(),
  };
  for (const [key, value] of Object.entries(input.readCounters?.() ?? {})) {
    if (typeof value === "number" && Number.isFinite(value)) counters[key] = value;
  }

  const snapshot: RuntimeHealthSnapshot = {
    version: RUNTIME_HEALTH_SNAPSHOT_VERSION,
    takenAt: new Date(now).toISOString(),
    app: {
      ...(input.appVersion === undefined ? {} : { version: input.appVersion }),
      ...(typeof navigator === "undefined"
        ? {}
        : { platform: `${navigator.platform ?? "unknown"} ${navigator.userAgent ?? ""}`.trim() }),
      uptimeSeconds:
        input.startedAt === undefined ? 0 : Math.max(0, Math.round((now - input.startedAt) / 1000)),
    },
    memory: {
      ...(input.processMemory?.rssBytes === undefined
        ? {}
        : { rssBytes: input.processMemory.rssBytes }),
      ...(input.processMemory?.heapUsedBytes === undefined
        ? {}
        : { heapUsedBytes: input.processMemory.heapUsedBytes }),
      ...(input.processMemory?.heapTotalBytes === undefined
        ? {}
        : { heapTotalBytes: input.processMemory.heapTotalBytes }),
      ...readRendererHeap(),
    },
    ...(eventLoopLagMs === undefined ? {} : { eventLoopLagMs }),
    counters,
    quotaCircuits: input.readQuotaCircuits?.() ?? collectLiveQuotaCircuits(now),
    quotaWindows: input.readQuotaWindows?.() ?? collectLiveQuotaWindows(),
    fallbackRoutes: input.readFallbackRoutes?.() ?? collectFallbackRoutes(now),
    notes: input.notes ?? [],
  };

  return redactRuntimeHealthSnapshot(snapshot);
}

export { uiMemoryDiagnosticsRegistry };

/** When this renderer bundle started, so a snapshot can report real uptime. */
const RENDERER_STARTED_AT = Date.now();

/**
 * The entry point a UI surface calls: live renderer state, this process's counters, and
 * the last measured event-loop lag, redacted and ready to serialise.
 */
export function readRuntimeHealthSnapshot(): RuntimeHealthSnapshot {
  return buildRuntimeHealthSnapshot({
    startedAt: RENDERER_STARTED_AT,
    readCounters: () => uiMemoryDiagnosticsRegistry.collect(),
    readEventLoopLagMs,
  });
}

export function readRuntimeHealthSnapshotJson(): string {
  return formatRuntimeHealthSnapshot(readRuntimeHealthSnapshot());
}
