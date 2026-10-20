/**
 * T-167 / SRC-116 TRACK B, composer side: the chat send path had no circuit.
 *
 * The autonomous dispatcher asks `resolveProviderQuotaRoute` before every job; the composer did
 * not, so a proven-exhausted route was fenced for queue work only while a hand-sent turn kept
 * walking into the same wall. This is the renderer's half of that ONE circuit: the same
 * `provider-quota-circuit` state the dispatcher reads, fed from the facts the renderer can prove,
 * and read once per submit through the same resolver.
 *
 * The renderer cannot see the CLI's adapter-level classification, so it opens the circuit only
 * from a quota banner kind that already means "this plan is spent". That is B2 in the UI's own
 * vocabulary: a network error, a 5xx, an auth failure or a missing model never produces one of
 * these kinds, so they never close a route.
 */
import {
  openProviderQuotaCircuit,
  resolveProviderQuotaRoute,
  zaicodeNextRefillAt,
  getRouteHealth,
  type ModelSelection,
} from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/services";
import type { SessionErrorInfo } from "@zcode/shared/zcode-protocol-v4";
import type { ZaicodeEngineAccount, ZaicodeLimitSnapshot } from "@zcode/shared";
import {
  ZAICODE_FALLBACK_QUOTA_KINDS,
  pickZaicodeFallbackModel,
} from "./zaicodeModelFallback.js";
import { zaicodeRetryClassOf } from "./zaicodeRetryPolicy.js";

/** Quota facts from any provider; tool/network errors never exhaust a model route. */
export function composerQuotaFailureKind(
  error: SessionErrorInfo | null,
  bannerKind: string | null | undefined,
): string | null {
  if (bannerKind && ZAICODE_FALLBACK_QUOTA_KINDS.has(bannerKind)) return bannerKind;
  return error && error.source !== "tool" && error.source !== "network" &&
    zaicodeRetryClassOf(error) === "quota" ? "provider-limited" : null;
}

/**
 * The vendor's OWN next reset for `providerId`, read from the quota snapshot the
 * operator's own reading already produced (T-190).
 *
 * Before this, every path that opened the circuit passed no `resetAt`, so the
 * hold was always a local estimate that doubled and capped at six hours. A
 * five-hour window was resumed on a guess; a weekly plan was hammered every six
 * hours instead of at its real reset. The vendor states the reset itself in
 * `resetsAt` and ZAICODE already reads it for the meters -- this is that same
 * reading, used where it is actually needed.
 *
 * Only a reset the vendor reported is returned. A stale or absent reading is
 * null, and the caller falls back to the estimate: an unproven reset must never
 * be presented as one (`resetSource` exists for exactly that).
 */
export function vendorResetAtForProvider(input: {
  providerId: string;
  accounts: readonly Pick<ZaicodeEngineAccount, "id" | "vendor">[];
  limits: Record<string, ZaicodeLimitSnapshot | undefined>;
  now: number;
}): number | null {
  const vendor = input.providerId.toLowerCase();
  let latest: number | null = null;
  for (const account of input.accounts) {
    if (account.vendor.toLowerCase() !== vendor) continue;
    const at = zaicodeNextRefillAt(input.limits[account.id], input.now);
    if (at !== null && (latest === null || at > latest)) latest = at;
  }
  return latest;
}

/**
 * Record a proven exhaustion for `providerId`. Returns false when the fact is not one this
 * circuit is allowed to act on, so the caller can tell "nothing proven" from "proven and closed".
 *
 * `resetAt` is the vendor's own reset when the renderer can see it; without it the circuit
 * holds for a local estimate and says so (`resetSource: "estimated"`), which is honest but
 * resumes on a guess rather than on the vendor's clock (T-190).
 */
export function noteComposerQuotaExhaustion(input: {
  providerId: string | null | undefined;
  kind: string | null | undefined;
  now: number;
  failedAt?: number;
  failureId?: string;
  resetAt?: number | null;
}): boolean {
  if (!input.providerId || !input.kind) return false;
  if (!ZAICODE_FALLBACK_QUOTA_KINDS.has(input.kind)) return false;
  openProviderQuotaCircuit({
    providerId: input.providerId,
    now: input.failedAt !== undefined && Number.isFinite(input.failedAt)
      ? Math.min(input.now, input.failedAt) : input.now,
    ...(input.resetAt !== undefined ? { resetAt: input.resetAt } : {}),
    failureId: input.failureId,
    reason: input.kind,
  });
  return true;
}

/**
 * The reasoning level travels with the operator's intent, but only when the model we move to
 * actually offers it. A level the target model does not know would be rejected downstream as a
 * malformed selection, which is a worse failure than the quota wall we are escaping.
 */
function carryReasoningLevel(
  requested: ModelSelection,
  fallback: { providerId: string; modelId: string },
  view: ModelSelectionView | null,
): ModelSelection {
  const level = requested.options?.reasoningLevel;
  if (!level) return fallback;
  const supported = view?.providers
    .find((provider) => provider.providerId === fallback.providerId)
    ?.models.find((candidate) => candidate.modelId === fallback.modelId)
    ?.config?.optionSpecs.reasoningLevel.values.includes(level);
  return supported ? { ...fallback, options: { reasoningLevel: level } } : fallback;
}

export type RouteClassification =
  | "operator_selected"
  | "quota_fallback"
  | "health_fallback"
  | "session_execution"
  | "router_upstream";

export interface FallbackReasonReceipt {
  receiptId: string;
  kind: "quota" | "health" | "router_upstream";
  timestamp: string;
  requested: ModelSelection;
  selected: ModelSelection;
  actualSessionExecutionModel?: ModelSelection | null;
  detail: string;
  holdUntil: string | null;
}

export interface RouteComposerSelectionOptions {
  pinned?: boolean;
  actualSessionModel?: ModelSelection | null;
  routerUpstreamModel?: string | null;
}

export interface ComposerQuotaRoute {
  selection: ModelSelection;
  /** The hold's end as a local time, for the UI to state. Null when the route ran as requested. */
  holdUntil: string | null;
  /** True when `selection` is the fallback pool rather than what the operator picked. */
  fallback: boolean;
  /** Specific fallback classification: quota vs health vs router_upstream */
  fallbackKind: "quota" | "health" | "router_upstream" | null;
  /** Route classification: operator_selected, quota_fallback, health_fallback, session_execution, router_upstream */
  routeClassification: RouteClassification;
  /** Reason receipt for attribution */
  receipt: FallbackReasonReceipt | null;
  /** True if execution model was explicitly pinned and cannot be silently overridden */
  isPinned?: boolean;
}

/**
 * Classifies the operational origin of a model route decision to prevent confusion
 * between operator pick, quota fallback, health fallback, and router-internal upstream.
 */
export function classifyRouteOrigin(params: {
  operatorSelected: ModelSelection;
  activeModel?: ModelSelection | null;
  quotaFallback?: boolean;
  healthFallback?: boolean;
  routerUpstreamModel?: string | null;
}): RouteClassification {
  if (params.quotaFallback) return "quota_fallback";
  if (params.healthFallback) return "health_fallback";
  if (params.routerUpstreamModel) return "router_upstream";
  if (
    params.activeModel &&
    (params.activeModel.providerId !== params.operatorSelected.providerId ||
      params.activeModel.modelId !== params.operatorSelected.modelId)
  ) {
    return "session_execution";
  }
  return "operator_selected";
}

/**
 * The single routing decision a hand-sent turn makes, taken through the same resolver the
 * dispatcher uses. Exactly-once: the turn either goes where the operator asked, or it goes to the
 * fallback once and says so -- never silently to a substitute, never retried onto a dead route.
 * Explicitly pinned models are never silently overridden.
 */
export function routeComposerSelection(
  requested: ModelSelection,
  view: ModelSelectionView | null,
  now: number,
  options?: RouteComposerSelectionOptions,
): ComposerQuotaRoute {
  if (options?.pinned) {
    return {
      selection: requested,
      holdUntil: null,
      fallback: false,
      fallbackKind: null,
      routeClassification: "operator_selected",
      receipt: null,
      isPinned: true,
    };
  }

  const health = getRouteHealth(
    {
      comboId: requested.providerId,
      modelId: requested.modelId,
    },
    now,
  );
  const routeIsUnhealthy =
    health.state === "COOLDOWN" ||
    health.state === "QUARANTINED" ||
    health.state === "PERMANENTLY_INVALID";

  const fallback = pickZaicodeFallbackModel(view, requested.providerId, now);
  const route = resolveProviderQuotaRoute({ requested, fallback, now });

  if (routeIsUnhealthy && !route.fallback && fallback) {
    const until = health.cooldownUntil ?? now + 60_000;
    const holdLabel = holdUntilLabel(until);
    const selected = carryReasoningLevel(requested, fallback, view);
    return {
      selection: selected,
      holdUntil: holdLabel,
      fallback: true,
      fallbackKind: "health",
      routeClassification: "health_fallback",
      receipt: {
        receiptId: `rcpt-health-${now}-${Math.random().toString(36).slice(2, 8)}`,
        kind: "health",
        timestamp: new Date(now).toISOString(),
        requested,
        selected,
        actualSessionExecutionModel: options?.actualSessionModel ?? null,
        detail: health.quarantineReason || `Route in health cooldown (${health.state})`,
        holdUntil: holdLabel,
      },
    };
  }

  if (!route.fallback) {
    return {
      selection: route.selection,
      holdUntil: route.circuit
        ? holdUntilLabel(route.circuit.until)
        : routeIsUnhealthy
          ? holdUntilLabel(health.cooldownUntil ?? now + 60_000)
          : null,
      fallback: false,
      fallbackKind: null,
      routeClassification:
        options?.actualSessionModel &&
        (options.actualSessionModel.providerId !== requested.providerId ||
          options.actualSessionModel.modelId !== requested.modelId)
          ? "session_execution"
          : "operator_selected",
      receipt: null,
    };
  }

  const holdLabel = holdUntilLabel(route.circuit!.until);
  const selected = carryReasoningLevel(requested, route.selection, view);
  return {
    selection: selected,
    holdUntil: holdLabel,
    fallback: true,
    fallbackKind: "quota",
    routeClassification: "quota_fallback",
    receipt: {
      receiptId: `rcpt-quota-${now}-${Math.random().toString(36).slice(2, 8)}`,
      kind: "quota",
      timestamp: new Date(now).toISOString(),
      requested,
      selected,
      actualSessionExecutionModel: options?.actualSessionModel ?? null,
      detail: route.circuit?.reason || "Provider quota circuit open",
      holdUntil: holdLabel,
    },
  };
}

function holdUntilLabel(until: number): string {
  return new Date(until).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}
