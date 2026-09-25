import { AppWindow, Boxes, ExternalLink, EyeOff, Play, RefreshCw, Settings2, Terminal, Wrench } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
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
import { useZaicodePoolGroups } from "./ZaicodePoolPicker.js";
import { setZaicodeDefaultModel, useZaicodeDefaultModel } from "./zaicodeDefaultModel.js";
import {
  readZaicodeCurrentWorkspace,
  readZaicodeEngine,
  refreshZaicodeEngineLimits,
  setZaicodeActiveEngine,
  updateZaicodeEnginesConfig,
  useZaicodeActiveEngine,
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

/**
 * Sidebar top: every engine ZAICODE can work with, picked directly — no
 * combobox. Row 1 = the in-app model pools (SAIRoute: SAIFREN / SAIOPP).
 * Row 2 = the operator's subscriptions as worker engines, each tile filled by
 * the quota it has left (green -> amber -> red, dark = blocked, dashed = not
 * connected), its background tinted by availability (Settings -> Engines &
 * limits, "Availability tint"), and glowing for a while after a window reset.
 * Click selects the engine START uses; double-click starts a worker in the
 * current project right away; right-click has the rest.
 */
export function ZaicodeEngineBar() {
  const { groups } = useZaicodePoolGroups();
  const selectedModel = useZaicodeDefaultModel();
  const activeEngine = useZaicodeActiveEngine();
  const engines = useZaicodeEngines();
  const workers = useZaicodeWorkers().workers;
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  const now = useZaicodeClock(30_000);
  const preparedMeter = useZaicodePreparedMeters();
  const meterPrefs = useZaicodeMeterPrefs();
  // Re-render when a tile starts or stops glowing.
  useZaicodeFreshVersion();
  const glowRules = useZaicodeNotifySettings().glow;
  const group = groups[0];
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
    <div className="flex min-w-0 flex-col gap-px px-2 py-1 text-ui-xs" data-zaicode-engine-bar>
      {group ? (
        <div className="flex min-w-0 items-center gap-1" title={`In-app model pools (${group.providerLabel})`}>
          {group.isRouter ? (
            <button
              type="button"
              className="w-[58px] shrink-0 truncate text-left text-foreground-subtlest hover:text-foreground"
              title="Pools come from 9router. Click: Router settings (providers, keys, pools)."
              onClick={() => {
                setPendingSettingsSection("zaicodeRouter");
                openSettingsTab();
              }}
            >
              {group.providerLabel}
            </button>
          ) : (
            <span className="w-[58px] shrink-0 truncate text-foreground-subtlest">{group.providerLabel}</span>
          )}
          {/* SRC-035: pools wrap onto a second line instead of shrinking to unreadable stubs. */}
          <div className="flex min-w-0 flex-1 flex-wrap gap-px" role="radiogroup">
            {group.options.slice(0, 4).map((option) => {
              const active =
                activeEngine === null &&
                selectedModel?.providerId === option.providerId &&
                selectedModel.modelId === option.modelId;
              return (
                <button
                  key={`${option.providerId}/${option.modelId}`}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className={cn(
                    "min-w-[64px] flex-1 truncate border px-1.5 py-0.5 text-center",
                    active
                      ? "border-[var(--zaicode-highlight,var(--color-border-hover))] bg-selected text-foreground"
                      : "border-border bg-transparent text-foreground-subtle hover:bg-hover hover:text-foreground",
                  )}
                  title={`Use ${option.modelId} for new sessions (in-app agent)`}
                  onClick={() => {
                    setZaicodeActiveEngine(null);
                    setZaicodeDefaultModel({ providerId: option.providerId, modelId: option.modelId });
                    playZaicodeSound("engine.select");
                  }}
                >
                  {option.modelId}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
      {accounts.length > 0 ? (
        <div className="flex min-w-0 items-center gap-1">
          <button
            type="button"
            className="w-[58px] shrink-0 truncate text-left text-foreground-subtlest hover:text-foreground"
            title="Subscriptions as worker engines. Click for Engines settings."
            onClick={openEngineSettings}
          >
            Subs
          </button>
          <div className="flex min-w-0 flex-1 flex-wrap gap-px" role="radiogroup" aria-label="Subscription engines">
            {accounts.map((account) => {
              const snapshot = engines.limits[account.id];
              const reading = readZaicodeEngine(account, snapshot, now);
              const active = activeEngine === account.id;
              const running = workers.filter((worker) => worker.accountId === account.id && worker.exitCode === null).length;
              const probing = engines.probing.includes(account.id);
              const offline = reading.tone === "offline";
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
                      title={`${zaicodeReadingTitle(account, snapshot, now)}${fresh ? `\n${fresh.label}` : ""}${prepared.hint ? `\n${prepared.hint}` : ""}\n\nClick: use for START · Double-click: start worker here · Right-click: more`}
                      onClick={() => {
                        setZaicodeActiveEngine(active ? null : account.id);
                        playZaicodeSound("engine.select");
                      }}
                      onDoubleClick={() => launch(account)}
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
