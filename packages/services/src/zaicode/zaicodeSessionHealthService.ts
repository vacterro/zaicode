import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  DurableContinuationCheckpoint,
  FailedRequestCorrelation,
  SessionDegradationMetrics,
  SessionHealthEvaluationOptions,
  ZaicodeSessionHealthState,
} from "@zcode/shared";
import {
  correlateSessionFailures,
  createContinuationCheckpoint,
  evaluateSessionHealth,
  isSafeMigrationBoundary,
  reconcileContinuationSession,
} from "@zcode/shared";

/**
 * Service for managing long-running session health, degradation tracking,
 * and zero-loss continuation checkpoints (T-365 / SRC-270).
 */
export class ZaicodeSessionHealthService {
  private readonly sessionMetrics = new Map<string, SessionDegradationMetrics>();
  private readonly failureHistory = new Map<string, FailedRequestCorrelation[]>();
  private readonly checkpoints = new Map<string, DurableContinuationCheckpoint>();
  private readonly activeSubscriptions = new Map<string, Set<() => void>>();

  constructor(
    private readonly options: {
      storageDir?: string;
      evaluationOptions?: SessionHealthEvaluationOptions;
      allowEphemeralCheckpoints?: boolean;
    } = {},
  ) {}

  /**
   * Registers or updates degradation metrics for a session.
   */
  public updateMetrics(metrics: SessionDegradationMetrics): void {
    this.sessionMetrics.set(metrics.sessionId, { ...metrics });
  }

  /**
   * Gets current metrics for a session or returns undefined.
   */
  public getMetrics(sessionId: string): SessionDegradationMetrics | undefined {
    return this.sessionMetrics.get(sessionId);
  }

  /**
   * Evaluates the health of a session.
   * Missing telemetry must mean UNOBSERVED, never falsely HEALTHY.
   */
  public evaluateHealth(sessionId: string): {
    state: ZaicodeSessionHealthState;
    reasons: string[];
    recommendedAction: string;
  } {
    const metrics = this.sessionMetrics.get(sessionId);
    if (
      !metrics ||
      (metrics.turnIndex === 0 && metrics.recentLatenciesMs.length === 0 && metrics.sessionUptimeSeconds === 0)
    ) {
      return {
        state: "UNOBSERVED",
        reasons: ["No Host telemetry measurements recorded yet"],
        recommendedAction: "Await Host metrics ingestion",
      };
    }
    return evaluateSessionHealth(metrics, this.options.evaluationOptions);
  }

  /**
   * Records a failed request correlation record.
   */
  public recordFailedRequest(correlation: FailedRequestCorrelation): void {
    const history = this.failureHistory.get(correlation.sessionId) ?? [];
    history.push(correlation);
    // Bounded history: keep latest 50
    if (history.length > 50) history.shift();
    this.failureHistory.set(correlation.sessionId, history);

    // Also update repeatedGatewayTimeouts count in metrics if applicable
    const current = this.sessionMetrics.get(correlation.sessionId);
    if (current) {
      if (
        correlation.failureReason.toLowerCase().includes("timeout") ||
        correlation.httpStatus === 504 ||
        correlation.httpStatus === 408
      ) {
        current.repeatedGatewayTimeouts += 1;
      }
      current.contextOccupancy = Math.max(
        current.contextOccupancy,
        correlation.contextOccupancyEstimate,
      );
      this.sessionMetrics.set(correlation.sessionId, current);
    }
  }

  /**
   * Gets failure correlation diagnosis for a session.
   */
  public getFailureCorrelation(sessionId: string) {
    const history = this.failureHistory.get(sessionId) ?? [];
    return correlateSessionFailures(history);
  }

  /**
   * Creates and persists a durable continuation checkpoint.
   */
  public saveContinuationCheckpoint(params: {
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
    const checkpoint = createContinuationCheckpoint(params);
    if (!this.options.storageDir) {
      if (!this.options.allowEphemeralCheckpoints) {
        throw new Error(
          "DURABLE_CHECKPOINT_WRITE_FAILED: storageDir must be configured for durable persistence",
        );
      }
    } else {
      // Validate safe path segment to avoid directory traversal
      const rawSessionId = params.executionIdentity.sessionId;
      if (
        !rawSessionId ||
        rawSessionId.includes("..") ||
        rawSessionId.includes("/") ||
        rawSessionId.includes("\\")
      ) {
        throw new Error("DURABLE_CHECKPOINT_WRITE_FAILED: invalid session identity path traversal");
      }
      const safeSessionId = rawSessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
      const sessionDir = join(this.options.storageDir, safeSessionId);
      const filePath = join(sessionDir, `${checkpoint.checkpointId}.json`);
      const resolvedTarget = resolve(filePath);
      const resolvedRoot = resolve(this.options.storageDir);
      if (!resolvedTarget.startsWith(resolvedRoot)) {
        throw new Error("DURABLE_CHECKPOINT_WRITE_FAILED: path traversal out of storageDir");
      }

      const tmpPath = `${filePath}.${Date.now()}.tmp`;
      try {
        mkdirSync(dirname(filePath), { recursive: true });
        const serialized = JSON.stringify(checkpoint, null, 2);
        writeFileSync(tmpPath, serialized, "utf8");

        // Explicit readback integrity verification
        const readback = readFileSync(tmpPath, "utf8");
        const parsed = JSON.parse(readback) as DurableContinuationCheckpoint;
        if (
          parsed.checkpointId !== checkpoint.checkpointId ||
          parsed.schemaVersion !== 1 ||
          parsed.executionIdentity?.sessionId !== params.executionIdentity.sessionId
        ) {
          throw new Error("Checkpoint integrity validation failed on readback");
        }

        // Atomic commit
        renameSync(tmpPath, filePath);

        // Verify final committed destination exists and matches
        if (!existsSync(filePath)) {
          throw new Error("Committed checkpoint file was not found after rename");
        }
      } catch (err) {
        // Remove tmp file if lingering
        try {
          if (existsSync(tmpPath)) unlinkSync(tmpPath);
        } catch {
          // ignore cleanup error
        }
        this.checkpoints.delete(checkpoint.checkpointId);
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`DURABLE_CHECKPOINT_WRITE_FAILED: ${reason}`);
      }
    }

    this.checkpoints.set(checkpoint.checkpointId, checkpoint);
    return checkpoint;
  }

  /**
   * Retrieves a checkpoint by ID from memory or disk.
   */
  public getContinuationCheckpoint(
    sessionId: string,
    checkpointId: string,
  ): DurableContinuationCheckpoint | null {
    const cached = this.checkpoints.get(checkpointId);
    if (cached) return cached;

    if (this.options.storageDir) {
      try {
        const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
        const filePath = join(this.options.storageDir, safeSessionId, `${checkpointId}.json`);
        const resolvedTarget = resolve(filePath);
        const resolvedRoot = resolve(this.options.storageDir);
        if (resolvedTarget.startsWith(resolvedRoot) && existsSync(filePath)) {
          const content = readFileSync(filePath, "utf8");
          const parsed = JSON.parse(content) as DurableContinuationCheckpoint;
          if (parsed.checkpointId === checkpointId) {
            this.checkpoints.set(checkpointId, parsed);
            return parsed;
          }
        }
      } catch {
        return null;
      }
    }

    return null;
  }

  /**
   * Prepares migration into a fresh session from a checkpoint.
   */
  public prepareSessionMigration(params: {
    checkpointId: string;
    oldSessionId: string;
    newSessionId: string;
    hasActiveToolCall: boolean;
    isCompacting: boolean;
    hasUncommittedEdits: boolean;
    hasSaipenAuthority: boolean;
  }): {
    success: boolean;
    error?: string;
    reconciliation?: ReturnType<typeof reconcileContinuationSession>;
  } {
    const checkpoint = this.getContinuationCheckpoint(params.oldSessionId, params.checkpointId);
    if (!checkpoint) {
      return { success: false, error: `Checkpoint ${params.checkpointId} not found` };
    }

    const health = this.evaluateHealth(params.oldSessionId);
    const confirmedDegradation =
      health.state === "CHECKPOINT_REQUIRED" ||
      health.state === "COMPACTION_RECOMMENDED" ||
      health.state === "DEGRADING";

    const boundary = isSafeMigrationBoundary({
      hasActiveToolCall: params.hasActiveToolCall,
      isCompacting: params.isCompacting,
      hasUncommittedDiskEdits: params.hasUncommittedEdits,
      hasSaipenAuthority: params.hasSaipenAuthority,
      sessionUptimeHours: checkpoint.sourceSessionUptimeSeconds / 3600,
      confirmedDegradation,
    });

    if (!boundary.allowed) {
      return { success: false, error: boundary.reasons.join("; ") };
    }

    const reconciliation = reconcileContinuationSession(checkpoint, params.newSessionId);
    return { success: true, reconciliation };
  }

  /**
   * Tracks and manages subscription cleanup to prevent leaks in long-running sessions.
   */
  public trackSubscription(sessionId: string, unsubscribe: () => void): () => void {
    const set = this.activeSubscriptions.get(sessionId) ?? new Set();
    set.add(unsubscribe);
    this.activeSubscriptions.set(sessionId, set);

    return () => {
      set.delete(unsubscribe);
      try {
        unsubscribe();
      } catch {
        // Safe unsubscribe ignore
      }
    };
  }

  /**
   * Cleans up all tracked subscriptions for a session upon migration or close.
   */
  public cleanupSessionSubscriptions(sessionId: string): number {
    const set = this.activeSubscriptions.get(sessionId);
    if (!set) return 0;
    const count = set.size;
    for (const unsubscribe of set) {
      try {
        unsubscribe();
      } catch {
        // Safe release
      }
    }
    set.clear();
    this.activeSubscriptions.delete(sessionId);
    return count;
  }
}
