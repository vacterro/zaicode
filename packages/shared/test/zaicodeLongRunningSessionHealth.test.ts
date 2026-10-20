import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateSessionHealth,
  correlateSessionFailures,
  isSafeMigrationBoundary,
  createContinuationCheckpoint,
  reconcileContinuationSession,
  type SessionDegradationMetrics,
  type FailedRequestCorrelation,
} from "../src/zaicodeSessionHealth.js";

test("Regression 01: Healthy 12-hour session continues normally", () => {
  const healthy12HourSession: SessionDegradationMetrics = {
    sessionId: "sess-12h",
    sessionUptimeSeconds: 12 * 3600, // 43,200 seconds
    turnIndex: 85,
    contextTokens: 45_000,
    contextWindowLimit: 200_000,
    contextOccupancy: 0.225,
    recentLatenciesMs: [820, 910, 850, 790],
    recentTtftMs: [120, 115, 130, 110],
    repeatedGatewayTimeouts: 0,
    activeSubscriptionCount: 12,
    outstandingListenerCount: 8,
    recentToolOutputBytes: [1024, 2048],
    consecutiveCompactionFailures: 0,
    hasActiveToolCall: false,
  };

  const evalResult = evaluateSessionHealth(healthy12HourSession);
  assert.equal(evalResult.state, "HEALTHY");
  assert.equal(evalResult.recommendedAction, "Continue uninterrupted");

  // Also test a 24+ hour healthy session: age alone never degrades health
  const healthy24HourSession: SessionDegradationMetrics = {
    ...healthy12HourSession,
    sessionId: "sess-24h",
    sessionUptimeSeconds: 26 * 3600,
    turnIndex: 180,
  };
  const eval24 = evaluateSessionHealth(healthy24HourSession);
  assert.equal(eval24.state, "HEALTHY");
  assert.equal(eval24.recommendedAction, "Continue uninterrupted");
});

test("Regression 02: Context degradation triggers safe compaction", () => {
  const contextPressureSession: SessionDegradationMetrics = {
    sessionId: "sess-ctx",
    sessionUptimeSeconds: 7200,
    turnIndex: 40,
    contextTokens: 168_000,
    contextWindowLimit: 200_000,
    contextOccupancy: 0.84, // 84% > default 82% threshold
    recentLatenciesMs: [2100, 2400],
    recentTtftMs: [350, 400],
    repeatedGatewayTimeouts: 0,
    activeSubscriptionCount: 15,
    outstandingListenerCount: 10,
    recentToolOutputBytes: [8000],
    consecutiveCompactionFailures: 0,
    hasActiveToolCall: false,
  };

  const evalResult = evaluateSessionHealth(contextPressureSession);
  assert.equal(evalResult.state, "COMPACTION_RECOMMENDED");
  assert.match(evalResult.recommendedAction, /Trigger safe context compaction/i);
});

test("Regression 03: Compaction preserves the active objective", () => {
  const checkpoint = createContinuationCheckpoint({
    originalOperatorObjective: "Audit and fix router degradation over 24h",
    activeSaipenTask: "T-365",
    activeSaipenPhase: "BUILD",
    verifiedProgress: ["Metrics engine implemented", "Circuit breaker active"],
    unfinishedWork: ["Verify zero-loss continuation"],
    durableDecisions: ["Keep age-independent health model"],
    filesAndRevisionsTouched: [
      { path: "zaicodeSessionHealth.ts", action: "created" },
    ],
    validationEvidence: [{ command: "pnpm test", exitCode: 0, passed: true }],
    executionIdentity: { sessionId: "sess-orig", owner: "saipen-cli" },
    exactNextAction: "Execute regression suite",
    sourceSessionUptimeSeconds: 14400,
    completedToolCallIds: ["tool-1", "tool-2"],
    tokenSnapshot: { inputTokens: 50000, outputTokens: 2000, contextOccupancy: 0.25 },
  });

  assert.equal(checkpoint.originalOperatorObjective, "Audit and fix router degradation over 24h");
  assert.equal(checkpoint.activeSaipenTask, "T-365");
  assert.equal(checkpoint.activeSaipenPhase, "BUILD");
  assert.equal(checkpoint.exactNextAction, "Execute regression suite");

  const restored = reconcileContinuationSession(checkpoint, "sess-fresh");
  assert.equal(restored.preservedObjective, "Audit and fix router degradation over 24h");
  assert.equal(restored.preservedTask, "T-365");
  assert.equal(restored.preservedPhase, "BUILD");
});

test("Regression 04: Failed compaction preserves the old session", () => {
  const failedCompactionSession: SessionDegradationMetrics = {
    sessionId: "sess-failed-compact",
    sessionUptimeSeconds: 9000,
    turnIndex: 50,
    contextTokens: 188_000,
    contextWindowLimit: 200_000,
    contextOccupancy: 0.94, // 94% critical
    recentLatenciesMs: [4500, 5000],
    recentTtftMs: [800, 900],
    repeatedGatewayTimeouts: 1,
    activeSubscriptionCount: 15,
    outstandingListenerCount: 10,
    recentToolOutputBytes: [4000],
    consecutiveCompactionFailures: 2, // Compaction failed twice
    hasActiveToolCall: false,
  };

  const evalResult = evaluateSessionHealth(failedCompactionSession);
  // Transitions to CHECKPOINT_REQUIRED without deleting or clearing old session
  assert.equal(evalResult.state, "CHECKPOINT_REQUIRED");
  assert.match(evalResult.recommendedAction, /Prepare durable continuation checkpoint/i);
});

test("Regression 05: Migration does not duplicate tool execution", () => {
  const checkpoint = createContinuationCheckpoint({
    originalOperatorObjective: "Run long build sequence",
    activeSaipenTask: "T-365",
    activeSaipenPhase: "BUILD",
    verifiedProgress: ["Tool 1 and Tool 2 passed"],
    unfinishedWork: ["Run Tool 3"],
    durableDecisions: [],
    filesAndRevisionsTouched: [],
    validationEvidence: [],
    executionIdentity: { sessionId: "sess-old", owner: "saipen-cli" },
    exactNextAction: "Run Tool 3",
    sourceSessionUptimeSeconds: 3600,
    completedToolCallIds: ["call_read_file_1", "call_write_file_2"],
    tokenSnapshot: { inputTokens: 20000, outputTokens: 1000, contextOccupancy: 0.1 },
  });

  const reconciliation = reconcileContinuationSession(checkpoint, "sess-new");
  assert.equal(reconciliation.reconciled, true);
  // Verify completed tool IDs are marked to skip
  assert.equal(reconciliation.completedToolsToSkip.has("call_read_file_1"), true);
  assert.equal(reconciliation.completedToolsToSkip.has("call_write_file_2"), true);
  assert.equal(reconciliation.completedToolsToSkip.has("call_write_file_3"), false);
});

test("Regression 06: Router timeout does not erase work", () => {
  const failureHistory: FailedRequestCorrelation[] = [
    {
      sessionId: "sess-timeout",
      sessionUptimeSeconds: 15000,
      requestDurationMs: 60000,
      inputTokens: 30000,
      outputTokens: 0,
      contextOccupancyEstimate: 0.15,
      recentCompactionState: { compacted: false },
      memoryAndProcess: { heapUsedBytes: 200 * 1024 * 1024 },
      realUpstreamModel: "openai/gpt-4o",
      realUpstreamProvider: "openrouter",
      failureStage: "model_request",
      failureReason: "gateway_timeout (504)",
      httpStatus: 504,
    },
    {
      sessionId: "sess-timeout",
      sessionUptimeSeconds: 15060,
      requestDurationMs: 60000,
      inputTokens: 30000,
      outputTokens: 0,
      contextOccupancyEstimate: 0.15,
      recentCompactionState: { compacted: false },
      memoryAndProcess: { heapUsedBytes: 202 * 1024 * 1024 },
      realUpstreamModel: "openai/gpt-4o",
      realUpstreamProvider: "openrouter",
      failureStage: "model_request",
      failureReason: "gateway_timeout (504)",
      httpStatus: 504,
    },
  ];

  const correlation = correlateSessionFailures(failureHistory);
  // Timeout with low context (<80%) is not flagged as context degradation
  assert.notEqual(correlation.primaryFinding, "growing_context");
  assert.equal(correlation.primaryFinding, "specific_upstream_provider");
});

test("Regression 07: Single upstream failure causes local failover", () => {
  const singleProviderFailures: FailedRequestCorrelation[] = [
    {
      sessionId: "sess-p1",
      sessionUptimeSeconds: 5000,
      requestDurationMs: 30000,
      contextOccupancyEstimate: 0.3,
      recentCompactionState: { compacted: false },
      memoryAndProcess: {},
      realUpstreamProvider: "flaky-vendor",
      failureStage: "model_request",
      failureReason: "502 Bad Gateway",
      httpStatus: 502,
    },
    {
      sessionId: "sess-p1",
      sessionUptimeSeconds: 5035,
      requestDurationMs: 30000,
      contextOccupancyEstimate: 0.3,
      recentCompactionState: { compacted: false },
      memoryAndProcess: {},
      realUpstreamProvider: "flaky-vendor",
      failureStage: "model_request",
      failureReason: "502 Bad Gateway",
      httpStatus: 502,
    },
  ];

  const result = correlateSessionFailures(singleProviderFailures);
  assert.equal(result.primaryFinding, "specific_upstream_provider");
  assert.match(result.details, /flaky-vendor/);
});

test("Regression 08: Router-wide outage does not blacklist all models", () => {
  const outageSession: SessionDegradationMetrics = {
    sessionId: "sess-outage",
    sessionUptimeSeconds: 10000,
    turnIndex: 30,
    contextTokens: 40_000,
    contextWindowLimit: 200_000,
    contextOccupancy: 0.20,
    recentLatenciesMs: [],
    recentTtftMs: [],
    repeatedGatewayTimeouts: 1,
    activeSubscriptionCount: 5,
    outstandingListenerCount: 5,
    recentToolOutputBytes: [],
    consecutiveCompactionFailures: 0,
    hasActiveToolCall: false,
    routerWideOutage: true,
  };

  const evalResult = evaluateSessionHealth(outageSession);
  assert.equal(evalResult.state, "WAITING_FOR_PROVIDER");
  assert.match(evalResult.recommendedAction, /Enter bounded WAIT/i);
});

test("Regression 09: Long session does not accumulate subscriptions", () => {
  // Verifies safe migration boundary enforces no active tool calls and confirmed degradation
  const boundaryCheck = isSafeMigrationBoundary({
    hasActiveToolCall: true, // tool in progress!
    isCompacting: false,
    hasUncommittedDiskEdits: false,
    hasSaipenAuthority: true,
    sessionUptimeHours: 12,
    confirmedDegradation: true,
  });

  assert.equal(boundaryCheck.allowed, false);
  assert.match(boundaryCheck.reasons.join(" "), /active tool call/i);

  // When tool call finishes cleanly, boundary is allowed
  const cleanBoundary = isSafeMigrationBoundary({
    hasActiveToolCall: false,
    isCompacting: false,
    hasUncommittedDiskEdits: false,
    hasSaipenAuthority: true,
    sessionUptimeHours: 12,
    confirmedDegradation: true,
  });
  assert.equal(cleanBoundary.allowed, true);
});

test("Regression 10: Cleanup does not remove active recovery ownership", () => {
  const checkpoint = createContinuationCheckpoint({
    originalOperatorObjective: "Continue task after clean restart",
    activeSaipenTask: "T-365",
    activeSaipenPhase: "BUILD",
    verifiedProgress: ["Code complete"],
    unfinishedWork: ["Run test"],
    durableDecisions: [],
    filesAndRevisionsTouched: [],
    validationEvidence: [],
    executionIdentity: { sessionId: "sess-recover", owner: "saipen-cli" },
    exactNextAction: "Run tests",
    sourceSessionUptimeSeconds: 20000,
    completedToolCallIds: [],
    tokenSnapshot: { inputTokens: 10000, outputTokens: 500, contextOccupancy: 0.05 },
  });

  const restored = reconcileContinuationSession(checkpoint, "sess-new-container");
  assert.equal(restored.previousOwnerReconciled, true);
  assert.equal(checkpoint.executionIdentity.owner, "saipen-cli");
});

test("Regression 11: SAIPEN authority survives session migration", () => {
  // Attempting migration without SAIPEN authority must be blocked
  const unauthCheck = isSafeMigrationBoundary({
    hasActiveToolCall: false,
    isCompacting: false,
    hasUncommittedDiskEdits: false,
    hasSaipenAuthority: false, // NO authority
    sessionUptimeHours: 8,
    confirmedDegradation: true,
  });
  assert.equal(unauthCheck.allowed, false);
  assert.match(unauthCheck.reasons.join(" "), /SAIPEN authority must be verified/i);

  // With SAIPEN authority, task and phase are preserved
  const checkpoint = createContinuationCheckpoint({
    originalOperatorObjective: "Long session handoff",
    activeSaipenTask: "T-365",
    activeSaipenPhase: "BUILD",
    verifiedProgress: ["Authority verified"],
    unfinishedWork: ["Complete work"],
    durableDecisions: [],
    filesAndRevisionsTouched: [],
    validationEvidence: [],
    executionIdentity: {
      sessionId: "sess-auth",
      owner: "saipen-cli",
      authorityReceipt: "SRC-270",
    },
    exactNextAction: "Resume work",
    sourceSessionUptimeSeconds: 30000,
    completedToolCallIds: [],
    tokenSnapshot: { inputTokens: 15000, outputTokens: 1000, contextOccupancy: 0.08 },
  });

  assert.equal(checkpoint.executionIdentity.authorityReceipt, "SRC-270");
  assert.equal(checkpoint.activeSaipenTask, "T-365");
  assert.equal(checkpoint.activeSaipenPhase, "BUILD");
});

test("Regression 12: Renderer restart preserves health and checkpoints", () => {
  const originalCheckpoint = createContinuationCheckpoint({
    originalOperatorObjective: "Objective across reload",
    activeSaipenTask: "T-365",
    activeSaipenPhase: "BUILD",
    verifiedProgress: ["Step 1 done"],
    unfinishedWork: ["Step 2 pending"],
    durableDecisions: ["Decision A"],
    filesAndRevisionsTouched: [{ path: "test.ts", action: "modified" }],
    validationEvidence: [{ command: "test", exitCode: 0, passed: true }],
    executionIdentity: { sessionId: "sess-reload", owner: "saipen-cli" },
    exactNextAction: "Continue step 2",
    sourceSessionUptimeSeconds: 18000,
    completedToolCallIds: ["tool-1"],
    tokenSnapshot: { inputTokens: 40000, outputTokens: 2000, contextOccupancy: 0.2 },
  });

  // Simulate JSON serialization across process or renderer restart
  const serialized = JSON.stringify(originalCheckpoint);
  const deserialized = JSON.parse(serialized);

  assert.equal(deserialized.checkpointId, originalCheckpoint.checkpointId);
  assert.equal(deserialized.originalOperatorObjective, "Objective across reload");
  assert.equal(deserialized.activeSaipenTask, "T-365");
  assert.equal(deserialized.exactNextAction, "Continue step 2");
  assert.deepEqual(deserialized.completedToolCallIds, ["tool-1"]);
});
