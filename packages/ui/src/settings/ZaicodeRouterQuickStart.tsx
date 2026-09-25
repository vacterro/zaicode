import { useEffect, useState } from "react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useServices } from "@/hooks/useServices.js";
import { ZAICODE_FREE_POOL, ZAICODE_FREE_PROVIDERS, ZAICODE_OWN_POOL, formatZaicodeDuration } from "@zcode/shared";
import { getZaicodeRouterBridge, useZaicodeRouter } from "@/zaicode/zaicodeRouter.js";
import {
  addZaicodeFreeKeyFromUi,
  describeZaicodeFreeModelsAdded,
  refreshZaicodeRouterHost,
  scanZaicodeFreeModelsFromUi,
  setZaicodeRouterModeFromUi,
  useZaicodeRouterSetup,
  type ZaicodeRouterMode,
  type ZaicodeRouterSetupStep,
} from "@/zaicode/zaicodeRouterSetup.js";
import { runZaicodeRouterSetup } from "@/zaicode/useZaicodeRouterAutoSetup.js";

/**
 * Router -> Overview, top: SAIFREN without setup (SRC-035, T-46). What runs,
 * whether the first token came, one Autotroubleshoot button that repairs the
 * chain, the free-model scan, free keys in one paste, and where SAIOPP (your
 * own best: subscriptions, paid keys) is filled.
 */

const MODES: readonly { value: ZaicodeRouterMode; label: string; hint: string }[] = [
  { value: "auto", label: "Auto", hint: "Your 9router when this machine has one, else ZAICODE's own" },
  { value: "shared", label: "My 9router", hint: "The 9router you run yourself (port 20128); ZAICODE never starts or stops it on its own" },
  { value: "isolated", label: "ZAICODE's own", hint: "A private 9router run by ZAICODE (own data folder and port), nothing to install" },
];

const STEP_MARK: Record<ZaicodeRouterSetupStep["status"], { mark: string; className: string }> = {
  ok: { mark: "✓", className: "text-[var(--color-success)]" },
  fixed: { mark: "✚", className: "text-[var(--zaicode-highlight,var(--color-warning))]" },
  failed: { mark: "✗", className: "text-destructive" },
  skipped: { mark: "·", className: "text-foreground-subtlest" },
};

function StepList({ steps }: { steps: readonly ZaicodeRouterSetupStep[] }) {
  return (
    <ul className="flex flex-col gap-px" data-zaicode-router-steps>
      {steps.map((step) => (
        <li key={step.id} className="grid grid-cols-[14px_150px_1fr] items-baseline gap-1">
          <span className={STEP_MARK[step.status].className}>{STEP_MARK[step.status].mark}</span>
          <span className="truncate text-foreground">{step.label}</span>
          <span className="min-w-0 break-words text-foreground-subtle">{step.detail}</span>
        </li>
      ))}
    </ul>
  );
}

function FreeKeyRow({ providerId }: { providerId: string }) {
  const provider = ZAICODE_FREE_PROVIDERS.find((entry) => entry.id === providerId)!;
  const platform = usePlatform();
  const busy = useZaicodeRouterSetup((state) => state.busy);
  const refreshRouter = useZaicodeRouter((state) => state.refresh);
  const [key, setKey] = useState("");
  const add = async () => {
    const result = await addZaicodeFreeKeyFromUi(provider.id, key);
    toast(result.message);
    if (result.ok) {
      setKey("");
      void refreshRouter();
    }
  };
  return (
    <div className="grid grid-cols-[170px_1fr] items-center gap-2 border-b border-border/40 py-0.5 last:border-b-0">
      <span className="truncate text-foreground" title={provider.blurb}>
        {provider.name}
      </span>
      <span className="flex min-w-0 items-center gap-1">
        <span className="min-w-0 flex-1 truncate text-foreground-subtlest" title={provider.blurb}>
          {provider.blurb}
        </span>
        {provider.keyUrl ? (
          <button type="button" className="shrink-0 underline text-foreground-subtle" onClick={() => platform.openExternal(provider.keyUrl!)}>
            get free key
          </button>
        ) : null}
        <input
          type="password"
          className="w-40 border border-border bg-background px-1 text-foreground"
          placeholder="paste key"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && key.trim()) void add();
          }}
        />
        <Button size="sm" variant="ghost" className="h-5 px-1" disabled={!key.trim() || busy === "key"} onClick={() => void add()}>
          Add
        </Button>
      </span>
    </div>
  );
}

export function ZaicodeRouterQuickStart() {
  const { providerSettingsService } = useServices();
  const state = useZaicodeRouterSetup();
  const refreshRouter = useZaicodeRouter((store) => store.refresh);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    void refreshZaicodeRouterHost();
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const host = state.host;
  const last = state.last;
  const steps = [...(last?.steps ?? []), ...(state.appStep ? [state.appStep] : [])];
  const troubleshoot = async () => {
    const result = await runZaicodeRouterSetup(providerSettingsService, "troubleshoot");
    void refreshRouter();
    toast(result?.ok ? `${ZAICODE_FREE_POOL} works: ${result.firstToken?.detail ?? "ok"}` : "Some steps need you: see the list");
  };
  const scan = async () => {
    const result = await scanZaicodeFreeModelsFromUi();
    const card = result ? describeZaicodeFreeModelsAdded(result.added) : null;
    toast(card ? card.title : result ? "No new free models since the last scan" : "Scan unavailable");
    void refreshRouter();
  };
  return (
    <section className="flex flex-col gap-2 border border-[var(--zaicode-highlight,var(--color-border))] bg-card p-3 text-ui-xs" data-zaicode-router-quickstart>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-ui-lg text-foreground">{ZAICODE_FREE_POOL} · free AI, nothing to set up</h2>
          <p className="max-w-[680px] text-foreground-subtle">
            ZAICODE keeps a router with free models ready: open ZAICODE, write a task, press Enter. {ZAICODE_FREE_POOL} holds the free ones (no
            account needed for the first ones, more with free keys below); {ZAICODE_OWN_POOL} holds your own best (subscriptions, paid keys).
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Button size="sm" variant="secondary" disabled={state.busy !== null} onClick={() => void troubleshoot()} data-zaicode-autotroubleshoot>
            {state.busy === "troubleshoot" || state.busy === "setup" ? "Checking…" : "Autotroubleshoot"}
          </Button>
          <span className="text-foreground-subtlest">checks and repairs everything, step by step</span>
        </div>
      </div>

      <div className="grid grid-cols-[90px_1fr] items-center gap-x-2 gap-y-1">
        <span className="text-foreground-subtle">Router</span>
        <span className="flex flex-wrap items-center gap-1">
          {MODES.map((mode) => (
            <button
              key={mode.value}
              type="button"
              title={mode.hint}
              disabled={state.busy !== null}
              className={cn(
                "border px-1.5 leading-4",
                host?.requestedMode === mode.value ? "border-[var(--zaicode-highlight,var(--color-border-hover))] bg-selected text-foreground" : "border-border text-foreground-subtle hover:bg-hover",
              )}
              onClick={() => void setZaicodeRouterModeFromUi(mode.value).then(() => runZaicodeRouterSetup(providerSettingsService, "setup")).then(() => refreshRouter())}
            >
              {mode.label}
            </button>
          ))}
          <span className="text-foreground-subtlest">
            {host ? `${host.mode === "isolated" ? "ZAICODE's own" : "yours"} · ${host.url}${host.managed ? (host.running ? " · running" : " · stopped") : ""}${host.restarts > 0 ? ` · restarted ${host.restarts}×` : ""}` : "…"}
          </span>
        </span>
        <span className="text-foreground-subtle">First token</span>
        <span className={cn(last?.firstToken ? (last.firstToken.ok ? "text-[var(--color-success)]" : "text-destructive") : "text-foreground-subtlest")}>
          {last?.firstToken
            ? last.firstToken.ok
              ? `${ZAICODE_FREE_POOL} answered ${last.firstToken.detail.replace(/^answered /, "")}${last.firstToken.servedBy ? ` (${last.firstToken.servedBy})` : ""}`
              : last.firstToken.detail
            : "not checked in this run (Autotroubleshoot checks it)"}
        </span>
        <span className="text-foreground-subtle">Free scan</span>
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-foreground-subtlest">
            {state.lastScanAt ? `last ${formatZaicodeDuration(now - state.lastScanAt)} ago · daily` : "not yet · runs daily"}
          </span>
          <Button size="sm" variant="ghost" className="h-5 px-1" disabled={state.busy !== null} onClick={() => void scan()}>
            {state.busy === "scan" ? "Scanning…" : "Scan now"}
          </Button>
          {state.scan && state.scan.added.length > 0 ? (
            <span className="text-foreground">added: {state.scan.added.map((entry) => entry.id).join(", ")}</span>
          ) : null}
        </span>
      </div>

      {steps.length > 0 ? (
        <div className="border-t border-border/60 pt-1">
          <span className="text-foreground-subtle">{state.lastKind === "troubleshoot" ? "Autotroubleshoot" : "Start-up check"}</span>
          <StepList steps={steps} />
        </div>
      ) : null}

      <div className="border-t border-border/60 pt-1">
        <span className="text-foreground-subtle">More free models: one free key each (no card), pasted once</span>
        {ZAICODE_FREE_PROVIDERS.filter((provider) => !provider.keyless).map((provider) => (
          <FreeKeyRow key={provider.id} providerId={provider.id} />
        ))}
      </div>

      <div className="border-t border-border/60 pt-1 text-foreground-subtle">
        {ZAICODE_OWN_POOL}: your subscriptions (Claude, Codex, Gemini CLI, Cline, Kiro…) sign in once in{" "}
        <button type="button" className="underline" onClick={() => void getZaicodeRouterBridge()?.openZaicodeRouterDashboard?.("providers")}>
          the router's Providers page
        </button>{" "}
        (OAuth, no key to copy), then put the models you trust most into {ZAICODE_OWN_POOL} under Pools; they also appear under
        “Subscriptions as models”.
      </div>
    </section>
  );
}
