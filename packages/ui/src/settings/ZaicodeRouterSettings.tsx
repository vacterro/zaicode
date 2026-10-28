import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { getZaicodeRouterBridge, useZaicodeRouter, type ZaicodeRouterStatus } from "@/zaicode/zaicodeRouter.js";
import { ZaicodeRouterPools } from "./ZaicodeRouterPools.js";
import { ZaicodeRouterQuickStart } from "./ZaicodeRouterQuickStart.js";
import { ZaicodeRouterProviders } from "./ZaicodeRouterProviders.js";
import { ZaicodeRouterSubscriptions } from "./ZaicodeRouterSubscriptions.js";

/**
 * Settings -> ZAICODE -> Router: the local 9router (SAIRoute) from inside
 * ZAICODE. Providers and their keys, the pools ZAICODE runs on (SAIFREN,
 * SAIOPP, yours), today's traffic, and the router itself (start, dashboard,
 * the 9router_extra update). Every change is made in 9router and read back.
 */

type Tab = "overview" | "subscriptions" | "providers" | "pools";

const STATUS_TEXT: Record<ZaicodeRouterStatus, string> = {
  idle: "not checked yet",
  loading: "checking…",
  up: "running",
  down: "not reachable",
  unavailable: "desktop app only",
};

function fmt(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("en-US");
}

function Block({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border border-border bg-card p-3 text-ui-xs">
      <div>
        <h2 className="text-ui-lg text-foreground">{title}</h2>
        {hint ? <p className="mt-0.5 max-w-[640px] text-foreground-subtle">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Overview() {
  const router = useZaicodeRouter();
  const bridge = getZaicodeRouterBridge();
  const [confirmUpdate, setConfirmUpdate] = useState(false);
  const report = (result: { ok: boolean; message: string } | undefined) => {
    if (result) toast(result.message);
  };
  return (
    <Block
      title="9router"
      hint="ZAICODE's pools (SAIFREN, SAIOPP, …) are 9router combos. ZAICODE talks to it on this machine with 9router's own CLI credential; nothing is copied, the dashboard and this page show the same data."
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "border px-1.5",
            router.status === "up" ? "border-[#4f9a2f] text-[#7cc45a]" : router.status === "down" ? "border-destructive text-destructive" : "border-border text-foreground-subtle",
          )}
          data-zaicode-router-status={router.status}
        >
          ● {STATUS_TEXT[router.status]}
        </span>
        {router.version ? <span className="text-foreground">v{router.version}</span> : null}
        {router.version && !router.version.includes("extra") ? (
          <span className="text-[#e0a040]" title="The 9router_extra provider patches are not in this build">no 9router_extra patches</span>
        ) : null}
        {router.info ? <span className="text-foreground-subtlest">{router.info.url}</span> : null}
      </div>
      {router.message ? <p className="text-destructive">{router.message}</p> : null}
      {router.info && !router.info.credential ? (
        <p className="text-[#e0a040]">9router has not created its CLI credential on this machine yet: start it once, then Refresh.</p>
      ) : null}
      <div className="flex flex-wrap gap-1">
        <Button size="sm" variant="secondary" onClick={() => void router.refresh()} disabled={router.status === "loading"}>
          Refresh
        </Button>
        {router.status === "down" ? (
          <Button size="sm" variant="secondary" onClick={() => void bridge?.startZaicodeRouter?.().then(report).then(() => window.setTimeout(() => void router.refresh(), 6000))}>
            Start 9router
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={() => void bridge?.openZaicodeRouterDashboard?.("").then(report)}>
          Open dashboard
        </Button>
        {router.info?.extraUpdateScript ? (
          confirmUpdate ? (
            <span className="flex items-center gap-1 border border-[#e0a040] px-1">
              <span className="text-foreground">Stops 9router, backs up, installs the patched build, restores, restarts.</span>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setConfirmUpdate(false);
                  void bridge?.runZaicodeRouterExtraUpdate?.().then(report);
                }}
              >
                Run it
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmUpdate(false)}>
                Cancel
              </Button>
            </span>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setConfirmUpdate(true)} title={router.info.extraUpdateScript}>
              9router_extra update…
            </Button>
          )
        ) : null}
      </div>
      {router.status === "up" ? (
        <div className="grid grid-cols-2 gap-1 sm:grid-cols-5">
          {(
            [
              ["Providers", String(router.connections.length)],
              ["Pools", String(router.combos.length)],
              ["Requests today", fmt(router.usage?.requests ?? null)],
              ["Input tokens today", fmt(router.usage?.inputTokens ?? null)],
              ["Output tokens today", fmt(router.usage?.outputTokens ?? null)],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="border border-border px-2 py-1">
              <div className="text-foreground-subtlest">{label}</div>
              <div className="tabular-nums text-foreground">{value}</div>
            </div>
          ))}
        </div>
      ) : null}
      {router.status === "up" ? (
        <p className="text-foreground-subtle">
          Endpoint for any OpenAI-compatible client: <code className="text-foreground">{router.info?.url ?? ""}/v1</code>. In ZAICODE the
          pools are models of the SAIRoute provider (Settings → Models).
        </p>
      ) : null}
    </Block>
  );
}

export function ZaicodeRouterSettings() {
  const refresh = useZaicodeRouter((state) => state.refresh);
  const status = useZaicodeRouter((state) => state.status);
  const [tab, setTab] = useState<Tab>(() => {
    const requested = useZaicodeRouter.getState().requestedTab;
    return requested === "subscriptions" || requested === "providers" || requested === "pools" ? requested : "overview";
  });
  useEffect(() => {
    useZaicodeRouter.getState().requestTab(null);
    void refresh();
  }, [refresh]);
  const tabs: { id: Tab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "subscriptions", label: "Subscriptions as models" },
    { id: "providers", label: "Providers & keys" },
    { id: "pools", label: "Pools" },
  ];
  return (
    <div className="flex flex-col gap-3" data-zaicode-router-settings>
      <div className="flex gap-px" role="tablist">
        {tabs.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            className={cn(
              "border px-2 py-0.5 text-ui-xs",
              tab === entry.id
                ? "border-[var(--zaicode-highlight,var(--color-border-hover))] bg-selected text-foreground"
                : "border-border text-foreground-subtle hover:bg-hover hover:text-foreground",
            )}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      {tab === "overview" || status !== "up" ? <ZaicodeRouterQuickStart /> : null}
      {tab === "overview" || status !== "up" ? <Overview /> : null}
      {tab === "subscriptions" && status === "up" ? <ZaicodeRouterSubscriptions /> : null}
      {tab === "providers" && status === "up" ? <ZaicodeRouterProviders /> : null}
      {tab === "pools" && status === "up" ? <ZaicodeRouterPools /> : null}
    </div>
  );
}
