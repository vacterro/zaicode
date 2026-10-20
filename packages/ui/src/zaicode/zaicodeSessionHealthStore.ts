import { create } from "zustand";
import type {
  DurableContinuationCheckpoint,
  FailedRequestCorrelation,
  SessionDegradationMetrics,
  ZaicodeSessionHealthState,
} from "@zcode/shared";
import {
  createContinuationCheckpoint,
  evaluateSessionHealth,
  isSafeMigrationBoundary,
  reconcileContinuationSession,
} from "@zcode/shared";

export interface SessionHealthStoreEntry {
  state: ZaicodeSessionHealthState;
  reasons: string[];
  recommendedAction: string;
  lastEvaluatedAt: number;
  metrics: SessionDegradationMetrics;
  correlations: FailedRequestCorrelation[];
  latestCheckpoint?: DurableContinuationCheckpoint;
}

export interface ZaicodeSessionHealthStoreState {
  sessions: Record<string, SessionHealthStoreEntry>;
  activeSubscriptions: Record<string, Set<() => void>>;

  recordMetrics: (metrics: SessionDegradationMetrics) => void;
  recordFailure: (correlation: FailedRequestCorrelation) => void;
  getHealth: (sessionId: string) => ZaicodeSessionHealthState;
  getEntry: (sessionId: string) => SessionHealthStoreEntry | undefined;
  saveCheckpoint: (params: Parameters<typeof createContinuationCheckpoint>[0]) => DurableContinuationCheckpoint;
  prepareMigration: (params: {
    oldSessionId: string;
    newSessionId: string;
    checkpointId: string;
    hasActiveToolCall: boolean;
    isCompacting: boolean;
    hasUncommittedEdits: boolean;
    hasSaipenAuthority: boolean;
  }) => { success: boolean; error?: string; reconciliation?: ReturnType<typeof reconcileContinuationSession> };
  trackSubscription: (sessionId: string, unsubscribe: () => void) => () => void;
  cleanupSession: (sessionId: string) => number;
}

export const useZaicodeSessionHealthStore = create<ZaicodeSessionHealthStoreState>((set, get) => ({
  sessions: {},
  activeSubscriptions: {},

  recordMetrics: (metrics: SessionDegradationMetrics) => {
    const evaluation = evaluateSessionHealth(metrics);
    set((state) => {
      const existing = state.sessions[metrics.sessionId];
      return {
        sessions: {
          ...state.sessions,
          [metrics.sessionId]: {
            state: evaluation.state,
            reasons: evaluation.reasons,
            recommendedAction: evaluation.recommendedAction,
            lastEvaluatedAt: Date.now(),
            metrics: { ...metrics },
            correlations: existing?.correlations ?? [],
            latestCheckpoint: existing?.latestCheckpoint,
          },
        },
      };
    });
  },

  recordFailure: (correlation: FailedRequestCorrelation) => {
    set((state) => {
      const existing = state.sessions[correlation.sessionId];
      const correlations = [...(existing?.correlations ?? []), correlation];
      if (correlations.length > 50) correlations.shift();

      const metrics = existing?.metrics ?? {
        sessionId: correlation.sessionId,
        sessionUptimeSeconds: correlation.sessionUptimeSeconds,
        turnIndex: 0,
        contextTokens: correlation.inputTokens ?? 0,
        contextWindowLimit: 200_000,
        contextOccupancy: correlation.contextOccupancyEstimate,
        recentLatenciesMs: [correlation.requestDurationMs],
        recentTtftMs: [],
        repeatedGatewayTimeouts: 0,
        activeSubscriptionCount: 0,
        outstandingListenerCount: 0,
        recentToolOutputBytes: [],
        consecutiveCompactionFailures: 0,
        hasActiveToolCall: false,
      };

      if (
        correlation.failureReason.toLowerCase().includes("timeout") ||
        correlation.httpStatus === 504 ||
        correlation.httpStatus === 408
      ) {
        metrics.repeatedGatewayTimeouts += 1;
      }
      metrics.contextOccupancy = Math.max(
        metrics.contextOccupancy,
        correlation.contextOccupancyEstimate,
      );

      const evaluation = evaluateSessionHealth(metrics);

      return {
        sessions: {
          ...state.sessions,
          [correlation.sessionId]: {
            state: evaluation.state,
            reasons: evaluation.reasons,
            recommendedAction: evaluation.recommendedAction,
            lastEvaluatedAt: Date.now(),
            metrics,
            correlations,
            latestCheckpoint: existing?.latestCheckpoint,
          },
        },
      };
    });
  },

  getHealth: (sessionId: string) => {
    return get().sessions[sessionId]?.state ?? "UNOBSERVED";
  },

  getEntry: (sessionId: string) => {
    return get().sessions[sessionId];
  },

  saveCheckpoint: (params) => {
    const checkpoint = createContinuationCheckpoint(params);
    set((state) => {
      const existing = state.sessions[params.executionIdentity.sessionId];
      if (!existing) return state;
      return {
        sessions: {
          ...state.sessions,
          [params.executionIdentity.sessionId]: {
            ...existing,
            state: "HANDOFF_READY",
            latestCheckpoint: checkpoint,
          },
        },
      };
    });
    return checkpoint;
  },

  prepareMigration: (params) => {
    const entry = get().sessions[params.oldSessionId];
    const checkpoint = entry?.latestCheckpoint;
    if (!checkpoint || checkpoint.checkpointId !== params.checkpointId) {
      return { success: false, error: "Continuation checkpoint not found or mismatched" };
    }

    const confirmedDegradation =
      entry.state === "CHECKPOINT_REQUIRED" ||
      entry.state === "COMPACTION_RECOMMENDED" ||
      entry.state === "DEGRADING" ||
      entry.state === "HANDOFF_READY";

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
  },

  trackSubscription: (sessionId: string, unsubscribe: () => void) => {
    const subscriptions = get().activeSubscriptions;
    const sessionSet = subscriptions[sessionId] ?? new Set<() => void>();
    sessionSet.add(unsubscribe);
    subscriptions[sessionId] = sessionSet;

    return () => {
      sessionSet.delete(unsubscribe);
      try {
        unsubscribe();
      } catch {
        // Safe release
      }
    };
  },

  cleanupSession: (sessionId: string) => {
    const subscriptions = get().activeSubscriptions;
    const set = subscriptions[sessionId];
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
    delete subscriptions[sessionId];
    return count;
  },
}));
