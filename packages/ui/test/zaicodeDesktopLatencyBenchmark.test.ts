import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionDataLayer } from "../src/v4/sessionDataLayer.js";
import { ConversationProjectionStore } from "../src/v4/conversationProjectionStore.js";
import {
  recordSessionClick,
  getSessionClickStartedAt,
} from "../src/lib/sessionOpenArmsTelemetry.js";
import type {
  ConversationTransport,
  ConversationFrame,
  TransportFrameContext,
  CommandEnvelope,
  CommandAck,
} from "@zcode/shared";

function createBenchmarkTransport(simulatedDelayMs = 0): ConversationTransport {
  const listeners = new Set<(frame: ConversationFrame, context: TransportFrameContext) => void>();
  return {
    subscribe: async ({ topic }) => {
      if (simulatedDelayMs > 0) {
        await new Promise((r) => setTimeout(r, simulatedDelayMs));
      }
      return {
        ack: {
          subscriptionId: `sub-${topic}`,
          mode: "snapshot",
          logEpoch: "epoch-1",
          openTiming: {},
        },
      } as any;
    },
    activate: () => {},
    resync: async () => ({} as any),
    unsubscribe: async () => {},
    sendCommand: async (_envelope: CommandEnvelope): Promise<CommandAck> => {
      return { status: "accepted", commandId: _envelope.commandId };
    },
    onFrame: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    attachmentPut: async () => ({ attachmentId: "att-1" }),
    attachmentRead: async () => new Uint8Array(),
    attachmentReadRange: async () => new Uint8Array(),
    fileChanges: async () => ({ changes: [] }),
    fileRewindPreview: async () => ({ patches: [] }),
    workflowRunEvents: async () => ({ events: [], totalCount: 0 }),
    workflowRuns: async () => ({ runs: [] }),
    workflowRunArtifacts: async () => ({ artifacts: [] }),
    workflowRunArtifactData: async () => ({ entries: [] }),
    workflowRunArtifactRead: async () => ({ chunk: new Uint8Array(), eof: true }),
    workflowRunWorkspace: async () => ({ nodes: [] }),
    workflowRunNodeResult: async () => ({ result: "" }),
    onRuntimeRestart: () => () => {},
    onAssemblyFault: () => () => {},
  };
}

interface BenchmarkStats {
  p50: number;
  p95: number;
  p99: number;
  worst: number;
  mean: number;
  samples: number;
}

function calculateStats(samples: number[]): BenchmarkStats {
  const sorted = [...samples].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  const p99 = sorted[Math.floor(sorted.length * 0.99)] ?? 0;
  const worst = sorted[sorted.length - 1] ?? 0;
  const mean = sorted.reduce((sum, v) => sum + v, 0) / sorted.length;
  return { p50, p95, p99, worst, mean, samples: samples.length };
}

test("PERF-01: Hot session switching benchmark (50 iterations) meets P95 <= 100ms", async () => {
  const transport = createBenchmarkTransport();
  const layer = new SessionDataLayer({ transport, maxWarmCapacity: 10 });

  // Pre-warm 5 sessions
  const prewarmed = ["sess-1", "sess-2", "sess-3", "sess-4", "sess-5"];
  for (const s of prewarmed) {
    layer.prefetch(s);
  }
  await new Promise((r) => setTimeout(r, 20));

  const durations: number[] = [];
  const iterations = 50;

  for (let i = 0; i < iterations; i++) {
    const target = prewarmed[i % prewarmed.length]!;
    const t0 = performance.now();
    const lease = layer.acquire(target);
    const t1 = performance.now();
    durations.push(t1 - t0);
    lease.release();
  }

  const stats = calculateStats(durations);
  console.log(`[PERF Hot Switch] P50=${stats.p50.toFixed(2)}ms, P95=${stats.p95.toFixed(2)}ms, P99=${stats.p99.toFixed(2)}ms, Worst=${stats.worst.toFixed(2)}ms (Target P95 <= 100ms)`);

  assert.ok(stats.p95 <= 100, `Hot switch P95 (${stats.p95.toFixed(2)}ms) exceeded target 100ms`);
  layer.dispose();
});

test("PERF-02: Warm session transcript benchmark (50 iterations) meets P95 <= 200ms", async () => {
  const transport = createBenchmarkTransport(5); // 5ms simulated transport latency
  const layer = new SessionDataLayer({ transport, maxWarmCapacity: 10 });

  const durations: number[] = [];
  const iterations = 50;

  for (let i = 0; i < iterations; i++) {
    const id = `warm-transcript-${i % 5}`;
    layer.prefetch(id);
    await new Promise((r) => setTimeout(r, 10));

    const t0 = performance.now();
    const lease = layer.acquire(id);
    const store = lease.store;
    assert.ok(store);
    const t1 = performance.now();
    durations.push(t1 - t0);
    lease.release();
  }

  const stats = calculateStats(durations);
  console.log(`[PERF Warm Transcript] P50=${stats.p50.toFixed(2)}ms, P95=${stats.p95.toFixed(2)}ms, P99=${stats.p99.toFixed(2)}ms, Worst=${stats.worst.toFixed(2)}ms (Target P95 <= 200ms)`);

  assert.ok(stats.p95 <= 200, `Warm transcript P95 (${stats.p95.toFixed(2)}ms) exceeded target 200ms`);
  layer.dispose();
});

test("PERF-03: Cold session opening benchmark (50 iterations) meets P95 <= 100ms", async () => {
  const transport = createBenchmarkTransport();
  const layer = new SessionDataLayer({ transport });

  const durations: number[] = [];
  const iterations = 50;

  for (let i = 0; i < iterations; i++) {
    const id = `cold-session-bench-${i}`;
    const t0 = performance.now();
    const lease = layer.acquire(id);
    const t1 = performance.now();
    durations.push(t1 - t0);
    lease.release();
  }

  const stats = calculateStats(durations);
  console.log(`[PERF Cold Shell] P50=${stats.p50.toFixed(2)}ms, P95=${stats.p95.toFixed(2)}ms, P99=${stats.p99.toFixed(2)}ms, Worst=${stats.worst.toFixed(2)}ms (Target P95 <= 100ms)`);

  assert.ok(stats.p95 <= 100, `Cold session shell P95 (${stats.p95.toFixed(2)}ms) exceeded target 100ms`);
  layer.dispose();
});

test("PERF-04: Routine interaction benchmark meets P95 <= 50ms", async () => {
  const durations: number[] = [];
  const iterations = 50;

  for (let i = 0; i < iterations; i++) {
    const id = `interaction-sess-${i}`;
    const t0 = performance.now();
    recordSessionClick(id);
    const started = getSessionClickStartedAt(id);
    assert.ok(started !== undefined);
    const t1 = performance.now();
    durations.push(t1 - t0);
  }

  const stats = calculateStats(durations);
  console.log(`[PERF Routine Interaction] P50=${stats.p50.toFixed(2)}ms, P95=${stats.p95.toFixed(2)}ms, P99=${stats.p99.toFixed(2)}ms, Worst=${stats.worst.toFixed(2)}ms (Target P95 <= 50ms)`);

  assert.ok(stats.p95 <= 50, `Routine interaction P95 (${stats.p95.toFixed(2)}ms) exceeded target 50ms`);
});
