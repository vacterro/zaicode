/* eslint-disable max-lines -- ZAICODE engines settings page keeps accounts, sweep options and autostart jobs together over one config write path. */
import { useEffect, useState } from "react";
import { CalendarClock, ExternalLink, Eye, EyeOff, Play, RefreshCw, UserPlus, Wrench } from "lucide-react";
import {
  isZaicodeMetricsOnlyAccount,
  ZAICODE_ENGINE_INTERVAL_CHOICES,
  formatZaicodeDuration,
  type ZaicodeEngineAccount,
} from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import {
  getZaicodeEnginesBridge,
  isZaicodeEnginesAvailable,
  projectNameOf,
  psQuote,
  readZaicodeCurrentWorkspace,
  readZaicodeEngine,
  refreshZaicodeEngineLimits,
  setZaicodeActiveEngine,
  updateZaicodeEnginesConfig,
  useZaicodeActiveEngine,
  useZaicodeEngines,
} from "@/zaicode/zaicodeEngines.js";
import { launchZaicodeWorker, runZaicodeFixCommand } from "@/zaicode/zaicodeWorkers.js";
import { ZaicodeAccountLimits, useZaicodeClock, zaicodeVendorColor } from "@/zaicode/ZaicodeLimitViews.js";
import { ZaicodeMeterSettingsPanel } from "@/zaicode/ZaicodeMeterSettings.js";
import { useZaicodeAutostartJobs } from "@/zaicode/zaicodeAutostart.js";
import { openZaicodeScheduler } from "@/zaicode/ZaicodeSchedulerBits.js";
import { playZaicodeSound } from "@/zaicode/zaicodeSoundBus.js";

const STATUS_TEXT: Record<ZaicodeEngineAccount["status"], string> = {
  ready: "Ready",
  "login-required": "Sign in",
  "cli-missing": "CLI missing",
  "no-plan": "No plan",
};

function Segmented<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly { value: T; label: string; title?: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-px">
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          title={option.title}
          className={cn(
            "border px-2 py-0.5 text-ui-xs",
            option.value === value
              ? "border-[var(--zaicode-highlight,var(--color-border-hover))] bg-selected text-foreground"
              : "border-border text-foreground-subtle hover:bg-hover hover:text-foreground",
          )}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function fixCwd(account: ZaicodeEngineAccount): string {
  return readZaicodeCurrentWorkspace()?.path ?? account.home ?? "C:\\";
}

export function ZaicodeEnginesSettings() {
  const engines = useZaicodeEngines();
  const activeEngine = useZaicodeActiveEngine();
  const now = useZaicodeClock(15_000);
  const [startWithWindows, setStartWithWindows] = useState<boolean | null>(null);
  const [confirmFixes, setConfirmFixes] = useState(false);

  useEffect(() => {
    void getZaicodeEnginesBridge()
      ?.getZaicodeStartWithWindows?.()
      .then((result) => setStartWithWindows(result.enabled))
      .catch(() => setStartWithWindows(null));
  }, []);

  if (!isZaicodeEnginesAvailable()) {
    return <p className="text-ui-base text-foreground-subtle">Engines need the ZAICODE desktop app.</p>;
  }

  const broken = engines.accounts.filter((account) => account.status !== "ready" && account.fixCommand);
  const hidden = new Set(engines.config.hiddenAccounts);

  const addAccount = async (vendor: "claude" | "codex") => {
    const bridge = getZaicodeEnginesBridge();
    const result = await bridge?.prepareZaicodeEngineAccountHome?.(vendor);
    if (!result?.ok) {
      toast(result?.message ?? "Could not prepare an account folder.");
      return;
    }
    const template = engines.accounts.find((account) => account.vendor === vendor && account.cli);
    const cli = template?.cli ?? vendor;
    const command =
      vendor === "claude"
        ? `$env:CLAUDE_CONFIG_DIR = ${psQuote(result.home)}; & ${psQuote(cli)} auth login`
        : `$env:CODEX_HOME = ${psQuote(result.home)}; Remove-Item Env:OPENAI_API_KEY -ErrorAction SilentlyContinue; codex login`;
    runZaicodeFixCommand({ title: `Add ${vendor} account`, command, cwd: result.home });
    toast(`${result.message}. The new account appears after sign-in (Read all now).`);
  };

  return (
    <div className="flex flex-col gap-4" data-zaicode-engines-settings>
      <section className="border border-border bg-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-ui-lg text-foreground">Engines & limits</h2>
            <p className="mt-1 max-w-[560px] text-ui-xs text-foreground-subtle">
              Every subscription you already signed in to — Claude Code, Codex, Antigravity, ZCode — is found
              automatically and becomes a worker engine next to the in-app model pools. Quota is read with each
              vendor&apos;s own read-only call (it never spends quota) and shown on the sidebar tiles and the title
              bar meter. Pick an engine on the sidebar; START and autostart use it.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={engines.sweeping}
              onClick={() =>
                void refreshZaicodeEngineLimits().then(() => {
                  playZaicodeSound("limits.refresh");
                  toast("Quota read for every engine.");
                })
              }
            >
              <RefreshCw className={cn("size-3.5", engines.sweeping && "animate-spin")} />
              {engines.sweeping ? "Reading…" : "Read all now"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={broken.length === 0}
              title={broken.length === 0 ? "Everything that can be connected is connected." : undefined}
              onClick={() => setConfirmFixes((value) => !value)}
            >
              <Wrench className="size-3.5" />
              Connect everything{broken.length ? ` (${broken.length})` : ""}
            </Button>
          </div>
        </div>

        {confirmFixes && broken.length > 0 ? (
          <div className="mt-3 border border-[var(--zaicode-highlight,var(--color-border-hover))] p-2 text-ui-xs">
            <p className="text-foreground">
              These exact commands run in WORKERS tabs, one per engine. Sign-in opens the vendor&apos;s own browser
              page; nothing runs without this click.
            </p>
            <ul className="mt-1.5 flex flex-col gap-1">
              {broken.map((account) => (
                <li key={account.id} className="flex flex-col">
                  <span className="text-foreground-subtle">
                    {account.short} {account.label}: {account.statusDetail}
                  </span>
                  <code className="break-all bg-black/30 px-1 text-foreground">{account.fixCommand}</code>
                </li>
              ))}
            </ul>
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                onClick={() => {
                  for (const account of broken) {
                    runZaicodeFixCommand({
                      title: `Fix ${account.label}`,
                      command: account.fixCommand!,
                      cwd: fixCwd(account),
                      accountId: account.id,
                    });
                  }
                  setConfirmFixes(false);
                }}
              >
                Run {broken.length} fix{broken.length === 1 ? "" : "es"}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setConfirmFixes(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}

        <div className="mt-3 grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-ui-xs">
          <span className="text-foreground-subtle">Read quota every</span>
          <Segmented
            value={engines.config.intervalMinutes}
            options={ZAICODE_ENGINE_INTERVAL_CHOICES.map((minutes) => ({
              value: minutes,
              label: minutes === 0 ? "manual" : `${minutes}m`,
            }))}
            onChange={(intervalMinutes) => void updateZaicodeEnginesConfig({ intervalMinutes })}
          />
          <span className="text-foreground-subtle">Status</span>
          <span className="text-foreground-subtlest">
            {engines.lastSweepAt ? `last read ${formatZaicodeDuration(now - engines.lastSweepAt)} ago` : "not read yet"}
            {engines.nextSweepAt ? ` · next in ${formatZaicodeDuration(engines.nextSweepAt - now)}` : ""}
          </span>
        </div>
      </section>

      <section className="border border-border bg-card p-4" data-zaicode-meter-section>
        <h2 className="text-ui-lg text-foreground">Limit meters</h2>
        <p className="mb-2 mt-1 max-w-[560px] text-ui-xs text-foreground-subtle">
          What the title bar meter and the sidebar tiles show. The same panel opens on a right-click of the meter.
        </p>
        <ZaicodeMeterSettingsPanel />
      </section>

      <section className="border border-border bg-card p-4" data-zaicode-engine-accounts>
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-ui-lg text-foreground">Subscriptions</h2>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => void addAccount("claude")}>
              <UserPlus className="size-3.5" />
              Add Claude account
            </Button>
            <Button size="sm" variant="outline" onClick={() => void addAccount("codex")}>
              <UserPlus className="size-3.5" />
              Add Codex account
            </Button>
          </div>
        </div>
        <div className="mt-3 flex flex-col gap-2">
          {engines.accounts.map((account) => {
            const snapshot = engines.limits[account.id];
            const reading = readZaicodeEngine(account, snapshot, now);
            const isHidden = hidden.has(account.id);
            const project = readZaicodeCurrentWorkspace()?.path;
            // Freebuff (SRC-043) is measured only: no START pick, no worker buttons.
            const metricsOnly = isZaicodeMetricsOnlyAccount(account);
            return (
              <div
                key={account.id}
                className={cn("flex flex-col gap-1.5 border border-border p-2", isHidden && "opacity-60")}
                data-zaicode-engine-row={account.short}
              >
                <div className="flex flex-wrap items-center gap-2 text-ui-xs">
                  <button
                    type="button"
                    disabled={metricsOnly}
                    className={cn(
                      "min-w-[34px] border px-1.5 py-0.5 font-semibold",
                      activeEngine === account.id
                        ? "border-[var(--zaicode-highlight,var(--color-border-hover))] bg-selected"
                        : "border-border",
                    )}
                    style={{ color: zaicodeVendorColor(account.vendor) }}
                    title={activeEngine === account.id ? "START uses this engine. Click to go back to the in-app pool." : "Use for START"}
                    onClick={() => setZaicodeActiveEngine(activeEngine === account.id ? null : account.id)}
                  >
                    {account.short}
                  </button>
                  <span className="text-foreground">{account.label}</span>
                  <span className="truncate text-foreground-subtlest">{account.source}</span>
                  <span
                    className={cn(
                      "border px-1",
                      account.status === "ready" ? "border-[#4f9a2f] text-[#7fc35a]" : "border-[#c9a227] text-[#e0c060]",
                    )}
                  >
                    {STATUS_TEXT[account.status]}
                  </span>
                  {reading.availability === "blocked" ? <span className="text-[#c8502a]">blocked</span> : null}
                  {metricsOnly ? (
                    <span className="border border-border px-1 text-foreground-subtle" title="Its quota shows in the meters, the clock and SAIHOME; it never runs a worker.">
                      metrics only
                    </span>
                  ) : null}
                  <span className="flex-1" />
                  {metricsOnly ? null : (
                  <>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={account.status === "cli-missing" || !project}
                    title={project ? `Start ${account.short} in ${projectNameOf(project)}` : "Open a project first"}
                    onClick={() =>
                      project &&
                      void launchZaicodeWorker({ account, projectPath: project }).then((result) => toast(result.message))
                    }
                  >
                    <Play className="size-3.5" />
                    Start here
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={account.status === "cli-missing" || !project}
                    title="Start in its own PowerShell window (survives a ZAICODE restart)"
                    onClick={() =>
                      project &&
                      void launchZaicodeWorker({ account, projectPath: project, where: "external" }).then((result) =>
                        toast(result.message),
                      )
                    }
                  >
                    <ExternalLink className="size-3.5" />
                  </Button>
                  </>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    title="Read this quota now"
                    disabled={engines.probing.includes(account.id)}
                    onClick={() => void refreshZaicodeEngineLimits(account.id)}
                  >
                    <RefreshCw className={cn("size-3.5", engines.probing.includes(account.id) && "animate-spin")} />
                  </Button>
                  {account.fixCommand ? (
                    <Button
                      size="sm"
                      variant="outline"
                      title={`Runs: ${account.fixCommand}`}
                      onClick={() =>
                        runZaicodeFixCommand({
                          title: `Fix ${account.label}`,
                          command: account.fixCommand!,
                          cwd: fixCwd(account),
                          accountId: account.id,
                        })
                      }
                    >
                      <Wrench className="size-3.5" />
                      Fix
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    title={isHidden ? "Show on the sidebar and the meter" : "Hide from the sidebar and the meter"}
                    onClick={() =>
                      void updateZaicodeEnginesConfig({
                        hiddenAccounts: isHidden
                          ? engines.config.hiddenAccounts.filter((id) => id !== account.id)
                          : [...engines.config.hiddenAccounts, account.id],
                      })
                    }
                  >
                    {isHidden ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
                  </Button>
                </div>
                <div className="text-ui-xs">
                  <ZaicodeAccountLimits
                    account={account}
                    snapshot={snapshot}
                    now={now}
                    probing={engines.probing.includes(account.id)}
                    compact
                  />
                </div>
              </div>
            );
          })}
          {engines.accounts.length === 0 ? (
            <p className="text-ui-xs text-foreground-subtle">Looking for accounts…</p>
          ) : null}
        </div>
      </section>

      <section className="border border-border bg-card p-4">
        <h2 className="text-ui-lg text-foreground">Workers</h2>
        <div className="mt-2 flex flex-col gap-2 text-ui-xs">
          <label className="flex flex-col gap-1">
            <span className="text-foreground-subtle">First prompt a new worker gets (START with a subscription)</span>
            <input
              className="border border-border bg-background px-2 py-1 text-foreground"
              defaultValue={engines.config.workerPrompt}
              onBlur={(event) => void updateZaicodeEnginesConfig({ workerPrompt: event.target.value })}
            />
          </label>
          <label className="flex items-center justify-between gap-3" data-zaicode-subscription-prompts>
            <span className="text-foreground-subtle">
              Prompts for a picked subscription open a SUBCHAT: an in-app chat, the CLI runs in the background with no
              terminal (Claude Code, Codex). Off = a worker terminal. Antigravity and ZCode always start a worker.
            </span>
            <Switch
              checked={engines.config.subscriptionPrompts === "chat"}
              onCheckedChange={(chat) => void updateZaicodeEnginesConfig({ subscriptionPrompts: chat ? "chat" : "worker" })}
            />
          </label>
          <label className="flex items-center justify-between gap-3">
            <span className="text-foreground-subtle">
              YOLO mode (skip per-tool permission prompts: --dangerously-skip-permissions / bypass sandbox)
            </span>
            <Switch
              checked={engines.config.workerYolo}
              onCheckedChange={(workerYolo) => void updateZaicodeEnginesConfig({ workerYolo })}
            />
          </label>
          <label className="flex items-center justify-between gap-3">
            <span className="text-foreground-subtle">
              Read ZCode&apos;s Coding Plan key (only that entry, only sent to api.z.ai / bigmodel.cn)
            </span>
            <Switch
              checked={engines.config.readZcodeConfig}
              onCheckedChange={(readZcodeConfig) => void updateZaicodeEnginesConfig({ readZcodeConfig })}
            />
          </label>
          <label className="flex items-center justify-between gap-3">
            <span className="text-foreground-subtle">
              Read Freebuff limits (Freebuff Desktop&apos;s own sign-in, one read-only request to codebuff.com; shown as a
              meter, never used to run work)
            </span>
            <Switch
              checked={engines.config.readFreebuff}
              onCheckedChange={(readFreebuff) => void updateZaicodeEnginesConfig({ readFreebuff })}
            />
          </label>
          <label className="flex items-center justify-between gap-3">
            <span className="text-foreground-subtle">Start ZAICODE with Windows (through the root launcher)</span>
            <Switch
              checked={Boolean(startWithWindows)}
              disabled={startWithWindows === null}
              onCheckedChange={(enabled) =>
                void getZaicodeEnginesBridge()
                  ?.setZaicodeStartWithWindows?.(enabled)
                  .then((result) => setStartWithWindows(result.enabled))
              }
            />
          </label>
        </div>
      </section>

      <ZaicodeSchedulerPointer />
    </div>
  );
}

/** Scheduled starts moved to the SCHEDULER (SRC-038); this page only points there. */
function ZaicodeSchedulerPointer() {
  const jobs = useZaicodeAutostartJobs();
  const armed = jobs.filter((job) => job.enabled).length;
  return (
    <section className="flex items-center justify-between gap-3 border border-border bg-card p-4" data-zaicode-autostart>
      <div>
        <h2 className="text-ui-lg text-foreground">Scheduled starts</h2>
        <p className="mt-1 max-w-[560px] text-ui-xs text-foreground-subtle">
          Starting engines on a timer or the moment a quota refills lives in the SCHEDULER (sidebar), with presets,
          sidebar sections, agents and a stop time. {armed > 0 ? `${armed} armed now.` : "Nothing armed yet."}
        </p>
      </div>
      <Button size="sm" variant="outline" onClick={() => openZaicodeScheduler()}>
        <CalendarClock className="size-3.5" />
        Open SCHEDULER
      </Button>
    </section>
  );
}
