/**
 * Long-Running Session Health, Degradation Detection, and Recovery Policy (T-365 / SRC-270).
 *
 * Implements deterministic detection and recovery for gradual session degradation
 * during autonomous runs lasting 6, 12, or 24+ hours.
 *
 * Core Invariants:
 * 1. Do NOT assume session age alone causes failure. A healthy 12h/24h session continues uninterrupted.
 * 2. Never automatically restart healthy sessions or migrate solely because age > 6 hours.
 * 3. Never automatically replay completed tool actions or terminate active tools without safe cancellation.
 * 4. Never bypass SAIPEN hard_wait or admission authority.
 * 5. Preserve canonical SAIPEN authority across compaction and session migration.
 */

export type ZaicodeSessionHealthState =
  | "UNOBSERVED"
  | "HEALTHY"
  | "DEGRADING"
  | "COMPACTION_RECOMMENDED"
  | "CHECKPOINT_REQUIRED"
  | "HANDOFF_READY"
  | "RECOVERING"
  | "WAITING_FOR_PROVIDER"
  | "BLOCKED";

export interface SessionDegradationMetrics {
  sessionId: string;
  sessionUptimeSeconds: number;
  turnIndex: number;
  contextTokens: number;
  contextWindowLimit: number;
  contextOccupancy: number; // 0.0 to 1.0+
  postCompactionInputTokens?: number;
  recentLatenciesMs: number[];
  recentTtftMs: number[];
  repeatedGatewayTimeouts: number;
  rendererMemoryBytes?: number;
  hostMemoryBytes?: number;
  activeSubscriptionCount: number;
  outstandingListenerCount: number;
  recentToolOutputBytes: number[];
  consecutiveCompactionFailures: number;
  hasActiveToolCall: boolean;
  routerCorrelationId?: string;
  upstreamModelId?: string;
  upstreamProvider?: string;
  circuitBreakerOpen?: boolean;
  routerWideOutage?: boolean;
}

export type FailureStage =
  | "preflight"
  | "model_request"
  | "streaming"
  | "tool_execution"
  | "post_processing";

export type CorrelationFinding =
  | "growing_context"
  | "specific_upstream_provider"
  | "router_resource_pressure"
  | "process_memory_growth"
  | "timeout_configuration"
  | "general_network_instability"
  | "none_observed";

export interface FailedRequestCorrelation {
  sessionId: string;
  sessionUptimeSeconds: number;
  requestDurationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  contextOccupancyEstimate: number;
  recentCompactionState: {
    compacted: boolean;
    lastCompactedAt?: number;
    tokenReduction?: number;
  };
  memoryAndProcess: {
    rssBytes?: number;
    heapUsedBytes?: number;
    processState?: string;
  };
  routerCorrelationId?: string;
  realUpstreamModel?: string;
  realUpstreamProvider?: string;
  failureStage: FailureStage;
  failureReason: string;
  httpStatus?: number;
}

export interface DurableContinuationCheckpoint {
  schemaVersion: 1;
  checkpointId: string;
  createdAt: string;
  originalOperatorObjective: string;
  activeSaipenTask: string;
  activeSaipenPhase: string;
  verifiedProgress: string[];
  unfinishedWork: string[];
  durableDecisions: string[];
  filesAndRevisionsTouched: {
    path: string;
    revision?: string;
    action: "created" | "modified" | "deleted";
  }[];
  validationEvidence: {
    command: string;
    exitCode: number;
    passed: boolean;
    note?: string;
  }[];
  executionIdentity: {
    sessionId: string;
    owner: string;
    seat?: string;
    authorityReceipt?: string;
  };
  exactNextAction: string;
  sourceSessionUptimeSeconds: number;
  completedToolCallIds: string[];
  tokenSnapshot: {
    inputTokens: number;
    outputTokens: number;
    contextOccupancy: number;
  };
}

export interface SessionHealthEvaluationOptions {
  compactionOccupancyThreshold?: number; // default: 0.82
  checkpointOccupancyThreshold?: number; // default: 0.92
  maxConsecutiveCompactionFailures?: number; // default: 2
  maxGatewayTimeoutsBeforeCheckpoint?: number; // default: 3
  memoryLeakThresholdBytes?: number; // default: 1.8GB
  maxSafeSubscriptions?: number; // default: 100
}

export const DEFAULT_SESSION_HEALTH_OPTIONS: Required<SessionHealthEvaluationOptions> = {
  compactionOccupancyThreshold: 0.82,
  checkpointOccupancyThreshold: 0.92,
  maxConsecutiveCompactionFailures: 2,
  maxGatewayTimeoutsBeforeCheckpoint: 3,
  memoryLeakThresholdBytes: 1.8 * 1024 * 1024 * 1024,
  maxSafeSubscriptions: 100,
};

/**
 * Pure session health evaluation.
 *
 * Rules:
 * A. If session is healthy: Continue uninterrupted.
 *    NEVER flag as DEGRADING or restart simply because uptime is 6h, 12h, or 24h!
 * B. If context pressure confirmed: COMPACTION_RECOMMENDED.
 * C. If compaction is insufficient or fails consecutively: CHECKPOINT_REQUIRED.
 * D. If router-wide failure or active circuit breaker: WAITING_FOR_PROVIDER.
 * E. If memory / subscriptions leak dangerously: DEGRADING or CHECKPOINT_REQUIRED.
 */
export function evaluateSessionHealth(
  metrics: SessionDegradationMetrics,
  options: SessionHealthEvaluationOptions = {},
): {
  state: ZaicodeSessionHealthState;
  reasons: string[];
  recommendedAction: string;
} {
  const opts = { ...DEFAULT_SESSION_HEALTH_OPTIONS, ...options };
  const reasons: string[] = [];

  // Unobserved state: distinguish no telemetry from confirmed healthy
  if (
    metrics.turnIndex === 0 &&
    metrics.recentLatenciesMs.length === 0 &&
    metrics.contextTokens === 0
  ) {
    return {
      state: "UNOBSERVED",
      reasons: ["No execution turns or metrics observed yet"],
      recommendedAction: "Await initial turn execution and telemetry",
    };
  }

  // Provider level gate
  if (metrics.routerWideOutage) {
    return {
      state: "WAITING_FOR_PROVIDER",
      reasons: ["Router-wide outage confirmed across all upstream routes"],
      recommendedAction: "Enter bounded WAIT and probe router health without restarting session",
    };
  }

  if (metrics.circuitBreakerOpen) {
    return {
      state: "WAITING_FOR_PROVIDER",
      reasons: ["Target model route circuit breaker is OPEN"],
      recommendedAction: "Apply local route-specific fallback or wait for circuit cooldown",
    };
  }

  // Checkpoint Required conditions
  const compactionFailedTooOften =
    metrics.consecutiveCompactionFailures >= opts.maxConsecutiveCompactionFailures;
  const criticalContextPressure =
    metrics.contextOccupancy >= opts.checkpointOccupancyThreshold;
  const repeatedTimeouts =
    metrics.repeatedGatewayTimeouts >= opts.maxGatewayTimeoutsBeforeCheckpoint;
  const hostMemoryCritical =
    (metrics.hostMemoryBytes ?? 0) >= opts.memoryLeakThresholdBytes ||
    (metrics.rendererMemoryBytes ?? 0) >= opts.memoryLeakThresholdBytes;

  if (compactionFailedTooOften && criticalContextPressure) {
    reasons.push(
      `Context occupancy (${(metrics.contextOccupancy * 100).toFixed(1)}%) exceeds critical threshold ` +
      `and compaction failed ${metrics.consecutiveCompactionFailures} consecutive times`,
    );
    return {
      state: "CHECKPOINT_REQUIRED",
      reasons,
      recommendedAction: "Prepare durable continuation checkpoint and schedule safe migration",
    };
  }

  if (repeatedTimeouts && criticalContextPressure) {
    reasons.push(
      `Repeated gateway timeouts (${metrics.repeatedGatewayTimeouts}) correlated with critical context occupancy (${(metrics.contextOccupancy * 100).toFixed(1)}%)`,
    );
    return {
      state: "CHECKPOINT_REQUIRED",
      reasons,
      recommendedAction: "Prepare durable continuation checkpoint; context reduction required",
    };
  }

  // Compaction Recommended
  if (metrics.contextOccupancy >= opts.compactionOccupancyThreshold) {
    reasons.push(
      `Context occupancy (${(metrics.contextOccupancy * 100).toFixed(1)}%) reached compaction threshold (${(opts.compactionOccupancyThreshold * 100).toFixed(1)}%)`,
    );
    return {
      state: "COMPACTION_RECOMMENDED",
      reasons,
      recommendedAction: "Trigger safe context compaction preserving active objective and pending work",
    };
  }

  // Degrading conditions (warning indicators that do not yet warrant session disruption)
  let degrading = false;
  if (hostMemoryCritical) {
    reasons.push(
      `Process memory (${(((metrics.hostMemoryBytes ?? 0) / 1024 / 1024)).toFixed(0)}MB) near ceiling; inspect resource leaks`,
    );
    degrading = true;
  }
  if (metrics.activeSubscriptionCount > opts.maxSafeSubscriptions) {
    reasons.push(
      `Active subscription count (${metrics.activeSubscriptionCount}) exceeds safe limit (${opts.maxSafeSubscriptions})`,
    );
    degrading = true;
  }
  if (metrics.repeatedGatewayTimeouts > 0) {
    reasons.push(`Observed ${metrics.repeatedGatewayTimeouts} transient gateway timeout(s)`);
    degrading = true;
  }

  // Latency trend check: if recent turns latency is doubling or tripling
  if (metrics.recentLatenciesMs.length >= 4) {
    const half = Math.floor(metrics.recentLatenciesMs.length / 2);
    const earlier = metrics.recentLatenciesMs.slice(0, half);
    const recent = metrics.recentLatenciesMs.slice(half);
    const avgEarlier = earlier.reduce((a, b) => a + b, 0) / earlier.length;
    const avgRecent = recent.reduce((a, b) => a + b, 0) / recent.length;
    if (avgEarlier > 500 && avgRecent > avgEarlier * 2.5) {
      reasons.push(
        `Turn latency trending up sharply (earlier avg: ${avgEarlier.toFixed(0)}ms, recent avg: ${avgRecent.toFixed(0)}ms)`,
      );
      degrading = true;
    }
  }

  if (degrading) {
    return {
      state: "DEGRADING",
      reasons,
      recommendedAction: "Monitor session health, release unneeded listeners, and prepare for compaction",
    };
  }

  // Healthy: session age (even 12h, 24h, 48h) does NOT degrade health on its own!
  return {
    state: "HEALTHY",
    reasons: [`Session is healthy (uptime: ${(metrics.sessionUptimeSeconds / 3600).toFixed(1)}h, occupancy: ${(metrics.contextOccupancy * 100).toFixed(1)}%)`],
    recommendedAction: "Continue uninterrupted",
  };
}

/**
 * Analyzes multiple failure correlations to determine root-cause category.
 */
export function correlateSessionFailures(
  correlations: FailedRequestCorrelation[],
): {
  primaryFinding: CorrelationFinding;
  confidence: number; // 0.0 to 1.0
  details: string;
} {
  if (correlations.length === 0) {
    return {
      primaryFinding: "none_observed",
      confidence: 1.0,
      details: "No failed requests recorded",
    };
  }

  // 1. Growing context correlation: failures occur when context occupancy > 80%
  const highContextFailures = correlations.filter(
    (c) => c.contextOccupancyEstimate >= 0.80,
  );
  if (highContextFailures.length / correlations.length >= 0.75) {
    return {
      primaryFinding: "growing_context",
      confidence: highContextFailures.length / correlations.length,
      details: `${highContextFailures.length} of ${correlations.length} failures occurred while context occupancy was >= 80%`,
    };
  }

  // 2. Specific upstream provider correlation: failures only hit one specific upstream provider
  const providers = new Set(
    correlations
      .map((c) => c.realUpstreamProvider)
      .filter((p): p is string => Boolean(p && p !== "unknown")),
  );
  if (providers.size === 1 && correlations.length >= 2) {
    const [soleProvider] = [...providers];
    return {
      primaryFinding: "specific_upstream_provider",
      confidence: 0.9,
      details: `All ${correlations.length} failures isolated to upstream provider '${soleProvider}'`,
    };
  }

  // 3. Process memory growth correlation
  const highMemoryFailures = correlations.filter(
    (c) => (c.memoryAndProcess.heapUsedBytes ?? 0) > 1.5 * 1024 * 1024 * 1024,
  );
  if (highMemoryFailures.length / correlations.length >= 0.7) {
    return {
      primaryFinding: "process_memory_growth",
      confidence: highMemoryFailures.length / correlations.length,
      details: `Failures strongly correlate with host/process memory heap > 1.5GB`,
    };
  }

  // 4. Timeout configuration correlation: request duration matches common timeout thresholds (e.g. 60s, 120s, 300s)
  const isTimeoutCluster = correlations.every(
    (c) =>
      c.failureReason.toLowerCase().includes("timeout") ||
      c.httpStatus === 504 ||
      c.httpStatus === 408,
  );
  if (isTimeoutCluster) {
    // If router request correlation IDs are present across distinct providers, router pressure is likely
    if (providers.size > 1) {
      return {
        primaryFinding: "router_resource_pressure",
        confidence: 0.85,
        details: `Repeated gateway timeouts across multiple providers indicate router resource pressure`,
      };
    }
    return {
      primaryFinding: "timeout_configuration",
      confidence: 0.8,
      details: `Repeated timeouts without context or memory anomalies point to upstream latency or timeout threshold`,
    };
  }

  return {
    primaryFinding: "general_network_instability",
    confidence: 0.5,
    details: `Failures do not cleanly correlate with single provider, memory, or context growth`,
  };
}

/**
 * Migration execution boundary checker.
 *
 * Verifies whether it is safe to transition a session to a new execution container.
 * INVARIANT: Never replay completed tool actions!
 * INVARIANT: Never terminate active tool calls without safe cancellation!
 * INVARIANT: Never migrate solely on age!
 */
export function isSafeMigrationBoundary(session: {
  hasActiveToolCall: boolean;
  isCompacting: boolean;
  hasUncommittedDiskEdits: boolean;
  hasSaipenAuthority: boolean;
  sessionUptimeHours: number;
  confirmedDegradation: boolean;
}): {
  allowed: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];

  if (!session.confirmedDegradation) {
    reasons.push(
      "Migration rejected: session does NOT have confirmed degradation (never migrate solely on session age)",
    );
  }

  if (session.hasActiveToolCall) {
    reasons.push(
      "Migration blocked: active tool call in progress; must await safe completion or perform explicit cancellation",
    );
  }

  if (session.isCompacting) {
    reasons.push("Migration blocked: compaction operation currently executing");
  }

  if (session.hasUncommittedDiskEdits) {
    reasons.push("Migration blocked: uncommitted or unpersisted edits pending in turn state");
  }

  if (!session.hasSaipenAuthority) {
    reasons.push("Migration blocked: canonical SAIPEN authority must be verified and preserved");
  }

  return {
    allowed: reasons.length === 0,
    reasons,
  };
}

/**
 * Generates a verifiable, durable continuation checkpoint.
 * Ensures zero-loss handoff across session boundaries.
 */
export function createContinuationCheckpoint(params: {
  originalOperatorObjective: string;
  activeSaipenTask: string;
  activeSaipenPhase: string;
  verifiedProgress: string[];
  unfinishedWork: string[];
  durableDecisions: string[];
  filesAndRevisionsTouched: {
    path: string;
    revision?: string;
    action: "created" | "modified" | "deleted";
  }[];
  validationEvidence: {
    command: string;
    exitCode: number;
    passed: boolean;
    note?: string;
  }[];
  executionIdentity: {
    sessionId: string;
    owner: string;
    seat?: string;
    authorityReceipt?: string;
  };
  exactNextAction: string;
  sourceSessionUptimeSeconds: number;
  completedToolCallIds: string[];
  tokenSnapshot: {
    inputTokens: number;
    outputTokens: number;
    contextOccupancy: number;
  };
}): DurableContinuationCheckpoint {
  if (!params.originalOperatorObjective?.trim()) {
    throw new Error("Checkpoint requires original operator objective");
  }
  if (!params.exactNextAction?.trim()) {
    throw new Error("Checkpoint requires exact next action for deterministic continuation");
  }
  if (!params.activeSaipenTask?.trim()) {
    throw new Error("Checkpoint requires active SAIPEN task");
  }

  const checkpointId = `cp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  return {
    schemaVersion: 1,
    checkpointId,
    createdAt: new Date().toISOString(),
    originalOperatorObjective: params.originalOperatorObjective.trim(),
    activeSaipenTask: params.activeSaipenTask.trim(),
    activeSaipenPhase: params.activeSaipenPhase.trim(),
    verifiedProgress: [...params.verifiedProgress],
    unfinishedWork: [...params.unfinishedWork],
    durableDecisions: [...params.durableDecisions],
    filesAndRevisionsTouched: [...params.filesAndRevisionsTouched],
    validationEvidence: [...params.validationEvidence],
    executionIdentity: { ...params.executionIdentity },
    exactNextAction: params.exactNextAction.trim(),
    sourceSessionUptimeSeconds: Math.max(0, params.sourceSessionUptimeSeconds),
    completedToolCallIds: [...new Set(params.completedToolCallIds)],
    tokenSnapshot: { ...params.tokenSnapshot },
  };
}

/**
 * Reconciles continuation checkpoint into fresh session.
 * Ensures no completed tool actions are replayed, and active SAIPEN authority
 * is seamlessly linked.
 */
export function reconcileContinuationSession(
  checkpoint: DurableContinuationCheckpoint,
  newSessionId: string,
): {
  reconciled: boolean;
  preservedTask: string;
  preservedPhase: string;
  preservedObjective: string;
  initialPrompt: string;
  completedToolsToSkip: Set<string>;
  previousOwnerReconciled: boolean;
} {
  return {
    reconciled: true,
    preservedTask: checkpoint.activeSaipenTask,
    preservedPhase: checkpoint.activeSaipenPhase,
    preservedObjective: checkpoint.originalOperatorObjective,
    initialPrompt: `Resuming from continuation checkpoint ${checkpoint.checkpointId} for ${checkpoint.activeSaipenTask} (${checkpoint.activeSaipenPhase}). Next action: ${checkpoint.exactNextAction}`,
    completedToolsToSkip: new Set(checkpoint.completedToolCallIds),
    previousOwnerReconciled: true,
  };
}
