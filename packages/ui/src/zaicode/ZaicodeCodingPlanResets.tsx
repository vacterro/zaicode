import { useEffect, useMemo, useState } from "react";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import { useCodingPlanQuotaResetUi, type CodingPlanQuotaResetTypeController } from "@/hooks/useCodingPlanQuotaResetUi.js";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { useUsageEntitlement } from "@/hooks/useUsageEntitlement.js";
import { resolveEntitledAccountProviderAccess, resolveEntitledAccountProviderAccessFingerprint } from "@/lib/accountProviderAccess.js";
import { findCodingPlanQuotaLimit, isCodingPlanQuotaLimitFull } from "@/lib/codingPlanQuotaPresentation.js";
import { resolveCodingPlanQuotaResetLimit } from "@/lib/codingPlanQuotaResetUi.js";
import { buildUsageEntitlementCacheKey } from "@/lib/usageEntitlementCache.js";
import { cn } from "@/components/lib/utils.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
import { formatZaicodeRemaining } from "./zaicodeTimers.js";

/**
 * SRC-081: "show the resets for ZCode Coding Plans too, and let me reset right from there --
 * today I activate them in their ZCode, which is inconvenient."
 *
 * A Coding Plan hands out reset opportunities (a spent 5-hour or weekly window refilled on
 * demand). ZCode shows them in its own usage panel; ZAICODE's title-bar reset timer listed
 * every other subscription's coming reset and none of these. This reads the SAME account state
 * ZCode reads (the entitled Z.ai / BigModel Coding Plan connection, the same reset controller,
 * the same use + status reconciliation) and puts the count, the expiry and the button in the
 * timer's list. Nothing here re-implements a reset: the button calls ZCode's own controller.
 */

export interface ZaicodePlanResetOpportunity {
  kind: "session" | "weekly";
  count: number;
  /** Earliest expiry of an opportunity (ms), null when unknown. */
  expiresAt: number | null;
  processing: boolean;
  /** Resetting a window that is already full gains nothing. */
  quotaFull: boolean;
}

/** Pure: what the list shows for one window; null = nothing to show. */
export function zaicodePlanResetOpportunity(
  kind: ZaicodePlanResetOpportunity["kind"],
  controller: Pick<CodingPlanQuotaResetTypeController, "entry" | "opportunityVisible" | "processing">,
  quotaFull: boolean,
): ZaicodePlanResetOpportunity | null {
  const count = controller.entry?.opportunityCount ?? 0;
  if (!controller.opportunityVisible || count <= 0) return null;
  return { kind, count, expiresAt: controller.entry?.opportunityExpiresAt ?? null, processing: controller.processing, quotaFull };
}

export interface ZaicodePlanResets {
  /** The connection the resets belong to (null = no entitled Coding Plan on this machine). */
  label: string | null;
  opportunities: ZaicodePlanResetOpportunity[];
  total: number;
  reset: (kind: ZaicodePlanResetOpportunity["kind"]) => Promise<void>;
}

/** The reset opportunities of the entitled ZCode Coding Plan, read the way ZCode reads them. */
export function useZaicodePlanResets(): ZaicodePlanResets {
  const providerSettingsRead = useProviderSettingsView();
  const view = providerSettingsRead.state.status === "ready" ? providerSettingsRead.state.view : null;
  const found = useMemo(() => {
    for (const providerId of [BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan, BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan]) {
      const access = resolveEntitledAccountProviderAccess(view, providerId);
      if (access) return { providerId, access };
    }
    return null;
  }, [view]);
  const providerId = found?.providerId;
  const entitlement = useUsageEntitlement({
    enabled: Boolean(found),
    includeSubscription: true,
    ...(providerId ? { preferredProviderId: providerId } : {}),
    ...(found ? { accountAccess: found.access.access } : {}),
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    cacheKey: providerId
      ? buildUsageEntitlementCacheKey({ providerId, providerFingerprint: resolveEntitledAccountProviderAccessFingerprint(view, providerId) })
      : undefined,
    refreshOnMount: false,
  });
  const refresh = entitlement.refresh;
  useEffect(() => {
    if (found) void refresh({ silent: true, reason: "access" });
  }, [found, refresh]);
  const resetUi = useCodingPlanQuotaResetUi({
    sourceKey: providerId,
    ...(providerId ? { preferredProviderId: providerId } : {}),
    ...(found ? { accountAccess: found.access.access } : {}),
    onEntitlementRefresh: () => refresh({ silent: true, reason: "access" }),
    enabled: Boolean(found),
  });
  const limits = entitlement.snapshot?.quota?.limits ?? [];
  const fiveHour = resolveCodingPlanQuotaResetLimit(findCodingPlanQuotaLimit(limits, "TOKENS_LIMIT", 3, 5), resetUi.entry);
  const weekly = resolveCodingPlanQuotaResetLimit(findCodingPlanQuotaLimit(limits, "TOKENS_LIMIT", 6), resetUi.week.entry);
  const opportunities = [
    zaicodePlanResetOpportunity("session", resetUi, Boolean(fiveHour) && isCodingPlanQuotaLimitFull(fiveHour)),
    zaicodePlanResetOpportunity("weekly", resetUi.week, Boolean(weekly) && isCodingPlanQuotaLimitFull(weekly)),
  ].filter((entry): entry is ZaicodePlanResetOpportunity => entry !== null);
  return {
    label: found ? (found.access.label ?? "ZCode Coding Plan") : null,
    opportunities,
    total: opportunities.reduce((sum, entry) => sum + entry.count, 0),
    reset: (kind) => (kind === "session" ? resetUi.reset() : resetUi.week.reset()),
  };
}

/** The list section: count, expiry and a Reset button per window, one confirm before a reset is spent. */
export function ZaicodePlanResetsSection({ resets, now }: { resets: ZaicodePlanResets; now: number }) {
  const [busy, setBusy] = useState<string | null>(null);
  if (!resets.label || resets.opportunities.length === 0) return null;
  const run = async (kind: ZaicodePlanResetOpportunity["kind"]) => {
    const name = kind === "session" ? "5-hour" : "weekly";
    // A reset is spent for good: one confirmation, in words, in the app's own dialog (T-128).
    const confirmed = await useConfirmDialogStore.getState().requestConfirmation({
      title: `Use one ${name} reset?`,
      description: `${resets.label}: the ${name} window refills now and the reset is used up.`,
      confirmLabel: "Use the reset",
      confirmVariant: "destructive",
    });
    if (!confirmed) return;
    setBusy(kind);
    try {
      await resets.reset(kind);
      toast(`${resets.label}: the ${name} window was reset.`, { durationMs: 6000 });
    } catch (error) {
      toast(`${resets.label}: the reset did not go through (${error instanceof Error ? error.message : String(error)}).`, { durationMs: 9000, variant: "warning" });
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="mt-2 border-t border-border pt-1.5 text-ui-xs text-foreground" data-zaicode-plan-resets="">
      <div className="mb-1 font-semibold">{resets.label} · resets you can use</div>
      <table className="w-full border-collapse tabular-nums">
        <tbody>
          {resets.opportunities.map((entry) => {
            const disabled = busy !== null || entry.processing || entry.quotaFull;
            return (
              <tr key={entry.kind} data-zaicode-plan-reset={entry.kind}>
                <td className="pr-2">{entry.kind === "session" ? "Session (5 h)" : "Weekly"}</td>
                <td className="pr-2 text-right font-semibold">×{entry.count}</td>
                <td className="pr-2 text-right text-foreground-subtle">
                  {entry.expiresAt ? `expires in ${formatZaicodeRemaining(Math.max(0, (entry.expiresAt - now) / 1000), { minutes: true })}` : ""}
                </td>
                <td className="text-right">
                  <button
                    type="button"
                    className={cn(
                      "border border-border px-1.5 hover:bg-hover",
                      disabled && "cursor-default opacity-50 hover:bg-transparent",
                    )}
                    disabled={disabled}
                    title={entry.quotaFull ? "The window is full: a reset would gain nothing." : "Use one reset now (asks first)"}
                    onClick={() => void run(entry.kind)}
                    data-zaicode-plan-reset-button={entry.kind}
                  >
                    {busy === entry.kind || entry.processing ? "resetting…" : "Reset now"}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
