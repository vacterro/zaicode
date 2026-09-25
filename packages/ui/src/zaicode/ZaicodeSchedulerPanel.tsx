/* eslint-disable max-lines -- the SCHEDULER page: presets, what fires next and the schedule rows share one store and one clock. */
import { useEffect, useMemo, useState } from "react";
import { CalendarClock, Play, Plus, Trash2 } from "lucide-react";
import {
  ZAICODE_HIT_AND_GO_PROMPT,
  formatZaicodeDuration,
  type ZaicodeAgentDefinition,
  type ZaicodeAutostartJob,
  type ZaicodeAutostartTrigger,
  isZaicodeMetricsOnlyAccount,
} from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { partitionWorkspaceTabsByPurpose } from "@/lib/workspacePurpose.js";
import { projectNameOf, readZaicodeCurrentWorkspace, useZaicodeEngines } from "./zaicodeEngines.js";
import {
  ZAICODE_AUTOSTART_AGENT_PREFIX,
  ZAICODE_AUTOSTART_INAPP_ENGINE,
  addZaicodeAutostartJob,
  decideZaicodeAutostartJob,
  removeZaicodeAutostartJob,
  runZaicodeAutostartNow,
  updateZaicodeAutostartJob,
  useZaicodeAutostartJobs,
} from "./zaicodeAutostart.js";
import { ZAICODE_SCHEDULE_PRESETS, describeZaicodeSchedule, zaicodeUpcomingSchedules } from "./zaicodeScheduler.js";
import { ZAICODE_SLOT_GROUPS } from "./zaicodeSidebarPrefs.js";
import { ZaicodeMomentField, ZaicodeTimeField } from "./ZaicodeTimeFields.js";
import { formatZaicodeClockMinute, parseZaicodeClockText } from "./zaicodeClockText.js";
import { ZaicodeScheduleConditions, ZaicodeSchedulePrompt } from "./ZaicodeScheduleConditions.js";

const TRIGGERS: readonly { value: ZaicodeAutostartTrigger; label: string; title: string }[] = [
  { value: "everyReset", label: "Every reset", title: "After every refill of the watched subscription's window" },
  { value: "reset", label: "Next reset", title: "Once, when the watched window refills" },
  { value: "daily", label: "Daily", title: "Every day at a time" },
  { value: "interval", label: "Every N min", title: "Repeat every N minutes" },
  { value: "at", label: "Once at", title: "One time, at a date and time" },
];

export const ZAICODE_SCHEDULE_STATE_TEXT: Record<string, string> = {
  disabled: "off",
  "waiting-time": "ready",
  "waiting-reset": "ready · waits for reset",
  "waiting-quota": "waits for quota",
  due: "firing",
  missed: "missed",
  done: "done",
  invalid: "check settings",
};

function Segmented<T extends string>({
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
          key={option.value}
          type="button"
          title={option.title}
          className={cn(
            "border px-1.5 py-0.5",
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

function useProjects(): { path: string; name: string }[] {
  const tabs = useTabStore((state) => state.tabs);
  return useMemo(() => {
    const { projectWorkspaceTabs } = partitionWorkspaceTabsByPurpose(tabs.filter(isWorkspaceTab));
    const seen = new Set<string>();
    const projects: { path: string; name: string }[] = [];
    for (const tab of projectWorkspaceTabs) {
      const key = tab.workspacePath.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      projects.push({ path: tab.workspacePath, name: projectNameOf(tab.workspacePath) });
    }
    return projects.sort((left, right) => left.name.localeCompare(right.name));
  }, [tabs]);
}

function useNow(stepMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), stepMs);
    return () => window.clearInterval(timer);
  }, [stepMs]);
  return now;
}

interface RunnerOption {
  id: string;
  label: string;
}

function useRunnerOptions(agents: readonly ZaicodeAgentDefinition[]) {
  const engines = useZaicodeEngines();
  const accounts = engines.accounts.filter((account) => account.status !== "cli-missing" && !isZaicodeMetricsOnlyAccount(account));
  const runners: RunnerOption[] = [
    { id: ZAICODE_AUTOSTART_INAPP_ENGINE, label: "START in ZAICODE (in-app, in each project's MAIN)" },
    ...agents.filter((agent) => agent.enabled).map((agent) => ({ id: `${ZAICODE_AUTOSTART_AGENT_PREFIX}${agent.id}`, label: `Agent: ${agent.name} (queue)` })),
    ...accounts.map((account) => ({ id: account.id, label: `${account.short} ${account.label} (CLI worker)` })),
  ];
  const watch: RunnerOption[] = accounts.map((account) => ({ id: account.id, label: `${account.short} ${account.label}` }));
  return { runners, watch, accounts };
}

/** Countdown text for a schedule's next moment. */
function dueText(dueAt: number | null, now: number): string {
  if (!dueAt) return "";
  return dueAt > now ? `in ${formatZaicodeDuration(dueAt - now)}` : "now";
}

/**
 * SCHEDULER (SRC-038): make subscriptions and agents work by themselves -- no
 * 5-hour window lost. Presets first, then every schedule with its state.
 */
export function ZaicodeSchedulerPanel({ agents }: { agents: readonly ZaicodeAgentDefinition[] }) {
  const jobs = useZaicodeAutostartJobs();
  const projects = useProjects();
  const now = useNow(5000);
  const { runners, watch, accounts } = useRunnerOptions(agents);
  const { settings, update } = useSettings();
  const current = readZaicodeCurrentWorkspace()?.path ?? projects[0]?.path ?? "";
  const firstReady = accounts.find((account) => account.status === "ready")?.id ?? "";
  const upcoming = zaicodeUpcomingSchedules(jobs, (job) => decideZaicodeAutostartJob(job, now)).slice(0, 3);
  const labelOf = (id: string) => runners.find((runner) => runner.id === id)?.label ?? id;

  // A reset preset in one project runs on the subscription itself; in a section it goes through
  // the queue (hit-and-go agent) and watches that subscription's window.
  const addPreset = (preset: (typeof ZAICODE_SCHEDULE_PRESETS)[number]) => {
    const section = preset.patch.targetKind === "section";
    const ownEngine = Boolean(preset.needsEngine && firstReady && !section);
    addZaicodeAutostartJob({
      projectPath: current,
      engineId: ownEngine ? firstReady : ZAICODE_AUTOSTART_INAPP_ENGINE,
      ...(preset.needsEngine && firstReady && section ? { watchEngineId: firstReady } : {}),
      ...preset.patch,
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3 text-ui-xs" data-zaicode-scheduler>
      <section className="flex flex-col gap-2 border border-border bg-card p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-[640px]">
            <h2 className="flex items-center gap-2 text-ui-lg text-foreground">
              <CalendarClock className="size-4" />
              Scheduler
            </h2>
            <p className="mt-1 text-foreground-subtle">
              Prompts that start by themselves: at a time, every day, every N minutes, or the moment a subscription's
              quota refills — in one project or in every project of a sidebar section. Empty prompt ={" "}
              <code>{ZAICODE_HIT_AND_GO_PROMPT}</code>: finish the SAIPEN board. SAIPEN guards the work and calls you when
              it needs you. A limit meter with a prompt waiting for its reset glows.
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!current}
              onClick={() => addZaicodeAutostartJob({ projectPath: current, engineId: ZAICODE_AUTOSTART_INAPP_ENGINE, trigger: "daily" })}
            >
              <Plus className="size-3.5" />
              New schedule
            </Button>
            <label className="flex items-center gap-2 text-foreground-subtle" title="Windows will not sleep while a chat or a scheduled run is working">
              <Switch
                checked={settings?.keepAwakeWhileRunning ?? false}
                onCheckedChange={(value) => void update({ keepAwakeWhileRunning: value })}
              />
              Keep the computer awake while work runs
            </label>
          </div>
        </div>
        <div className="flex flex-col gap-1 border-t border-border pt-2" data-zaicode-scheduler-next>
          <span className="text-foreground-subtlest">NEXT UP</span>
          {upcoming.length === 0 ? (
            <span className="text-foreground-subtle">Nothing armed. Pick a preset below — one click, then adjust.</span>
          ) : (
            upcoming.map(({ job, decision }) => (
              <span key={job.id} className="flex min-w-0 items-center gap-2">
                <span className="shrink-0 border border-[var(--zaicode-highlight,var(--color-border-hover))] px-1 tabular-nums text-foreground">
                  {dueText(decision.dueAt, now) || ZAICODE_SCHEDULE_STATE_TEXT[decision.state]}
                </span>
                <span className="min-w-0 truncate text-foreground">{job.name || "Schedule"}</span>
                <span className="min-w-0 truncate text-foreground-subtlest">{describeZaicodeSchedule(job, labelOf(job.engineId))}</span>
              </span>
            ))
          )}
        </div>
        <div className="flex flex-col gap-1 border-t border-border pt-2">
          <span className="text-foreground-subtlest">PRESETS</span>
          <div className="flex flex-wrap gap-1">
            {ZAICODE_SCHEDULE_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                disabled={!current}
                title={`${preset.hint}${preset.needsEngine && !firstReady ? "\nNo signed-in subscription yet: it will wait for one." : ""}`}
                className="border border-border px-1.5 py-0.5 text-foreground-subtle hover:bg-hover hover:text-foreground disabled:opacity-40"
                onClick={() => addPreset(preset)}
              >
                + {preset.label}
              </button>
            ))}
          </div>
        </div>
      </section>
      <div className="mt-3 flex flex-col gap-2">
        {jobs.length === 0 ? <p className="text-foreground-subtlest">No schedules yet.</p> : null}
        {jobs.map((job) => (
          <ZaicodeScheduleRow key={job.id} job={job} now={now} projects={projects} runners={runners} watch={watch} />
        ))}
      </div>
    </div>
  );
}

export function ZaicodeScheduleRow({
  job,
  now,
  projects,
  runners,
  watch,
}: {
  job: ZaicodeAutostartJob;
  now: number;
  projects: { path: string; name: string }[];
  runners: RunnerOption[];
  watch: RunnerOption[];
}) {
  const decision = decideZaicodeAutostartJob(job, now);
  const update = (patch: Partial<ZaicodeAutostartJob>) => updateZaicodeAutostartJob(job.id, patch);
  const projectKnown = projects.some((project) => project.path === job.projectPath);
  const watchesOwnEngine = !job.engineId.startsWith("pool:") && !job.engineId.startsWith(ZAICODE_AUTOSTART_AGENT_PREFIX);
  const resetTrigger = job.trigger === "reset" || job.trigger === "everyReset";
  const select = "max-w-[240px] border border-border bg-background px-1 py-0.5 text-foreground";
  return (
    <div
      className={cn("flex flex-col gap-1.5 border border-border p-2", !job.enabled && "opacity-70")}
      data-zaicode-schedule={job.id}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Switch checked={job.enabled} onCheckedChange={(enabled) => update({ enabled })} />
        <input
          className="w-44 border border-border bg-background px-1 py-0.5 text-foreground"
          placeholder="Name"
          defaultValue={job.name}
          onBlur={(event) => update({ name: event.target.value })}
        />
        <span
          className={cn(
            "border px-1",
            decision.state === "due"
              ? "border-[#4f9a2f] text-[#7fc35a]"
              : decision.state === "missed" || decision.state === "invalid"
                ? "border-[#c8502a] text-[#e07a55]"
                : job.enabled
                  ? "border-[var(--zaicode-highlight,var(--color-border-hover))] text-foreground"
                  : "border-border text-foreground-subtle",
          )}
          title={decision.reason}
        >
          {ZAICODE_SCHEDULE_STATE_TEXT[decision.state] ?? decision.state}
          {decision.dueAt && decision.dueAt > now ? ` · in ${formatZaicodeDuration(decision.dueAt - now)}` : ""}
        </span>
        <span className="flex-1" />
        <Button size="sm" variant="outline" title="Run now (test it; does not use up the scheduled moment)" onClick={() => runZaicodeAutostartNow(job.id)}>
          <Play className="size-3.5" />
        </Button>
        <Button size="sm" variant="outline" title="Delete" onClick={() => removeZaicodeAutostartJob(job.id)}>
          <Trash2 className="size-3.5" />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-foreground-subtle">
        <span>Where</span>
        <Segmented
          value={job.targetKind}
          options={[
            { value: "project", label: "Project" },
            { value: "section", label: "Section", title: "Every project in a sidebar section" },
          ]}
          onChange={(targetKind) => update({ targetKind })}
        />
        {job.targetKind === "section" ? (
          <select className={select} value={job.section} onChange={(event) => update({ section: event.target.value })}>
            {ZAICODE_SLOT_GROUPS.map((group) => (
              <option key={group} value={group}>
                {group}
              </option>
            ))}
          </select>
        ) : (
          <select className={select} value={job.projectPath} onChange={(event) => update({ projectPath: event.target.value })}>
            {!projectKnown ? <option value={job.projectPath}>{projectNameOf(job.projectPath)}</option> : null}
            {projects.map((project) => (
              <option key={project.path} value={project.path}>
                {project.name}
              </option>
            ))}
          </select>
        )}
        <span>Who</span>
        <select className={select} value={job.engineId} onChange={(event) => update({ engineId: event.target.value })}>
          {!runners.some((runner) => runner.id === job.engineId) ? <option value={job.engineId}>{job.engineId}</option> : null}
          {runners.map((runner) => (
            <option key={runner.id} value={runner.id}>
              {runner.label}
            </option>
          ))}
        </select>
        {!watchesOwnEngine ? (
          <>
            <span title="The subscription whose quota the reset triggers watch (and that must have quota to start)">Watch</span>
            <select className={select} value={job.watchEngineId} onChange={(event) => update({ watchEngineId: event.target.value, firedEvents: [] })}>
              <option value="">— no subscription —</option>
              {watch.map((engine) => (
                <option key={engine.id} value={engine.id}>
                  {engine.label}
                </option>
              ))}
            </select>
          </>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-foreground-subtle">
        <span>When</span>
        <Segmented value={job.trigger} options={TRIGGERS} onChange={(trigger) => update({ trigger, firedEvents: [] })} />
        {job.trigger === "at" ? (
          <ZaicodeMomentField value={job.at} onChange={(at) => update({ at, enabled: true })} />
        ) : null}
        {job.trigger === "daily" ? (
          <ZaicodeTimeField
            minute={parseZaicodeClockText(job.dailyTime) ?? 9 * 60}
            ariaLabel="Every day at"
            onChange={(minute) => update({ dailyTime: formatZaicodeClockMinute(minute) })}
          />
        ) : null}
        {job.trigger === "interval" ? (
          <label className="flex items-center gap-1">
            every
            <input
              type="number"
              min={5}
              step={5}
              className="w-16 border border-border bg-background px-1 py-0.5 text-foreground"
              value={job.intervalMinutes}
              onChange={(event) => update({ intervalMinutes: Number(event.target.value) })}
            />
            min
          </label>
        ) : null}
        {resetTrigger ? (
          <Segmented
            value={job.window}
            options={[
              { value: "five_hour", label: "5h window" },
              { value: "weekly", label: "weekly" },
              { value: "monthly", label: "monthly" },
            ]}
            onChange={(window) => update({ window, firedEvents: [] })}
          />
        ) : null}
        {resetTrigger && !watchesOwnEngine && !job.watchEngineId ? (
          <span className="text-[#e07a55]">pick the subscription to watch</span>
        ) : null}
        <label className="flex items-center gap-1" title="Runs this schedule started through the queue are stopped at this time (START and CLI workers finish on their own)">
          stop at
          <ZaicodeTimeField
            minute={job.stopAt ? parseZaicodeClockText(job.stopAt) : null}
            ariaLabel="Stop runs at"
            onChange={(minute) => update({ stopAt: formatZaicodeClockMinute(minute) })}
            onClear={() => update({ stopAt: "" })}
          />
          {job.stopAt ? (
            <button type="button" className="px-1 hover:text-foreground" title="No stop time: run until done" onClick={() => update({ stopAt: "" })}>
              ×
            </button>
          ) : null}
        </label>
      </div>
      <ZaicodeSchedulePrompt value={job.prompt} onChange={(prompt) => update({ prompt })} />
      <ZaicodeScheduleConditions job={job} inApp={!watchesOwnEngine} onChange={update} />
      <div className="flex flex-wrap items-center gap-2 text-foreground-subtle">
        <label className="flex items-center gap-1" title="Wait after a refill before starting (the vendor's clock is not ours)">
          delay
          <input
            type="number"
            min={0}
            max={3600}
            className="w-14 border border-border bg-background px-1 py-0.5 text-foreground"
            value={job.safetyDelaySeconds}
            onChange={(event) => update({ safetyDelaySeconds: Number(event.target.value) })}
          />
          s
        </label>
        <label className="flex items-center gap-1" title="A moment older than this is missed, never launched late">
          catch-up
          <input
            type="number"
            min={1}
            max={1440}
            className="w-14 border border-border bg-background px-1 py-0.5 text-foreground"
            value={Math.round(job.catchUpSeconds / 60)}
            onChange={(event) => update({ catchUpSeconds: Number(event.target.value) * 60 })}
          />
          min
        </label>
        <label className="flex items-center gap-1" title="Wait while the watched subscription has no quota">
          <Switch checked={job.requireQuota} onCheckedChange={(requireQuota) => update({ requireQuota })} />
          wait for quota
        </label>
      </div>
      <div className="text-foreground-subtlest">
        {describeZaicodeSchedule(job, runners.find((runner) => runner.id === job.engineId)?.label ?? job.engineId)}
        {job.lastResult ? ` · last: ${job.lastResult}` : ""}
      </div>
    </div>
  );
}
