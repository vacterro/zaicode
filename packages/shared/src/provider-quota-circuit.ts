/**
 * SRC-116 TRACK B: one circuit per provider, opened by a proven quota exhaustion and closed by
 * proven recovery.
 *
 * Before this, a paid route that had reached its plan limit was re-tried on every task and
 * every Retry, and nothing in the product knew the route was dead until the operator saw the
 * error again. The circuit is deliberately process-local: it is a live-transport fact, not
 * durable state, and a stale "this provider is dead" file would outlive the quota it described.
 *
 * Anti-flap (B5): reopening is driven by the provider's own reset time, not by a poll. A route
 * that trips again re-opens with a fresh `until`, so a provider stuck on "limit reached" cannot
 * flap between exhausted and available once per sweep.
 */

/** How long a route stays closed when the provider named no reset time. */
export const PROVIDER_QUOTA_CIRCUIT_DEFAULT_MS = 15 * 60_000;
/** A provider may name a reset further out than this (weekly plans); honour it. */
export const PROVIDER_QUOTA_CIRCUIT_MAX_MS = 7 * 24 * 60 * 60_000;
/** A stale circuit is dropped rather than kept forever: nobody closes a provider on paper. */
export const PROVIDER_QUOTA_CIRCUIT_STALE_MS = 7 * 24 * 60 * 60_000;

export interface ProviderQuotaCircuit {
  providerId: string;
  /** When the route was proven exhausted. */
  openedAt: number;
  /** The route stays unavailable until this moment. */
  until: number;
  /** Consecutive proven exhaustions on this route. */
  failures: number;
  /** Short human phrase for the UI ("GLM quota exhausted"). */
  reason: string;
  /** Where `until` came from, so the UI never presents an estimate as a vendor reset. */
  resetSource: "vendor" | "retry-after" | "estimated";
}

const circuits = new Map<string, ProviderQuotaCircuit>();

function clampUntil(now: number, until: number): number {
  return Math.min(Math.max(until, now + 60_000), now + PROVIDER_QUOTA_CIRCUIT_MAX_MS);
}

/**
 * Mark `providerId` unavailable until its known reset. Called from the one place every provider
 * failure is normalized, so no dispatch path can forget to.
 */
export function openProviderQuotaCircuit(input: {
  providerId: string;
  reason?: string;
  now: number;
  /** The vendor's own next-reset time, when it sent one. */
  resetAt?: number | null;
  retryAfterMs?: number | null;
}): ProviderQuotaCircuit {
  const previous = circuits.get(input.providerId);
  const until =
    typeof input.resetAt === "number" && input.resetAt > input.now
      ? clampUntil(input.now, input.resetAt)
      : typeof input.retryAfterMs === "number" && input.retryAfterMs > 0
        ? clampUntil(input.now, input.now + input.retryAfterMs)
        : input.now + PROVIDER_QUOTA_CIRCUIT_DEFAULT_MS;
  const circuit: ProviderQuotaCircuit = {
    providerId: input.providerId,
    openedAt: input.now,
    until,
    failures: (previous?.failures ?? 0) + 1,
    reason: input.reason ?? "quota exhausted",
    resetSource:
      typeof input.resetAt === "number" && input.resetAt > input.now
        ? "vendor"
        : typeof input.retryAfterMs === "number" && input.retryAfterMs > 0
          ? "retry-after"
          : "estimated",
  };
  circuits.set(input.providerId, circuit);
  return circuit;
}

/**
 * The circuit on this provider right now, or null when the route is usable. A circuit past its
 * `until` still counts as a circuit until something proves recovery: it is the next failure
 * that re-opens it, which is the revalidation the product owes the operator.
 */
export function providerQuotaCircuit(providerId: string, now: number): ProviderQuotaCircuit | null {
  const circuit = circuits.get(providerId);
  if (!circuit) return null;
  if (now - circuit.openedAt > PROVIDER_QUOTA_CIRCUIT_STALE_MS) {
    circuits.delete(providerId);
    return null;
  }
  return circuit;
}

/** Every route currently held unavailable, for the diagnostic snapshot and the UI. */
export function listProviderQuotaCircuits(now: number): ProviderQuotaCircuit[] {
  return [...circuits.values()]
    .map((circuit) => providerQuotaCircuit(circuit.providerId, now))
    .filter((circuit): circuit is ProviderQuotaCircuit => circuit !== null)
    .sort((left, right) => right.openedAt - left.openedAt);
}

/** Fresh telemetry, or an operator re-enable, proved this provider works again. */
export function closeProviderQuotaCircuit(providerId: string, now: number): boolean {
  const circuit = providerQuotaCircuit(providerId, now);
  circuits.delete(providerId);
  return circuit !== null;
}

export function resetProviderQuotaCircuits(): void {
  circuits.clear();
}

export interface ProviderQuotaRoute<T> {
  /** The route the work actually goes to. */
  selection: T;
  /** The circuit that moved it, or null when the requested route was used as-is. */
  circuit: ProviderQuotaCircuit | null;
  /** True when `selection` is the fallback, not what the operator asked for. */
  fallback: boolean;
}

/**
 * The ONE place a requested route becomes an effective route. Callers pass the fallback they
 * already know how to resolve; this decides, and reports what it did so the UI can say it out
 * loud instead of claiming GLM while executing SAIFREN.
 */
export function resolveProviderQuotaRoute<T extends { providerId: string }>(input: {
  requested: T;
  fallback: T | null;
  now: number;
}): ProviderQuotaRoute<T> {
  const circuit = providerQuotaCircuit(input.requested.providerId, input.now);
  if (!circuit) return { selection: input.requested, circuit: null, fallback: false };
  if (!input.fallback || input.fallback.providerId === input.requested.providerId) {
    // No route to move to: keeping the requested one beats refusing the task, and the error the
    // operator sees is the vendor's own, not a silent substitute.
    return { selection: input.requested, circuit, fallback: false };
  }
  return { selection: input.fallback, circuit, fallback: true };
}

/** "GLM unavailable until 18:40 (estimated), using SAIFREN fallback" / "" when no circuit held. */
export function describeProviderQuotaRoute(
  requestedProviderId: string,
  route: Pick<ProviderQuotaRoute<unknown>, "circuit" | "fallback">,
  now: number,
): string {
  const circuit = route.circuit;
  if (!circuit) return "";
  const until = new Date(circuit.until).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  // `resetSource` exists so a locally-timed hold never reads as a vendor reset promise: the
  // operator is told the time we will retry, not a time the provider promised.
  const qualifier = circuit.resetSource === "vendor" ? "" : " (estimated)";
  const head = `${requestedProviderId} unavailable until ${until}${qualifier}`;
  return route.fallback ? `${head}, using the fallback pool` : head;
}
