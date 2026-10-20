import assert from "node:assert/strict";
import test from "node:test";
import { useZaicodeSessionHealthStore } from "../src/zaicode/zaicodeSessionHealthStore.js";
import type { SessionDegradationMetrics, FailedRequestCorrelation } from "@zcode/shared";

test("useZaicodeSessionHealthStore records metrics and evaluates session health reactively", () => {
  const store = useZaicodeSessionHealthStore.getState();

  const metrics: SessionDegradationMetrics = {
    sessionId: "store-sess-1",
    sessionUptimeSeconds: 7200,
    turnIndex: 12,
    contextTokens: 60000,
    contextWindowLimit: 200000,
    contextOccupancy: 0.3,
    recentLatenciesMs: [700, 750],
    recentTtftMs: [120, 130],
    repeatedGatewayTimeouts: 0,
    activeSubscriptionCount: 5,
    outstandingListenerCount: 5,
    recentToolOutputBytes: [500],
    consecutiveCompactionFailures: 0,
    hasActiveToolCall: false,
  };

  store.recordMetrics(metrics);
  assert.equal(store.getHealth("store-sess-1"), "HEALTHY");

  // Record failure correlation
  const failure: FailedRequestCorrelation = {
    sessionId: "store-sess-1",
    sessionUptimeSeconds: 7300,
    requestDurationMs: 60000,
    contextOccupancyEstimate: 0.85,
    recentCompactionState: { compacted: false },
    memoryAndProcess: {},
    realUpstreamProvider: "provider-x",
    failureStage: "model_request",
    failureReason: "gateway_timeout (504)",
    httpStatus: 504,
  };
  store.recordFailure(failure);

  const entry = store.getEntry("store-sess-1");
  assert.ok(entry);
  assert.equal(entry.state, "COMPACTION_RECOMMENDED");
  assert.equal(entry.correlations.length, 1);
});

test("useZaicodeSessionHealthStore cleans up subscriptions on session unmount", () => {
  const store = useZaicodeSessionHealthStore.getState();
  let unsubscribed = false;

  const unsub = store.trackSubscription("store-sess-clean", () => {
    unsubscribed = true;
  });

  const cleaned = store.cleanupSession("store-sess-clean");
  assert.equal(cleaned, 1);
  assert.equal(unsubscribed, true);
});
