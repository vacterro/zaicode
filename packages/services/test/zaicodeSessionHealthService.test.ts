import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ZaicodeSessionHealthService } from "../src/zaicode/zaicodeSessionHealthService.js";
import type { SessionDegradationMetrics, FailedRequestCorrelation } from "@zcode/shared";

test("ZaicodeSessionHealthService tracks metrics and evaluates health", () => {
  const service = new ZaicodeSessionHealthService();

  const metrics: SessionDegradationMetrics = {
    sessionId: "svc-sess-1",
    sessionUptimeSeconds: 3600,
    turnIndex: 10,
    contextTokens: 50000,
    contextWindowLimit: 200000,
    contextOccupancy: 0.25,
    recentLatenciesMs: [500, 600],
    recentTtftMs: [100, 110],
    repeatedGatewayTimeouts: 0,
    activeSubscriptionCount: 10,
    outstandingListenerCount: 5,
    recentToolOutputBytes: [1000],
    consecutiveCompactionFailures: 0,
    hasActiveToolCall: false,
  };

  service.updateMetrics(metrics);
  const health = service.evaluateHealth("svc-sess-1");
  assert.equal(health.state, "HEALTHY");
  assert.equal(health.recommendedAction, "Continue uninterrupted");

  // Missing metrics evaluates to UNOBSERVED
  const unobserved = service.evaluateHealth("unobserved-sess");
  assert.equal(unobserved.state, "UNOBSERVED");
  assert.match(unobserved.reasons[0]!, /No Host telemetry measurements recorded/);

  // Context pressure
  service.updateMetrics({
    ...metrics,
    contextOccupancy: 0.85,
  });
  const degradedHealth = service.evaluateHealth("svc-sess-1");
  assert.equal(degradedHealth.state, "COMPACTION_RECOMMENDED");
});

test("ZaicodeSessionHealthService records failure correlations and isolates provider", () => {
  const service = new ZaicodeSessionHealthService();

  const fail1: FailedRequestCorrelation = {
    sessionId: "svc-sess-fail",
    sessionUptimeSeconds: 1000,
    requestDurationMs: 45000,
    contextOccupancyEstimate: 0.2,
    recentCompactionState: { compacted: false },
    memoryAndProcess: {},
    realUpstreamProvider: "bad-upstream",
    failureStage: "model_request",
    failureReason: "504 Gateway Timeout",
    httpStatus: 504,
  };
  const fail2: FailedRequestCorrelation = {
    ...fail1,
    sessionUptimeSeconds: 1050,
  };

  service.recordFailedRequest(fail1);
  service.recordFailedRequest(fail2);

  const correlation = service.getFailureCorrelation("svc-sess-fail");
  assert.equal(correlation.primaryFinding, "specific_upstream_provider");
});

test("ZaicodeSessionHealthService manages checkpoints and migration", () => {
  const service = new ZaicodeSessionHealthService({ allowEphemeralCheckpoints: true });

  const cp = service.saveContinuationCheckpoint({
    originalOperatorObjective: "Complete full run",
    activeSaipenTask: "T-365",
    activeSaipenPhase: "BUILD",
    verifiedProgress: ["Step A"],
    unfinishedWork: ["Step B"],
    durableDecisions: [],
    filesAndRevisionsTouched: [],
    validationEvidence: [],
    executionIdentity: { sessionId: "old-sess", owner: "saipen-cli" },
    exactNextAction: "Execute Step B",
    sourceSessionUptimeSeconds: 7200,
    completedToolCallIds: ["tool-a"],
    tokenSnapshot: { inputTokens: 10000, outputTokens: 500, contextOccupancy: 0.05 },
  });

  assert.ok(cp.checkpointId);

  // Active tool call blocks migration
  const blockedMigration = service.prepareSessionMigration({
    checkpointId: cp.checkpointId,
    oldSessionId: "old-sess",
    newSessionId: "new-sess",
    hasActiveToolCall: true,
    isCompacting: false,
    hasUncommittedEdits: false,
    hasSaipenAuthority: true,
  });
  assert.equal(blockedMigration.success, false);
  assert.match(blockedMigration.error!, /active tool call/i);

  // Set metrics to degraded state so migration is justified
  service.updateMetrics({
    sessionId: "old-sess",
    sessionUptimeSeconds: 7200,
    turnIndex: 30,
    contextTokens: 190000,
    contextWindowLimit: 200000,
    contextOccupancy: 0.95,
    recentLatenciesMs: [],
    recentTtftMs: [],
    repeatedGatewayTimeouts: 3,
    activeSubscriptionCount: 5,
    outstandingListenerCount: 5,
    recentToolOutputBytes: [],
    consecutiveCompactionFailures: 2,
    hasActiveToolCall: false,
  });

  const validMigration = service.prepareSessionMigration({
    checkpointId: cp.checkpointId,
    oldSessionId: "old-sess",
    newSessionId: "new-sess",
    hasActiveToolCall: false,
    isCompacting: false,
    hasUncommittedEdits: false,
    hasSaipenAuthority: true,
  });
  assert.equal(validMigration.success, true);
  assert.ok(validMigration.reconciliation);
  assert.equal(validMigration.reconciliation.completedToolsToSkip.has("tool-a"), true);
});

test("ZaicodeSessionHealthService tracks and cleans up subscriptions without leaks", () => {
  const service = new ZaicodeSessionHealthService();
  let cleanedA = false;
  let cleanedB = false;

  service.trackSubscription("sess-clean", () => {
    cleanedA = true;
  });
  service.trackSubscription("sess-clean", () => {
    cleanedB = true;
  });

  const cleanedCount = service.cleanupSessionSubscriptions("sess-clean");
  assert.equal(cleanedCount, 2);
  assert.equal(cleanedA, true);
  assert.equal(cleanedB, true);
});

test("ZaicodeSessionHealthService writes durable checkpoint to disk with readback integrity", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-checkpoint-test-"));
  try {
    const service = new ZaicodeSessionHealthService({ storageDir: tempDir });
    const cp = service.saveContinuationCheckpoint({
      originalOperatorObjective: "Test durable disk persistence",
      activeSaipenTask: "T-366",
      activeSaipenPhase: "BUILD",
      verifiedProgress: ["Step 1"],
      unfinishedWork: [],
      durableDecisions: [],
      filesAndRevisionsTouched: [],
      validationEvidence: [],
      executionIdentity: { sessionId: "disk-sess", owner: "saipen-cli" },
      exactNextAction: "Verify file on disk",
      sourceSessionUptimeSeconds: 500,
      completedToolCallIds: [],
      tokenSnapshot: { inputTokens: 100, outputTokens: 50, contextOccupancy: 0.01 },
    });

    const expectedFile = path.join(tempDir, "disk-sess", `${cp.checkpointId}.json`);
    assert.equal(fs.existsSync(expectedFile), true);
    const content = JSON.parse(fs.readFileSync(expectedFile, "utf8"));
    assert.equal(content.checkpointId, cp.checkpointId);
    assert.equal(content.activeSaipenTask, "T-366");

    // Failure to write: point to a read-only or invalid file path as directory
    const blockedService = new ZaicodeSessionHealthService({ storageDir: expectedFile }); // using file as dir will fail mkdirSync
    assert.throws(() => {
      blockedService.saveContinuationCheckpoint({
        originalOperatorObjective: "Must fail",
        activeSaipenTask: "T-366",
        activeSaipenPhase: "BUILD",
        verifiedProgress: [],
        unfinishedWork: [],
        durableDecisions: [],
        filesAndRevisionsTouched: [],
        validationEvidence: [],
        executionIdentity: { sessionId: "fail-sess", owner: "saipen-cli" },
        exactNextAction: "Fail",
        sourceSessionUptimeSeconds: 10,
        completedToolCallIds: [],
        tokenSnapshot: { inputTokens: 0, outputTokens: 0, contextOccupancy: 0 },
      });
    }, /DURABLE_CHECKPOINT_WRITE_FAILED/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("ZaicodeSessionHealthService rejects path traversal and unconfigured storageDir", () => {
  const serviceWithoutConfig = new ZaicodeSessionHealthService();
  assert.throws(() => {
    serviceWithoutConfig.saveContinuationCheckpoint({
      originalOperatorObjective: "Test fail",
      activeSaipenTask: "T-367",
      activeSaipenPhase: "BUILD",
      verifiedProgress: [],
      unfinishedWork: [],
      durableDecisions: [],
      filesAndRevisionsTouched: [],
      validationEvidence: [],
      executionIdentity: { sessionId: "sess-1", owner: "saipen-cli" },
      exactNextAction: "Fail",
      sourceSessionUptimeSeconds: 10,
      completedToolCallIds: [],
      tokenSnapshot: { inputTokens: 0, outputTokens: 0, contextOccupancy: 0 },
    });
  }, /storageDir must be configured for durable persistence/);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-traversal-test-"));
  try {
    const serviceWithDir = new ZaicodeSessionHealthService({ storageDir: tempDir });
    assert.throws(() => {
      serviceWithDir.saveContinuationCheckpoint({
        originalOperatorObjective: "Test traversal fail",
        activeSaipenTask: "T-367",
        activeSaipenPhase: "BUILD",
        verifiedProgress: [],
        unfinishedWork: [],
        durableDecisions: [],
        filesAndRevisionsTouched: [],
        validationEvidence: [],
        executionIdentity: { sessionId: "../../../outside", owner: "saipen-cli" },
        exactNextAction: "Fail",
        sourceSessionUptimeSeconds: 10,
        completedToolCallIds: [],
        tokenSnapshot: { inputTokens: 0, outputTokens: 0, contextOccupancy: 0 },
      });
    }, /invalid session identity path traversal/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

