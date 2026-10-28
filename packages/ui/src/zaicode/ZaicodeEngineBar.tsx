import { AppWindow, Boxes, ExternalLink, EyeOff, KeyRound, Play, RefreshCw, Settings2, Terminal, Wrench } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useRef } from "react";
import { useServices } from "@/hooks/useServices.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import { toast } from "@/components/ui/toast.js";
import { setPendingSettingsSection } from "@/lib/settingsNavigation.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import type { ZaicodeEngineAccount } from "@zcode/shared";
import { projectZaicodePoolGroups, useZaicodePoolGroups } from "./ZaicodePoolPicker.js";
import { requestZaicodeComposerModel, useZaicodeDefaultModel } from "./zaicodeDefaultModel.js";
import { syncZaicodeSubscriptionModels, useZaicodeSubscriptions } from "./zaicodeSubscriptionSync.js";
import { resolveZaicodeSubscriptionGroup } from "./zaicodeSubscriptionSelection.js";
import type { ZaicodePoolOption } from "./zaicodeRoutingModel.js";
import {
  readZaicodeCurrentWorkspace,
  readZaicodeEngine,
  refreshZaicodeEngineLimits,
  updateZaicodeEnginesConfig,
  useZaicodeActiveEngine,
  useZaicodeResetRefresh,
  useZaicodeEngines,
  launchableZaicodeAccounts,
  zaicodeRemainingColor,
} from "./zaicodeEngines.js";
import { useZaicodeClock, zaicodeReadingTitle, zaicodeVendorColor } from "./ZaicodeLimitViews.js";
import { focusZaicodeWorker, launchZaicodeWorker, runZaicodeFixCommand, useZaicodeWorkers } from "./zaicodeWorkers.js";
import { isZaicodeEngineShown, useZaicodeMeterPrefs, zaicodeAvailabilityTint, zaicodeMeterFillPercent } from "./zaicodeMeterPrefs.js";
import { readZaicodeFresh, useZaicodeFreshVersion, useZaicodeNotifySettings } from "./zaicodeNotifications.js";
import { zaicodeGlowHandlers, zaicodeGlowStyle } from "./zaicodeGlow.js";
import { playZaicodeSound } from "./zaicodeSoundBus.js";
import { useZaicodeRouter } from "./zaicodeRouter.js";
import { useZaicodePreparedMeters } from "./ZaicodeSchedulerBits.js";
import { useZaicodeEngineBarPrefs } from "./zaicodeEngineBarPrefs.js";
import { ZaicodeEngineModelRow } from "./ZaicodeEngineModelRow.js";

/**
 * Sidebar top: every engine ZAICODE can work with, picked directly — no
 * combobox. Row 1 = the in-app model pools (SAIRoute: SAIFREN / SAIOPP).
 * Row 2 = the operator's subscriptions, each tile filled by
 * the quota it has left (green -> amber -> red, dark = blocked, dashed = not
 * connected), its background tinted by availability (Settings -> Engines &
 * limits, "Availability tint"), and glowing for a while after a window reset.
 * Click selects that subscription's in-app model in the focused chat.
 * Right-click exposes explicit worker commands and connection settings.
 */
export function ZaicodeEngineBar() {
  const { providerSettingsService } = useServices();
  const selectionGeneration = useRef(0);
  const { groups } = useZaicodePoolGroups();
  const selectedModel = useZaicodeDefaultModel();
  const activeEngine = useZaicodeActiveEngine();
  const engines = useZaicodeEngines();
  // T-266: refresh quota the instant a window resets so both limit meters (title
  // bar and this sidebar) repaint instead of lagging the 30s poll with spent data.
  useZaicodeResetRefresh();
  const workers = useZaicodeWorkers().workers;
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  const now = useZaicodeClock(30_000);
  const preparedMeter = useZaicodePreparedMeters();
  const meterPrefs = useZaicodeMeterPrefs();
  // Re-render when a tile starts or stops glowing.
  useZaicodeFreshVersion();
  const glowRules = useZaicodeNotifySettings().glow;
  const barPrefs = useZaicodeEngineBarPrefs();
  const subscriptions = useZaicodeSubscriptions();
  const selectModel = (option: ZaicodePoolOption, reasoningLevel?: string) => {
    selectionGeneration.current += 1;
    const level = reasoningLevel ?? (option.reasoningLevels.includes(selectedModel?.reasoningLevel ?? "") ? selectedModel?.reasoningLevel : option.reasoningLevels.includes("medium") ? "medium" : option.reasoningLevels[0]);
    const applied = requestZaicodeComposerModel({ providerId: option.providerId, modelId: option.modelId, ...(level ? { reasoningLevel: level } : {}) });
    playZaicodeSound("engine.select");
    if (!applied) toast(`${option.providerLabel} / ${option.modelId}${level ? ` · ${level}` : ""} selected for the next chat.`);
  };
  const subscriptionGroup = (account: ZaicodeEngineAccount) => resolveZaicodeSubscriptionGroup(account, subscriptions.accounts, subscriptions.providerAccount, groups);
  const selectSubscription = async (account: ZaicodeEngineAccount) => {
    const generation = ++selectionGeneration.current;
    try {
    await syncZaicodeSubscriptionModels({ force: true });
    const freshGroups = projectZaicodePoolGroups(await providerSettingsService.getView());
    if (selectionGeneration.current !== generation) return;
    const state = useZaicodeSubscriptions.getState();
    const available = resolveZaicodeSubscriptionGroup(account, state.accounts, state.providerAccount, freshGroups);
    const option = available?.options.find((candidate) => candidate.modelId === selectedModel?.modelId) ?? available?.options[0];
    if (option) { selectModel(option); return; }
    toast(`Connect ${account.label} and enable a model in Router → Subscriptions.`);
    useZaicodeRouter.getState().requestTab("subscriptions");
    setPendingSettingsSection("zaicodeRouter");
    openSettingsTab();
    } catch (error) {
      if (selectionGeneration.current === generation) toast(error instanceof Error ? error.message : String(error));
    }
  };
  const accounts = launchableZaicodeAccounts(engines).filter(
    (account) =>
      // A tile that needs sign-in stays: it is where the fix lives.
      readZaicodeEngine(account, engines.limits[account.id], now).tone === "offline" ||
      isZaicodeEngineShown(account, engines.limits[account.id], meterPrefs, "tiles", now),
  );

  const openEngineSettings = () => {
    setPendingSettingsSection("zaicodeEngines");
    openSettingsTab();
  };

  const launch = (account: ZaicodeEngineAccount, where: "dock" | "window" | "external" = "dock", prompt?: string) => {
    const project = readZaicodeCurrentWorkspace()?.path;
    if (!project) {
      toast("Open a project first: the worker starts in its folder.");
      return;
    }
    void launchZaicodeWorker({ account, projectPath: project, where, ...(prompt !== undefined ? { prompt } : {}) }).then(
      (result) => toast(result.message),
    );
  };

  const fix = (account: ZaicodeEngineAccount) => {
    if (!account.fixCommand) {
      openEngineSettings();
      return;
    }
    runZaicodeFixCommand({
      title: `Fix ${account.label}`,
      command: account.fixCommand,
      cwd: readZaicodeCurrentWorkspace()?.path ?? account.home ?? "C:\\",
      accountId: account.id,
    });
  };

  return (
    <div className="flex min-w-0 flex-col gap-px px-2 py-1 text-ui-xs" data-zaicode-engine-bar data-zaicode-help="engines">
      <ZaicodeEngineModelRow groups={groups} providerAccount={subscriptions.providerAccount} selectedModel={selectedModel} activeEngine={activeEngine} selectModel={selectModel} />
      {accounts.length > 0 && barPrefs.showSubs ? (
        <div className="flex min-w-0 items-center gap-1">
          <button
            type="button"
            className="flex size-5 shrink-0 items-center justify-center border border-border text-foreground-subtle hover:bg-hover hover:text-foreground"
            title="Subscriptions (your Claude, Codex, Antigravity, ZCode logins) — opens Settings → Engines & limits"
            aria-label="Subscriptions settings"
            data-zaicode-sound="ui.settings"
            onClick={openEngineSettings}
          >
            <KeyRound className="size-3" />
          </button>
          <div className="flex min-w-0 flex-1 flex-wrap gap-px" role="radiogroup" aria-label="Subscription engines">
            {accounts.map((account) => {
              const snapshot = engines.limits[account.id];
              const reading = readZaicodeEngine(account, snapshot, now);
              const linkedGroup = subscriptionGroup(account);
              const active = activeEngine === account.id || (activeEngine === null && linkedGroup !== null && selectedModel?.providerId === linkedGroup.providerId);
              const running = workers.filter((worker) => worker.accountId === account.id && worker.exitCode === null).length;
              const probing = engines.probing.includes(account.id);
              // T-134: a login never set up here is dimmed by its tone, without the "!" of a broken one.
              const offline = reading.tone === "offline" && !account.optional;
              const fill = zaicodeMeterFillPercent(reading.remaining, meterPrefs.fill);
              const fresh = readZaicodeFresh(`engine:${account.id}`);
              const prepared = preparedMeter(account.id);
              const tint =
                active || offline || reading.remaining === null
                  ? undefined
                  : zaicodeAvailabilityTint(zaicodeRemainingColor(reading.remaining), meterPrefs.availabilityTint);
              return (
                <ContextMenu key={account.id}>
                  <ContextMenuTrigger asChild>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={active}
                      data-zaicode-engine-tile={account.short}
                      className={cn(
                        "relative min-w-[30px] flex-1 overflow-hidden border px-1 pb-[4px] pt-0.5 text-center font-semibold",
                        active
                          ? "border-[var(--zaicode-highlight,var(--color-border-hover))] bg-selected text-foreground"
                          : "border-border bg-[var(--zaicode-tile-tint,transparent)] text-foreground-subtle hover:bg-hover hover:text-foreground",
                        offline && "border-dashed opacity-70",
                        reading.availability === "blocked" && "text-foreground-subtlest",
                      )}
                      style={
                        fresh
                          ? { ...zaicodeGlowStyle(fresh, now, glowRules), outlineOffset: "-1px" }
                          : {
                              ...(tint ? ({ "--zaicode-tile-tint": tint } as React.CSSProperties) : {}),
                              ...prepared.lights?.style,
                            }
                      }
                      data-zh={fresh ? undefined : prepared.lights?.["data-zh"]}
                      data-zh-shape={fresh ? undefined : prepared.lights?.["data-zh-shape"]}
                      data-zh-keep={fresh ? undefined : prepared.lights?.["data-zh-keep"]}
                      data-zaicode-fresh={fresh ? "true" : undefined}
                      data-zaicode-prepared={prepared.hint ? "true" : undefined}
                      title={`${zaicodeReadingTitle(account, snapshot, now)}${fresh ? `\n${fresh.label}` : ""}${prepared.hint ? `\n${prepared.hint}` : ""}\n\nClick: select subscription model in this chat · Right-click: workers and settings`}
                      onClick={() => void selectSubscription(account)}
                      // A click here picks the START engine, so it never doubles as "seen": hover (if on) or the meter does.
                      onMouseEnter={zaicodeGlowHandlers([`engine:${account.id}`], Boolean(fresh)).onMouseEnter}
                      onMouseLeave={zaicodeGlowHandlers([`engine:${account.id}`], Boolean(fresh)).onMouseLeave}
                    >
                      <span className="relative z-10" style={active ? undefined : { color: zaicodeVendorColor(account.vendor) }}>
                        {account.short}
                      </span>
                      {running > 0 ? (
                        <span className="absolute right-0.5 top-0.5 z-10 size-1.5 bg-[#4f9a2f]" title={`${running} running`} />
                      ) : null}
                      {offline ? (
                        <span className="absolute left-0.5 top-0 z-10 text-[9px] leading-none text-[#c9a227]">!</span>
                      ) : null}
                      <span className="absolute inset-x-0 bottom-0 h-[3px] bg-black/40" aria-hidden="true">
                        <span
                          className={cn("absolute inset-y-0 left-0", probing && "animate-pulse")}
                          style={{
                            width: `${fill}%`,
                            background: zaicodeRemainingColor(reading.remaining),
                            opacity: reading.stale ? 0.55 : 1,
                          }}
                        />
                      </span>
                    </button>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="w-64" data-zaicode-engine-menu>
                    <ContextMenuItem disabled={account.status === "cli-missing"} onSelect={() => launch(account)}>
                      <Play className="size-4" />
                      Start {account.short} worker in this project
                    </ContextMenuItem>
                    {running > 0 ? (
                      <ContextMenuItem
                        onSelect={() => {
                          const worker = workers.find((item) => item.accountId === account.id && item.exitCode === null);
                          if (worker) focusZaicodeWorker(worker.id);
                        }}
                      >
                        <Terminal className="size-4" />
                        Show the running {account.short} worker
                      </ContextMenuItem>
                    ) : null}
                    <ContextMenuItem disabled={account.status === "cli-missing"} onSelect={() => launch(account, "dock", "")}>
                      <Terminal className="size-4" />
                      Open {account.short} idle (no first prompt)
                    </ContextMenuItem>
                    <ContextMenuItem disabled={account.status === "cli-missing"} onSelect={() => launch(account, "window")}>
                      <AppWindow className="size-4" />
                      Start in a worker window (inside ZAICODE)
                    </ContextMenuItem>
                    <ContextMenuItem disabled={account.status === "cli-missing"} onSelect={() => launch(account, "external")}>
                      <ExternalLink className="size-4" />
                      Start in a separate PowerShell window
                    </ContextMenuItem>
                    <ContextMenuItem
                      onSelect={() => {
                        useZaicodeRouter.getState().requestTab("subscriptions");
                        setPendingSettingsSection("zaicodeRouter");
                        openSettingsTab();
                      }}
                    >
                      <Boxes className="size-4" />
                      Use {account.short} inside ZAICODE as a model…
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => void refreshZaicodeEngineLimits(account.id).then(() => playZaicodeSound("limits.refresh"))}>
                      <RefreshCw className="size-4" />
                      Read {account.short} quota now
                    </ContextMenuItem>
                    {account.status !== "ready" ? (
                      <ContextMenuItem onSelect={() => fix(account)}>
                        <Wrench className="size-4" />
                        Fix: {account.statusDetail || "troubleshoot"}
                      </ContextMenuItem>
                    ) : null}
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      onSelect={() =>
                        void updateZaicodeEnginesConfig({
                          hiddenAccounts: [...engines.config.hiddenAccounts, account.id],
                        })
                      }
                    >
                      <EyeOff className="size-4" />
                      Hide {account.short} from the bar
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={openEngineSettings}>
                      <Settings2 className="size-4" />
                      Engines settings…
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
