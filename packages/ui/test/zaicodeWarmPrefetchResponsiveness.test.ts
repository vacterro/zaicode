import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionDataLayer } from "../src/v4/sessionDataLayer.js";
import { adaptivePrefetchCoordinator } from "../src/v4/adaptivePrefetchCoordinator.js";
import { retireSessions, isSessionRetired } from "../src/zaicode/zaicodeCleanupFence.js";
import {
  recordSessionClick,
  getSessionClickStartedAt,
} from "../src/lib/sessionOpenArmsTelemetry.js";
import type { ConversationTransport, ConversationFrame, TransportFrameContext, CommandEnvelope, CommandAck } from "@zcode/shared";

function createMockTransport(): ConversationTransport {
  const listeners = new Set<(frame: ConversationFrame, context: TransportFrameContext) => void>();
  return {
    subscribe: async ({ topic }) => ({ ack: { subscriptionId: `sub-${topic}`, openTiming: {} } } as any),
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

test("RESP-01: SessionDataLayer prefetch respects capacity, LRU eviction and pane takeover", async () => {
  const transport = createMockTransport();
  const layer = new SessionDataLayer({ transport, maxWarmCapacity: 2 });

  // 1. Prefetch s1 and s2
  layer.prefetch("s1");
  assert.equal(layer.size, 1);
  await new Promise((r) => setTimeout(r, 10));
  layer.prefetch("s2");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(layer.size, 2);

  // 2. Prefetch s3 triggers eviction of oldest unheld prefetch (s1)
  layer.prefetch("s3");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(layer.size, 2);

  // 3. Pane acquires s2 (promotes from prefetch to pane lease)
  const paneLease = layer.acquire("s2");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(layer.size, 2);

  // 4. Prefetch s4: since s2 is held by a pane, s3 is evicted instead of s2
  layer.prefetch("s4");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(layer.size, 2);

  paneLease.release();
  layer.dispose();
});

test("RESP-02: Remote capacity is capped at 1", () => {
  const transport = createMockTransport();
  const layer = new SessionDataLayer({ transport, isRemote: true });

  layer.prefetch("rem-1");
  assert.equal(layer.size, 1);

  layer.prefetch("rem-2");
  // Evicts rem-1 to stay at capacity 1
  assert.equal(layer.size, 1);

  layer.dispose();
});

test("RESP-03: Retired sessions are never prefetched", () => {
  const transport = createMockTransport();
  const layer = new SessionDataLayer({ transport });

  retireSessions(["retired-session-99"]);
  assert.equal(isSessionRetired("retired-session-99"), true);

  layer.prefetch("retired-session-99");
  assert.equal(layer.size, 0);

  layer.dispose();
});

test("RESP-04: Adaptive prefetch coordinator handles hover debouncing", async () => {
  const transport = createMockTransport();
  const layer = new SessionDataLayer({ transport });

  // Hover candidate
  adaptivePrefetchCoordinator.onCandidateHover(layer, "hover-candidate");
  // Immediately cancel hover (e.g. quick pointer flick)
  adaptivePrefetchCoordinator.cancelHover();

  await new Promise((resolve) => setTimeout(resolve, 100));
  // Nothing prefetched because hover was cancelled before 80ms
  assert.equal(layer.size, 0);

  // Hover candidate and wait 100ms (>80ms debounce)
  adaptivePrefetchCoordinator.onCandidateHover(layer, "hover-candidate");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(layer.size, 1);

  layer.dispose();
});

test("RESP-05: Session open telemetry records click and retrieves timestamp", () => {
  recordSessionClick("sess-telemetry-1");
  const startedAt = getSessionClickStartedAt("sess-telemetry-1");
  assert.notEqual(startedAt, undefined);
  assert.ok(startedAt! > 0);

  // Unknown session has undefined click startedAt
  assert.equal(getSessionClickStartedAt("sess-unknown-xyz"), undefined);
});
