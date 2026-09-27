import { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useModelProviders } from "@/hooks/useModelProviders.js";
import { setZaicodeDefaultModel } from "@/zaicode/zaicodeDefaultModel.js";
import { readZaicodeCurrentWorkspace } from "@/zaicode/zaicodeEngines.js";
import { getZaicodeRouterBridge, useZaicodeRouter } from "@/zaicode/zaicodeRouter.js";
import {
  decorateZaicodeAccountGroups,
  refreshZaicodeSubscriptionReadiness,
  syncZaicodeSubscriptionModels,
  useZaicodeSubscriptions,
} from "@/zaicode/zaicodeSubscriptionSync.js";

/**
 * Router -> Subscriptions as models (SRC-061). Every subscription account
 * connected in 9router is a provider of its own in the model menu: "Codex 1",
 * "Claude 2", ... with the vendor's models and their real efforts. ZAICODE
 * keeps that list in step with 9router by itself; this page shows what it
 * did, how much each account has left, and says how the account is chosen.
 */

export function ZaicodeRouterSubscriptions() {
  const router = useZaicodeRouter();
  const subscriptions = useZaicodeSubscriptions();
  const workspacePath = readZaicodeCurrentWorkspace()?.path ?? "";
  const { modelProviders } = useModelProviders({ workspacePath });
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    void refreshZaicodeSubscriptionReadiness();
  }, []);

  const providerOf = useMemo(
    () => Object.fromEntries(Object.entries(subscriptions.providerAccount).map(([providerId, connectionId]) => [connectionId, providerId])),
    [subscriptions.providerAccount],
  );
  const bars = useMemo(
    () =>
      decorateZaicodeAccountGroups(
        subscriptions.accounts.map(
          (account): { key: string; readiness?: { percent: number | null; color: string; text: string; title: string } } => ({
            key: `registry-provider:${providerOf[account.connectionId] ?? ""}`,
          }),
        ),
        subscriptions,
      ),
    [providerOf, subscriptions],
  );
  const fillFirst = !router.settings || !("fallbackStrategy" in router.settings) || router.settings.fallbackStrategy !== "round-robin";

  const syncNow = async () => {
    const result = await syncZaicodeSubscriptionModels({ force: true });
    await refreshZaicodeSubscriptionReadiness({ force: true });
    toast(result.detail || "Up to date");
  };

  return (
    <section className="flex flex-col gap-2 border border-border bg-card p-3 text-ui-xs" data-zaicode-router-subscriptions data-zaicode-help="accounts">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-ui-lg text-foreground">Subscriptions as models</h2>
          <p className="mt-0.5 max-w-[720px] text-foreground-subtle">
            Every subscription account you connected in 9router is its own entry in the model menu. Pick the account (Codex 1, Claude 2,
            ...), then the model, then the effort next to it. It runs inside ZAICODE: its tools, transcript and queue, no terminal. New
            accounts and models appear by themselves, retired ones leave: at start, every 10 minutes and whenever the model menu opens.
          </p>
          <p className="mt-1 max-w-[720px] text-foreground-subtlest">
            How the account is chosen: just before each request ZAICODE puts that account first for its vendor in 9router. When it is at
            its limit, 9router answers with the next account of the same vendor instead, so the work does not stop. Two chats on two
            accounts of one vendor at the same time take turns only for the moment 9router picks the account. Whether a vendor allows its
            subscription through a proxy is that vendor&apos;s terms, not a ZAICODE setting.
          </p>
        </div>
        <Button size="sm" variant="outline" className="h-6 shrink-0 gap-1 px-2" disabled={subscriptions.busy} onClick={() => void syncNow()}>
          <RefreshCw className="size-3" />
          Sync now
        </Button>
      </div>
      {!fillFirst ? (
        <p className="text-[#e0a040]">
          9router rotates accounts (round-robin), so the account you pick is only a hint. For a real choice set 9router&apos;s account
          strategy to fill-first (its default) in the 9router dashboard.
        </p>
      ) : null}
      {subscriptions.last ? (
        <p className="text-foreground-subtlest">
          Last sync: {subscriptions.last.status === "failed" ? "failed -- " : ""}
          {subscriptions.last.detail}
        </p>
      ) : null}
      {subscriptions.accounts.length === 0 ? (
        <p className="text-foreground-subtle">
          No subscription is connected in 9router yet.{" "}
          <button type="button" className="underline" onClick={() => void getZaicodeRouterBridge()?.openZaicodeRouterDashboard?.("providers")}>
            Connect one in the 9router dashboard
          </button>{" "}
          (Codex, Antigravity, Claude Code, ... sign in there), then press Sync now.
        </p>
      ) : null}
      {subscriptions.accounts.map((account, index) => {
        const providerId = providerOf[account.connectionId];
        const provider = modelProviders.find((entry) => entry.providerId === providerId);
        const readiness = bars[index]?.readiness;
        const models = provider?.models ?? [];
        return (
          <div key={account.connectionId} className="flex flex-col gap-0.5 border border-border p-2" data-zaicode-account={account.label}>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="font-normal text-foreground hover:underline"
                onClick={() => setOpen(open === account.connectionId ? null : account.connectionId)}
              >
                {account.label}
              </button>
              <span className="min-w-0 truncate text-foreground-subtlest">{account.identity}</span>
              {!account.active ? <span className="text-[#e0a040]">off in 9router</span> : null}
              <span className="ml-auto flex items-center gap-2">
                {readiness ? (
                  <span className="inline-flex items-center gap-1 tabular-nums text-foreground-subtle" title={readiness.title}>
                    <span className="relative h-1.5 w-12 overflow-hidden bg-surface">
                      <span className="absolute inset-y-0 left-0" style={{ width: `${readiness.percent ?? 0}%`, background: readiness.color }} />
                    </span>
                    {readiness.text}
                  </span>
                ) : null}
                <span className="text-foreground-subtlest">{providerId ? `${models.length} models in the menu` : "not in the menu yet"}</span>
              </span>
            </div>
            {open === account.connectionId && provider ? (
              <div className="flex max-h-[220px] flex-col overflow-y-auto">
                {models.map((model) => (
                  <div key={model.modelId} className="flex items-center gap-2 border-b border-border/40 px-1 last:border-b-0">
                    <span className="min-w-0 flex-1 truncate font-mono text-foreground">{model.modelId}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-5 px-1"
                      title="Make it the default for new sessions (START)"
                      onClick={() => {
                        setZaicodeDefaultModel({ providerId: provider.providerId, modelId: model.modelId });
                        toast(`${account.label} / ${model.modelId} is the default for new sessions`);
                      }}
                    >
                      Default
                    </Button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}
