/**
 * Capture metrics for the drift capture center.
 *
 * The capture is a background task: it must never be invisible. This collects
 * what the renderer can observe without inventing anything: long tasks, peak
 * heap, foreground input latency, plus the plain work counters (snapshot
 * bytes, throughput, time spent waiting on the Host).
 *
 * The Host does not expose a CPU counter to the renderer on this build, so
 * there is no CPU number here: `hostIoMs` is the time the capture spent
 * waiting for Host file and session calls, which is what the Host cost the
 * renderer, not a claim about its CPU.
 */

export interface DriftCaptureMetrics {
  /** Wall clock duration of the measured window. */
  durationMs: number;
  sessions: number;
  /** Bytes actually written for the captured evidence. */
  snapshotBytes: number;
  bytesPerSecond: number;
  sessionsPerSecond: number;
  /** Renderer long tasks (>50 ms) observed inside the window. */
  rendererLongTasks: number;
  rendererLongTaskMs: number;
  /** Peak renderer JS heap observed inside the window. */
  peakRendererHeapBytes?: number;
  /** P95 of the foreground input event durations observed inside the window. */
  inputLatencyP95Ms?: number;
  inputLatencySamples: number;
  /** Time the capture spent waiting for Host file and session calls. */
  hostIoMs: number;
}

export interface DriftCaptureMetricsCollector {
  start(): void;
  /** Record a committed session and the bytes it wrote. */
  observeSession(bytes: number): void;
  /** Record time spent waiting on the Host. */
  observeHostIo(ms: number): void;
  stop(): DriftCaptureMetrics;
}

interface PerformanceObserverLike {
  observe(options: { type: string; buffered?: boolean; durationThreshold?: number }): void;
  disconnect(): void;
}

function readHeapBytes(): number | undefined {
  if (typeof performance === "undefined") return undefined;
  const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
  if (!memory || typeof memory.usedJSHeapSize !== "number") return undefined;
  return memory.usedJSHeapSize;
}

function percentile(values: readonly number[], fraction: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

function createObserver(
  type: string,
  onEntry: (entry: { duration?: number }) => void,
  options?: { durationThreshold?: number },
): PerformanceObserverLike | undefined {
  const Observer = (
    globalThis as { PerformanceObserver?: new (cb: unknown) => PerformanceObserverLike }
  ).PerformanceObserver;
  if (!Observer) return undefined;
  try {
    const observer = new Observer((list: { getEntries(): Array<{ duration?: number }> }) => {
      for (const entry of list.getEntries()) onEntry(entry);
    });
    observer.observe({
      type,
      buffered: false,
      ...(options?.durationThreshold !== undefined
        ? { durationThreshold: options.durationThreshold }
        : {}),
    });
    return observer;
  } catch {
    // An unsupported entry type is not an error: the metric stays absent.
    return undefined;
  }
}

export function createDriftCaptureMetricsCollector(options?: {
  now?: () => number;
}): DriftCaptureMetricsCollector {
  const now = options?.now ?? (() => Date.now());
  let startedAt: number | undefined;
  let sessions = 0;
  let snapshotBytes = 0;
  let hostIoMs = 0;
  let longTasks = 0;
  let longTaskMs = 0;
  let peakHeapBytes: number | undefined;
  const inputLatencies: number[] = [];

  const longTaskObserver = createObserver("longtask", (entry) => {
    longTasks += 1;
    longTaskMs += entry.duration ?? 0;
  });
  const inputObserver = createObserver(
    "event",
    (entry) => {
      if (typeof entry.duration === "number") inputLatencies.push(entry.duration);
    },
    { durationThreshold: 16 },
  );

  const sampleHeap = () => {
    const heap = readHeapBytes();
    if (heap !== undefined && (peakHeapBytes === undefined || heap > peakHeapBytes)) {
      peakHeapBytes = heap;
    }
  };

  return {
    start() {
      startedAt = now();
      sampleHeap();
    },
    observeSession(bytes) {
      sessions += 1;
      snapshotBytes += Math.max(0, Math.trunc(bytes));
      sampleHeap();
    },
    observeHostIo(ms) {
      hostIoMs += Math.max(0, ms);
    },
    stop() {
      sampleHeap();
      longTaskObserver?.disconnect();
      inputObserver?.disconnect();
      const durationMs = startedAt === undefined ? 0 : Math.max(0, now() - startedAt);
      const seconds = durationMs / 1000;
      const p95 = percentile(inputLatencies, 0.95);
      const metrics: DriftCaptureMetrics = {
        durationMs,
        sessions,
        snapshotBytes,
        bytesPerSecond: seconds > 0 ? Math.round(snapshotBytes / seconds) : 0,
        sessionsPerSecond: seconds > 0 ? Math.round((sessions / seconds) * 100) / 100 : 0,
        rendererLongTasks: longTasks,
        rendererLongTaskMs: Math.round(longTaskMs * 100) / 100,
        inputLatencySamples: inputLatencies.length,
        hostIoMs: Math.round(hostIoMs * 100) / 100,
        ...(peakHeapBytes !== undefined ? { peakRendererHeapBytes: peakHeapBytes } : {}),
        ...(p95 !== undefined ? { inputLatencyP95Ms: p95 } : {}),
      };
      startedAt = undefined;
      return metrics;
    },
  };
}
