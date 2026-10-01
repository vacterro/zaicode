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
import { openProviderQuotaCircuit, resolveProviderQuotaRoute, type ModelSelection } from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/services";
import { ZAICODE_FALLBACK_QUOTA_KINDS, pickZaicodeFallbackModel } from "./zaicodeModelFallback.js";

/**
 * Record a proven exhaustion for `providerId`. Returns false when the fact is not one this
 * circuit is allowed to act on, so the caller can tell "nothing proven" from "proven and closed".
 */
export function noteComposerQuotaExhaustion(input: {
  providerId: string | null | undefined;
  kind: string | null | undefined;
  now: number;
}): boolean {
  if (!input.providerId || !input.kind) return false;
  if (!ZAICODE_FALLBACK_QUOTA_KINDS.has(input.kind)) return false;
  openProviderQuotaCircuit({
    providerId: input.providerId,
    now: input.now,
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

export interface ComposerQuotaRoute {
  selection: ModelSelection;
  /** The hold's end as a local time, for the UI to state. Null when the route ran as requested. */
  holdUntil: string | null;
  /** True when `selection` is the fallback pool rather than what the operator picked. */
  fallback: boolean;
}

/**
 * The single routing decision a hand-sent turn makes, taken through the same resolver the
 * dispatcher uses. Exactly-once: the turn either goes where the operator asked, or it goes to the
 * fallback once and says so -- never silently to a substitute, never retried onto a dead route.
 */
export function routeComposerSelection(
  requested: ModelSelection,
  view: ModelSelectionView | null,
  now: number,
): ComposerQuotaRoute {
  const fallback = pickZaicodeFallbackModel(view, requested.providerId);
  const route = resolveProviderQuotaRoute({ requested, fallback, now });
  if (!route.fallback) {
    return {
      selection: route.selection,
      holdUntil: route.circuit ? holdUntilLabel(route.circuit.until) : null,
      fallback: false,
    };
  }
  return {
    selection: carryReasoningLevel(requested, route.selection, view),
    holdUntil: holdUntilLabel(route.circuit!.until),
    fallback: true,
  };
}

function holdUntilLabel(until: number): string {
  return new Date(until).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}
