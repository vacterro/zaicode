import { z } from "zod";
import { normalizeZaicodeAutostartJobs, type ZaicodeAutostartJob, type ZaicodeEngineAccount, type ZaicodeLimitSnapshot } from "./zaicode-engines.js";

const MINUTE_MS = 60_000;
export const ZAICODE_CONTINUATION_QUOTA_MAX_AGE_MS = 5 * MINUTE_MS;
const runnerId = z.string().min(1).max(400);
export const zaicodeContinuationPolicySchema = z.object({
  enabled: z.boolean().default(false),
  runnerIds: z.array(runnerId).max(32).default([]),
  delayMinutes: z.number().min(0).max(1440).default(1),
  returnToPreferred: z.boolean().default(true),
  recoveryDelayMinutes: z.number().min(0).max(1440).default(1),
});
export type ZaicodeContinuationPolicy = z.infer<typeof zaicodeContinuationPolicySchema>;
export const zaicodeContinuationRunSchema = z.object({
  workspaceKey: z.string().min(1),
  projectPath: z.string().min(1),
  workspaceIdentity: z.string().optional(),
  occurrence: z.string().min(1),
  runnerId,
  primaryRunnerId: runnerId.optional(),
  lease: z.string().min(1),
  state: z.enum(["pending", "launching", "running", "waiting", "waiting-retry", "waiting-primary-reset", "failed", "complete", "stopped"]),
  workerId: z.string().optional(),
  generation: z.number().int().positive().optional(),
  sessionId: z.string().optional(),
  foregroundExecutionId: z.string().optional(),
  blocked: z.array(z.object({ runnerId, observedAt: z.number().nonnegative(), window: z.string(), resetText: z.string().nullable() })).max(32).default([]),
  nextAt: z.number().nonnegative(),
  launchedAt: z.number().nonnegative(),
  startedAt: z.number().nonnegative().optional(),
  preferredReadyAt: z.number().nonnegative().optional(),
  result: z.string().max(1000).default(""),
  recovery: z
    .object({
      failureClass: z.string().default("provider_overloaded_transient"),
      failureEventId: z.string().optional(),
      attempts: z.number().int().nonnegative().default(0),
      retryDeadline: z.number().nonnegative().optional(),
      recoveryOwner: z.string().optional(),
      lastDispatchAck: z.number().nonnegative().optional(),
    })
    .optional(),
});
export type ZaicodeContinuationRun = z.infer<typeof zaicodeContinuationRunSchema>;
/** Additive storage in the existing autostart job; no separate scheduler or quota store. */
export type ZaicodeContinuingJob = ZaicodeAutostartJob & { continuation: ZaicodeContinuationPolicy; continuationRuns: ZaicodeContinuationRun[] };

export function normalizeZaicodeContinuingJobs(raw: unknown): ZaicodeContinuingJob[] {
  const inputs = Array.isArray(raw) ? raw : [];
  return normalizeZaicodeAutostartJobs(raw).map((job) => {
    const input = inputs.find((value) => value && typeof value === "object" && value.id === job.id);
    const policy = zaicodeContinuationPolicySchema.safeParse(input?.continuation ?? {});
    const runs = z.array(zaicodeContinuationRunSchema).max(128).safeParse(input?.continuationRuns ?? []);
    return { ...job, continuation: policy.success && runs.success ? policy.data : zaicodeContinuationPolicySchema.parse({}), continuationRuns: runs.success ? runs.data : [], ...(!policy.success || !runs.success ? { lastResult: "Continuation storage is invalid; automatic continuation paused" } : {}) };
  });
}

/** A clock passing a reset never clears an observed limit: only a fresh vendor read does. */
export function zaicodeContinuationHasQuota(snapshot: ZaicodeLimitSnapshot | undefined, now: number, observedLimitAt = -1): boolean {
  if (!snapshot || snapshot.error || snapshot.fetchedAt === null || snapshot.fetchedAt <= observedLimitAt || snapshot.fetchedAt > now || now - snapshot.fetchedAt > ZAICODE_CONTINUATION_QUOTA_MAX_AGE_MS || snapshot.windows.length === 0) return false;
  return snapshot.windows.every((window) => !window.assumedFull && window.remainingPercent !== null && window.remainingPercent > 0);
}

export function zaicodeContinuationRunners(job: Pick<ZaicodeContinuingJob, "engineId" | "continuation">): string[] {
  return [...new Set([job.engineId, ...job.continuation.runnerIds])];
}

export function chooseZaicodeContinuationRunner(input: {
  job: Pick<ZaicodeContinuingJob, "engineId" | "continuation">;
  run: ZaicodeContinuationRun;
  accounts: readonly ZaicodeEngineAccount[];
  limits: Readonly<Record<string, ZaicodeLimitSnapshot>>;
  availablePools: ReadonlySet<string>;
  now: number;
}): string | null {
  return zaicodeContinuationRunners(input.job).find((id) => {
    if (id.startsWith("pool:")) return input.availablePools.has(id) && !input.run.blocked.some((limit) => limit.runnerId === id);
    const account = input.accounts.find((item) => item.id === id);
    if (!account || account.status !== "ready" || !account.cli || account.vendor === "freebuff") return false;
    const blocked = input.run.blocked.find((limit) => limit.runnerId === id);
    const snapshot = input.limits[id];
    return snapshot?.accountId === id && zaicodeContinuationHasQuota(snapshot, input.now, blocked?.observedAt);
  }) ?? null;
}

export function markZaicodeContinuationLimit(
  run: ZaicodeContinuationRun,
  signal: { window: string; resetText: string | null },
  now: number,
  delayMinutes: number,
  options?: { primaryRunnerId?: string; fallbackRunnerIds?: readonly string[] },
): ZaicodeContinuationRun {
  const primaryId = options?.primaryRunnerId ?? run.primaryRunnerId ?? (run.blocked.length === 0 ? run.runnerId : undefined);
  const updatedBlocked = [...run.blocked.filter((limit) => limit.runnerId !== run.runnerId), { runnerId: run.runnerId, observedAt: now, ...signal }];
  const allKnownRunners = options?.fallbackRunnerIds
    ? [primaryId, ...options.fallbackRunnerIds].filter((id): id is string => typeof id === "string" && Boolean(id))
    : [];
  const primaryBlocked = primaryId ? updatedBlocked.some((b) => b.runnerId === primaryId) : false;
  const isDualOrAllExhausted = primaryBlocked && (
    allKnownRunners.length > 0
      ? allKnownRunners.every((r) => updatedBlocked.some((b) => b.runnerId === r))
      : updatedBlocked.length >= 2 || (run.runnerId !== primaryId && primaryBlocked)
  );

  if (isDualOrAllExhausted) {
    return {
      ...run,
      ...(primaryId ? { primaryRunnerId: primaryId } : {}),
      state: "waiting-primary-reset",
      blocked: updatedBlocked,
      nextAt: now + delayMinutes * MINUTE_MS,
      preferredReadyAt: undefined,
      result: "WAIT_PRIMARY_RESET",
    };
  }

  return {
    ...run,
    ...(primaryId ? { primaryRunnerId: primaryId } : {}),
    state: "waiting",
    blocked: updatedBlocked,
    nextAt: now + delayMinutes * MINUTE_MS,
    preferredReadyAt: undefined,
    result: "Subscription limit; waiting for an eligible runner",
  };
}

export function markZaicodeContinuationCapacityRetry(
  run: ZaicodeContinuationRun,
  options: {
    failureClass?: string;
    failureEventId?: string;
    delayMs: number;
    now: number;
    owner?: string;
  },
): ZaicodeContinuationRun {
  const attempts = (run.recovery?.attempts ?? 0) + 1;
  return {
    ...run,
    state: "waiting-retry",
    nextAt: options.now + options.delayMs,
    result: `Selected model is at capacity; waiting-retry attempt ${attempts}`,
    recovery: {
      failureClass: options.failureClass ?? "provider_overloaded_transient",
      failureEventId: options.failureEventId,
      attempts,
      retryDeadline: options.now + options.delayMs,
      recoveryOwner: options.owner ?? "worker-watch",
      lastDispatchAck: options.now,
    },
  };
}

export type ZaicodeContinuationDecision =
  | { action: "none" | "wait" | "stop"; reason: string }
  | { action: "arm-return"; at: number }
  | { action: "cancel-return" }
  | { action: "wait-primary-reset"; reason: string }
  | { action: "launch" | "switch"; runnerId: string };

export function decideZaicodeContinuation(input: Parameters<typeof chooseZaicodeContinuationRunner>[0] & { autopilot: boolean; enabled: boolean; projectDisabled: boolean; stopDue: boolean }): ZaicodeContinuationDecision {
  const { job, run, now } = input;
  if (input.stopDue) return { action: "stop", reason: "Schedule stop time reached" };
  if (["complete", "stopped"].includes(run.state)) return { action: "none", reason: "Run is terminal" };
  if (run.state === "waiting-retry") {
    if (now < run.nextAt) return { action: "wait", reason: "Capacity retry delay" };
    return { action: "none", reason: "Capacity recovery in progress" };
  }
  if (!input.autopilot || !input.enabled || !job.continuation.enabled || input.projectDisabled) return { action: "wait", reason: "Automatic dispatch paused" };
  const runner = chooseZaicodeContinuationRunner(input);
  if (run.state === "running") {
    if (!job.continuation.returnToPreferred || run.runnerId === job.engineId) return { action: "none", reason: "Owned runner is working" };
    if (runner !== job.engineId) return run.preferredReadyAt !== undefined ? { action: "cancel-return" } : { action: "none", reason: "Preferred subscription is not freshly available" };
    if (run.preferredReadyAt === undefined) return { action: "arm-return", at: now + job.continuation.recoveryDelayMinutes * MINUTE_MS };
    return now >= run.preferredReadyAt ? { action: "switch", runnerId: runner } : { action: "wait", reason: "Recovery delay" };
  }
  if (now < run.nextAt) return { action: "wait", reason: "Handoff delay" };
  const primaryId = run.primaryRunnerId ?? job.engineId;
  const primaryBlocked = run.blocked.some((b) => b.runnerId === primaryId);
  const fallbacks = job.continuation.runnerIds;
  const fallbacksBlocked = fallbacks.length > 0
    ? fallbacks.every((f) => run.blocked.some((b) => b.runnerId === f))
    : run.blocked.length >= 2 || (run.runnerId !== primaryId && primaryBlocked);
  const isWaitingPrimaryReset = run.state === "waiting-primary-reset" || (primaryBlocked && fallbacksBlocked);
  if (!runner) {
    if (isWaitingPrimaryReset) {
      return { action: "wait-primary-reset", reason: "WAIT_PRIMARY_RESET" };
    }
    return { action: "wait", reason: "No selected runner has fresh available quota" };
  }
  return { action: run.workerId || run.sessionId ? "switch" : "launch", runnerId: runner };
}
