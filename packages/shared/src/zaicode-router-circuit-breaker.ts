/**
 * ZAICODE Router-Aware Circuit Breaker & Autonomous Model Failover
 *
 * Implements bounded model-health tracking, transient timeout cooldown,
 * half-open reintegration, and safe failover across 9router combo models.
 *
 * Preserves 9router as the routing authority; does not create a second independent router.
 */

export type RouteHealthState =
  | "UNKNOWN"
  | "HEALTHY"
  | "DEGRADED"
  | "COOLDOWN"
  | "HALF_OPEN"
  | "QUARANTINED"
  | "PERMANENTLY_INVALID";

export type RouteFailureClass =
  | "TRANSIENT"
  | "RATE_LIMITED"
  | "CONFIGURATION_FAILURE"
  | "PERMANENT_MODEL_FAILURE"
  | "GLOBAL_ROUTER_FAILURE"
  | "UNKNOWN";

export type RouterFailureMode = "observe_only" | "local_exclusion" | "managed_sync";

export interface RouteIdentity {
  routerUrl?: string;
  routerInstanceId?: string;
  comboId: string;
  modelId: string;
  connectionId?: string;
}

export interface RouteHealthRecord {
  id: string;
  routerUrl?: string;
  routerInstanceId?: string;
  comboId: string;
  modelId: string;
  connectionId?: string;
  state: RouteHealthState;
  consecutiveFailures: number;
  distinctAttemptCount: number;
  lastFailureClass?: RouteFailureClass;
  lastFailureCode?: string;
  lastFailureMessage?: string;
  lastFailureAt?: number;
  lastSuccessAt?: number;
  cooldownUntil?: number;
  halfOpenProbeInFlight?: boolean;
  quarantineReason?: string;
  quarantinedAt?: number;
  retryAfterMs?: number;
  lastRequestId?: string;
  lastAttempt?: number;
}

export interface RouterDiagnosticReceipt {
  receiptId: string;
  timestamp: string;
  routerUrl?: string;
  combo: {
    id: string;
    name?: string;
  };
  attemptedRoute: {
    modelId: string;
    upstreamProvider: string;
    connectionId?: string;
    attempt: number;
  };
  failure: {
    code: string;
    classification: RouteFailureClass;
    statusCode?: number;
    safeMessage: string;
    timeoutStage?: string;
    retryAfterMs?: number;
    streamedContent: boolean;
  };
  decision: {
    action: "failover" | "waiting" | "stopped";
    decisionText: string;
    nextCandidate: string | null;
    recoveryAttempt?: { current: number; max: number };
    nextEligibleProbeAt?: string | null;
    allRoutesInCooldown: boolean;
    routerDown: boolean;
  };
}

/** Configurable persistent quarantine threshold for distinct non-transient failures. */
export const ROUTER_QUARANTINE_CONSECUTIVE_THRESHOLD = 5;

/** Default starting cooldown intervals for transient route failures (ms). */
export const ROUTE_COOLDOWN_TIERS_MS = [
  30_000,     // 1st: 30s
  120_000,    // 2nd: 2m
  300_000,    // 3rd: 5m
  900_000,    // 4th: 15m
  3_600_000,  // 5th+: 1h max
] as const;

export function buildRouteKey(route: RouteIdentity): string {
  const url = (route.routerUrl ?? "default").trim().toLowerCase();
  const combo = route.comboId.trim().toLowerCase();
  const model = route.modelId.trim();
  const conn = route.connectionId ? `::${route.connectionId.trim()}` : "";
  return `${url}::${combo}::${model}${conn}`;
}

const routeRecords = new Map<string, RouteHealthRecord>();
let activeRouterFailureMode: RouterFailureMode = "local_exclusion";
let lastGlobalRouterFailureAt: number | null = null;
let globalRouterDown = false;

export function getRouterFailureMode(): RouterFailureMode {
  return activeRouterFailureMode;
}

export function setRouterFailureMode(mode: RouterFailureMode): void {
  activeRouterFailureMode = mode;
}

export function isGlobalRouterDown(): boolean {
  return globalRouterDown;
}

export function setGlobalRouterDown(down: boolean, now = Date.now()): void {
  globalRouterDown = down;
  if (down) {
    lastGlobalRouterFailureAt = now;
  }
}

export function classifyRouteFailure(input: {
  statusCode?: number;
  code?: string;
  providerCode?: string;
  message?: string;
  isRouterDown?: boolean;
}): RouteFailureClass {
  if (input.isRouterDown) {
    return "GLOBAL_ROUTER_FAILURE";
  }

  const rawCode = (input.providerCode ?? input.code ?? "").toLowerCase();
  const statusCode = input.statusCode;

  // Global router network faults
  if (
    rawCode === "econnrefused" ||
    rawCode === "router_down" ||
    rawCode === "router_unavailable"
  ) {
    return "GLOBAL_ROUTER_FAILURE";
  }

  // Rate limits
  if (
    statusCode === 429 ||
    rawCode === "rate_limited" ||
    rawCode === "rate_limit_error" ||
    rawCode === "model_rate_limited" ||
    rawCode === "insufficient_quota" ||
    rawCode.includes("quota")
  ) {
    return "RATE_LIMITED";
  }

  // Configuration / Auth / Client error
  if (
    statusCode === 400 ||
    statusCode === 401 ||
    statusCode === 403 ||
    rawCode === "auth_failed" ||
    rawCode === "invalid_api_key" ||
    rawCode === "provider_not_configured" ||
    rawCode === "bad_request"
  ) {
    return "CONFIGURATION_FAILURE";
  }

  // Permanent model failure (404, retired, model_not_found)
  if (
    statusCode === 404 ||
    rawCode === "model_not_found" ||
    rawCode === "model_retired" ||
    rawCode === "model_permanently_unavailable"
  ) {
    return "PERMANENT_MODEL_FAILURE";
  }

  // Transient failures (gateway timeout, 408, 502, 503, 504, connection reset, overload)
  if (
    statusCode === 408 ||
    statusCode === 502 ||
    statusCode === 503 ||
    statusCode === 504 ||
    rawCode === "gateway_timeout" ||
    rawCode === "gateway_time_out" ||
    rawCode === "request_timeout" ||
    rawCode === "timeout" ||
    rawCode === "etimedout" ||
    rawCode === "econnreset" ||
    rawCode === "provider_overloaded" ||
    rawCode === "overloaded" ||
    rawCode === "engine_overloaded_error" ||
    rawCode === "server_error"
  ) {
    return "TRANSIENT";
  }

  // Explicit 500 or unrecognized errors return UNKNOWN rather than guessing TRANSIENT
  return "UNKNOWN";
}

export function calculateRouteCooldown(
  consecutiveFailures: number,
  retryAfterMs?: number,
): number {
  if (typeof retryAfterMs === "number" && retryAfterMs > 0) {
    return Math.min(retryAfterMs, 3_600_000);
  }

  const index = Math.min(Math.max(0, consecutiveFailures - 1), ROUTE_COOLDOWN_TIERS_MS.length - 1);
  const base = ROUTE_COOLDOWN_TIERS_MS[index]!;
  // Apply +/- 10% jitter to prevent thundering herd
  const jitterFactor = 0.9 + Math.random() * 0.2;
  return Math.round(base * jitterFactor);
}

export function getRouteHealth(route: RouteIdentity, now = Date.now()): RouteHealthRecord {
  const key = buildRouteKey(route);
  const existing = routeRecords.get(key);
  if (!existing) {
    return {
      id: key,
      routerUrl: route.routerUrl,
      comboId: route.comboId,
      modelId: route.modelId,
      connectionId: route.connectionId,
      state: "UNKNOWN",
      consecutiveFailures: 0,
      distinctAttemptCount: 0,
    };
  }

  // Handle transition from COOLDOWN to HALF_OPEN when cooldown expires
  if (existing.state === "COOLDOWN" && existing.cooldownUntil && now >= existing.cooldownUntil) {
    existing.state = "HALF_OPEN";
  }

  return existing;
}

export function recordRouteFailure(
  route: RouteIdentity,
  error: {
    statusCode?: number;
    code?: string;
    providerCode?: string;
    message?: string;
    isRouterDown?: boolean;
    retryAfterMs?: number;
  },
  now = Date.now(),
): RouteHealthRecord {
  const key = buildRouteKey(route);
  const record = getRouteHealth(route, now);
  const failureClass = classifyRouteFailure(error);

  // GLOBAL ROUTER FAILURE: router is unreachable
  // NEVER quarantine or penalize individual models merely because the whole router is unreachable!
  if (failureClass === "GLOBAL_ROUTER_FAILURE") {
    setGlobalRouterDown(true, now);
    record.lastFailureClass = failureClass;
    record.lastFailureCode = error.providerCode ?? error.code;
    record.lastFailureMessage = error.message;
    record.lastFailureAt = now;
    routeRecords.set(key, record);
    return record;
  }

  // Route is reachable, clear global down
  globalRouterDown = false;
  record.consecutiveFailures += 1;
  record.distinctAttemptCount += 1;
  record.lastFailureClass = failureClass;
  record.lastFailureCode = error.providerCode ?? error.code;
  record.lastFailureMessage = error.message;
  record.lastFailureAt = now;
  record.halfOpenProbeInFlight = false;

  if (failureClass === "PERMANENT_MODEL_FAILURE") {
    record.state = "QUARANTINED";
    record.quarantinedAt = now;
    record.quarantineReason = error.message || "Confirmed permanent model rejection";
    record.cooldownUntil = undefined;
  } else if (failureClass === "CONFIGURATION_FAILURE") {
    record.state = "DEGRADED";
    record.cooldownUntil = undefined;
  } else if (failureClass === "TRANSIENT" || failureClass === "RATE_LIMITED") {
    // A temporary gateway timeout is NEVER permanent death, regardless of how many times it occurs.
    const cooldownMs = calculateRouteCooldown(record.consecutiveFailures, error.retryAfterMs);
    record.state = "COOLDOWN";
    record.cooldownUntil = now + cooldownMs;
    record.retryAfterMs = error.retryAfterMs;
  }

  routeRecords.set(key, record);
  return record;
}

export function recordRouteSuccess(route: RouteIdentity, now = Date.now()): RouteHealthRecord {
  const key = buildRouteKey(route);
  const record = getRouteHealth(route, now);
  record.state = "HEALTHY";
  record.consecutiveFailures = 0;
  record.lastSuccessAt = now;
  record.cooldownUntil = undefined;
  record.halfOpenProbeInFlight = false;
  routeRecords.set(key, record);
  return record;
}

export function permitHalfOpenProbe(route: RouteIdentity): boolean {
  const record = getRouteHealth(route);
  if (record.state === "HALF_OPEN" && !record.halfOpenProbeInFlight) {
    record.halfOpenProbeInFlight = true;
    routeRecords.set(record.id, record);
    return true;
  }
  return false;
}

export function quarantineRoute(route: RouteIdentity, reason: string, now = Date.now()): RouteHealthRecord {
  const key = buildRouteKey(route);
  const record = getRouteHealth(route, now);
  record.state = "QUARANTINED";
  record.quarantinedAt = now;
  record.quarantineReason = reason;
  record.cooldownUntil = undefined;
  record.halfOpenProbeInFlight = false;
  routeRecords.set(key, record);
  return record;
}

export function restoreRoute(route: RouteIdentity): RouteHealthRecord {
  const key = buildRouteKey(route);
  const record = getRouteHealth(route);
  record.state = "UNKNOWN";
  record.consecutiveFailures = 0;
  record.quarantinedAt = undefined;
  record.quarantineReason = undefined;
  record.cooldownUntil = undefined;
  record.halfOpenProbeInFlight = false;
  routeRecords.set(key, record);
  return record;
}

export function listQuarantinedRoutes(comboId?: string): RouteHealthRecord[] {
  const result: RouteHealthRecord[] = [];
  const targetCombo = comboId ? comboId.trim().toLowerCase() : undefined;
  for (const record of routeRecords.values()) {
    if (record.state === "QUARANTINED" || record.state === "PERMANENTLY_INVALID") {
      if (!targetCombo || record.comboId.trim().toLowerCase() === targetCombo) {
        result.push({ ...record });
      }
    }
  }
  return result;
}

export function resetAllRouteHealth(): void {
  routeRecords.clear();
  globalRouterDown = false;
  lastGlobalRouterFailureAt = null;
}

export interface RouteSelectionResult {
  selectedModelId: string | null;
  state: RouteHealthState;
  reason: string;
  allInCooldown: boolean;
  earliestProbeAt: number | null;
  quarantinedCount: number;
}

export function selectNextEligibleComboModel(params: {
  models: readonly string[];
  comboId: string;
  routerUrl?: string;
  currentModelId?: string;
  now?: number;
}): RouteSelectionResult {
  const now = params.now ?? Date.now();
  const models = params.models;
  const comboId = params.comboId;
  const routerUrl = params.routerUrl;
  const currentModelId = params.currentModelId;

  if (activeRouterFailureMode === "observe_only") {
    // In observe_only mode, don't locally filter out models
    const fallback = models.find((m) => m !== currentModelId) ?? models[0] ?? null;
    return {
      selectedModelId: fallback,
      state: "UNKNOWN",
      reason: "observe_only mode active; standard router order preserved",
      allInCooldown: false,
      earliestProbeAt: null,
      quarantinedCount: 0,
    };
  }

  let earliestCooldownUntil: number | null = null;
  let quarantinedCount = 0;
  const candidates: Array<{ modelId: string; state: RouteHealthState; cooldownUntil?: number }> = [];

  for (const modelId of models) {
    const health = getRouteHealth({ routerUrl, comboId, modelId }, now);
    if (health.state === "QUARANTINED" || health.state === "PERMANENTLY_INVALID") {
      quarantinedCount++;
      continue;
    }

    if (health.state === "COOLDOWN") {
      if (health.cooldownUntil) {
        if (earliestCooldownUntil === null || health.cooldownUntil < earliestCooldownUntil) {
          earliestCooldownUntil = health.cooldownUntil;
        }
      }
      continue;
    }

    candidates.push({
      modelId,
      state: health.state,
      cooldownUntil: health.cooldownUntil,
    });
  }

  // 1. Prefer healthy candidates
  const healthy = candidates.find((c) => c.state === "HEALTHY" && c.modelId !== currentModelId);
  if (healthy) {
    return {
      selectedModelId: healthy.modelId,
      state: healthy.state,
      reason: "Selected healthy eligible model",
      allInCooldown: false,
      earliestProbeAt: null,
      quarantinedCount,
    };
  }

  // 2. Next prefer unknown candidates
  const unknown = candidates.find((c) => c.state === "UNKNOWN" && c.modelId !== currentModelId);
  if (unknown) {
    return {
      selectedModelId: unknown.modelId,
      state: unknown.state,
      reason: "Selected untried candidate model",
      allInCooldown: false,
      earliestProbeAt: null,
      quarantinedCount,
    };
  }

  // 3. Half-open candidate ready for bounded probe (requires atomic probe permit)
  const halfOpenCandidates = candidates.filter((c) => c.state === "HALF_OPEN" && c.modelId !== currentModelId);
  for (const halfOpen of halfOpenCandidates) {
    const admitted = permitHalfOpenProbe({ routerUrl, comboId, modelId: halfOpen.modelId });
    if (admitted) {
      return {
        selectedModelId: halfOpen.modelId,
        state: "HALF_OPEN",
        reason: "Selected model for half-open recovery probe",
        allInCooldown: false,
        earliestProbeAt: null,
        quarantinedCount,
      };
    }
  }

  // 4. Any other non-current candidate (excluding HALF_OPEN candidates whose permit was refused)
  const other = candidates.find((c) => c.modelId !== currentModelId && c.state !== "HALF_OPEN");
  if (other) {
    return {
      selectedModelId: other.modelId,
      state: other.state,
      reason: "Selected next available candidate",
      allInCooldown: false,
      earliestProbeAt: null,
      quarantinedCount,
    };
  }

  // All eligible models are in cooldown, awaiting probe completion, or quarantined
  return {
    selectedModelId: null,
    state: "COOLDOWN",
    reason: quarantinedCount === models.length
      ? "All combo models are quarantined"
      : "All combo models are in cooldown or awaiting probe completion",
    allInCooldown: quarantinedCount < models.length,
    earliestProbeAt: earliestCooldownUntil,
    quarantinedCount,
  };
}

export function generateRouterDiagnosticReceipt(input: {
  sessionId?: string;
  requestId?: string;
  routerRequestId?: string;
  comboId: string;
  comboName?: string;
  attemptedModelId?: string;
  upstreamProvider?: string;
  upstreamConnectionId?: string;
  attempt?: number;
  statusCode?: number;
  providerErrorCode?: string;
  providerErrorMessage?: string;
  timeoutStage?: string;
  retryAfterMs?: number;
  streamedContent?: boolean;
  decision: string;
  nextCandidate?: string | null;
  nextAction: "failover" | "waiting" | "stopped";
  recoveryAttempt?: { current: number; max: number };
  nextEligibleProbeAt?: number | null;
  allRoutesInCooldown?: boolean;
  routerDown?: boolean;
  routerUrl?: string;
}): RouterDiagnosticReceipt {
  const failureClass = classifyRouteFailure({
    statusCode: input.statusCode,
    code: input.providerErrorCode,
    providerCode: input.providerErrorCode,
    message: input.providerErrorMessage,
    isRouterDown: input.routerDown,
  });

  return {
    receiptId: `rcpt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    routerUrl: input.routerUrl,
    combo: {
      id: input.comboId,
      name: input.comboName,
    },
    attemptedRoute: {
      modelId: input.attemptedModelId || "UPSTREAM_IDENTITY_UNAVAILABLE",
      upstreamProvider: input.upstreamProvider || "UPSTREAM_IDENTITY_UNAVAILABLE",
      connectionId: input.upstreamConnectionId,
      attempt: input.attempt ?? 1,
    },
    failure: {
      code: input.providerErrorCode || "unknown",
      classification: failureClass,
      statusCode: input.statusCode,
      safeMessage: input.providerErrorMessage?.slice(0, 300) || "Unknown failure",
      timeoutStage: input.timeoutStage,
      retryAfterMs: input.retryAfterMs,
      streamedContent: input.streamedContent ?? false,
    },
    decision: {
      action: input.nextAction,
      decisionText: input.decision,
      nextCandidate: input.nextCandidate ?? null,
      recoveryAttempt: input.recoveryAttempt,
      nextEligibleProbeAt: input.nextEligibleProbeAt ? new Date(input.nextEligibleProbeAt).toISOString() : null,
      allRoutesInCooldown: input.allRoutesInCooldown ?? false,
      routerDown: input.routerDown ?? false,
    },
  };
}

export function formatRouterDiagnosticText(receipt: RouterDiagnosticReceipt): string {
  const lines: string[] = [
    receipt.combo.name || receipt.combo.id,
    `Failed upstream: ${receipt.attemptedRoute.modelId || "UPSTREAM_IDENTITY_UNAVAILABLE"}`,
    `Failure: ${receipt.failure.code} (${receipt.failure.classification})`,
    `Decision: ${receipt.decision.decisionText}`,
    `Next candidate: ${receipt.decision.nextCandidate ?? "none"}`,
    `Next action: ${receipt.decision.action}`,
  ];
  if (receipt.decision.recoveryAttempt) {
    lines.push(`Recovery attempt: ${receipt.decision.recoveryAttempt.current}/${receipt.decision.recoveryAttempt.max}`);
  }
  if (receipt.decision.nextEligibleProbeAt) {
    lines.push(`Next eligible probe: ${receipt.decision.nextEligibleProbeAt}`);
  }
  return lines.join("\n");
}

export interface UnattributedFailureRecord {
  id: string;
  comboId: string;
  routerUrl?: string;
  routerInstanceId?: string;
  reason?: string;
  failureClass: RouteFailureClass;
  statusCode?: number;
  code?: string;
  providerCode?: string;
  message?: string;
  retryAfterMs?: number;
  diagnosticLimitation: "UPSTREAM_IDENTITY_UNAVAILABLE";
  rawSafeErrorEvidence: string;
  timestamp: number;
}

const unattributedFailures: UnattributedFailureRecord[] = [];

export function recordUnattributedFailure(input: {
  comboId: string;
  routerUrl?: string;
  routerInstanceId?: string;
  reason?: string;
  rawSafeErrorEvidence?: string;
  error: {
    statusCode?: number;
    code?: string;
    providerCode?: string;
    message?: string;
    retryAfterMs?: number;
    isRouterDown?: boolean;
  };
  now?: number;
}): UnattributedFailureRecord {
  const now = input.now ?? Date.now();
  const failureClass = classifyRouteFailure({
    statusCode: input.error.statusCode,
    code: input.error.code,
    providerCode: input.error.providerCode,
    message: input.error.message,
    isRouterDown: input.error.isRouterDown,
  });

  const record: UnattributedFailureRecord = {
    id: `unattr-${now}-${Math.random().toString(36).slice(2, 7)}`,
    comboId: input.comboId,
    routerUrl: input.routerUrl,
    routerInstanceId: input.routerInstanceId,
    reason: input.reason,
    failureClass,
    statusCode: input.error.statusCode,
    code: input.error.code,
    providerCode: input.error.providerCode,
    message: input.error.message,
    retryAfterMs: input.error.retryAfterMs,
    diagnosticLimitation: "UPSTREAM_IDENTITY_UNAVAILABLE",
    rawSafeErrorEvidence: input.rawSafeErrorEvidence || (input.error.message?.slice(0, 500) ?? "Unknown safe evidence"),
    timestamp: now,
  };

  unattributedFailures.push(record);
  if (unattributedFailures.length > 100) {
    unattributedFailures.shift();
  }
  return record;
}

export function listUnattributedFailures(comboId?: string): UnattributedFailureRecord[] {
  if (!comboId) return [...unattributedFailures];
  return unattributedFailures.filter((f) => f.comboId === comboId);
}

export function clearUnattributedFailures(): void {
  unattributedFailures.length = 0;
}

export interface PersistedRouteHealthSnapshot {
  version: 1;
  updatedAt: string;
  routerNamespace?: string;
  records: RouteHealthRecord[];
  globalRouterDown: boolean;
  routerFailureMode: RouterFailureMode;
  unattributedFailures?: UnattributedFailureRecord[];
}

export function serializeRouteHealthSnapshot(routerNamespace = "default"): PersistedRouteHealthSnapshot {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    routerNamespace,
    records: Array.from(routeRecords.values()).map((r) => ({ ...r })),
    globalRouterDown,
    routerFailureMode: activeRouterFailureMode,
    unattributedFailures: [...unattributedFailures],
  };
}

export function restoreRouteHealthSnapshot(
  snapshot: PersistedRouteHealthSnapshot,
  now = Date.now(),
): void {
  if (snapshot?.version !== 1 || !Array.isArray(snapshot.records)) return;
  routeRecords.clear();

  // Bounded storage: keep up to 500 records
  const boundedRecords = snapshot.records.slice(-500);
  for (const record of boundedRecords) {
    if (record?.id && record?.comboId && record?.modelId) {
      const restored = { ...record };
      // Cooldown timestamp recovery:
      // If cooldown expired while offline, transition to HALF_OPEN (never false HEALTHY)
      if (restored.state === "COOLDOWN") {
        if (typeof restored.cooldownUntil === "number" && now >= restored.cooldownUntil) {
          restored.state = "HALF_OPEN";
          restored.halfOpenProbeInFlight = false;
        }
      }
      routeRecords.set(restored.id, restored);
    }
  }
  globalRouterDown = Boolean(snapshot.globalRouterDown);
  if (snapshot.routerFailureMode) {
    activeRouterFailureMode = snapshot.routerFailureMode;
  }
  if (Array.isArray(snapshot.unattributedFailures)) {
    unattributedFailures.length = 0;
    unattributedFailures.push(...snapshot.unattributedFailures.slice(-100));
  }
}



