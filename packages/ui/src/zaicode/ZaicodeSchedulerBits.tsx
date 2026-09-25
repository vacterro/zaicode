import { useEffect, useState } from "react";
import { CalendarClock } from "lucide-react";
import { ZAICODE_HIT_AND_GO_PROMPT, formatZaicodeDuration } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  ZAICODE_AUTOSTART_AGENT_PREFIX,
  addZaicodeAutostartJob,
  decideZaicodeAutostartJob,
  useZaicodeAutostartJobs,
} from "./zaicodeAutostart.js";
import { readZaicodeCurrentWorkspace } from "./zaicodeEngines.js";
import {
  describeZaicodeSchedule,
  useZaicodeWorkspaceTab,
  zaicodePreparedEngines,
  zaicodeUpcomingSchedules,
  type ZaicodeScheduleNext,
} from "./zaicodeScheduler.js";
import { useZaicodeLights, zaicodeHighlightAttrs, type ZaicodeLightAttrs } from "./zaicodeHighlights.js";
import { openZaicodeWorkspaceView } from "./zaicodeActions.js";

/**
 * The SCHEDULER's small faces (SRC-038): the sidebar line and the "prompt
 * ready" glow on limit meters. Its readiness on the home surface is SAIHOME's
 * Scheduler module (T-56, zaicode/home/).
 */

function useSlowClock(stepMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), stepMs);
    return () => window.clearInterval(timer);
  }, [stepMs]);
  return now;
}

function useUpcoming(stepMs: number): { now: number; upcoming: ZaicodeScheduleNext[] } {
  const jobs = useZaicodeAutostartJobs();
  const now = useSlowClock(stepMs);
  return { now, upcoming: zaicodeUpcomingSchedules(jobs, (job) => decideZaicodeAutostartJob(job, now)) };
}

function nextText(next: ZaicodeScheduleNext | undefined, now: number): string {
  if (!next) return "";
  const dueAt = next.decision.dueAt;
  if (next.decision.state === "waiting-reset" && !dueAt) return "at reset";
  return dueAt ? (dueAt > now ? formatZaicodeDuration(dueAt - now) : "now") : "";
}

/** Opens the ZAICODE workspace on its Scheduler page. */
export function openZaicodeScheduler(openZaicode?: () => void): void {
  useZaicodeWorkspaceTab.getState().setTab("scheduler");
  if (openZaicode) openZaicode();
  else openZaicodeWorkspaceView();
}

/** Sidebar menu line: SCHEDULER, how many schedules are armed and when the next one fires. */
export function ZaicodeSchedulerNavButton({ className, onOpenZaicode }: { className: string; onOpenZaicode?: () => void }) {
  const { now, upcoming } = useUpcoming(30_000);
  const next = upcoming[0];
  return (
    <Button
      variant="ghost"
      size="lg"
      data-icon="inline-start"
      className={className}
      title={
        next
          ? `${upcoming.length} armed · next: ${next.job.name || "schedule"} ${nextText(next, now)}\n${next.job.prompt || ZAICODE_HIT_AND_GO_PROMPT}`
          : "SCHEDULER — prompts that start by themselves (times, intervals, quota resets). Nothing armed yet."
      }
      onClick={() => openZaicodeScheduler(onOpenZaicode)}
      data-zaicode-scheduler-nav
    >
      <CalendarClock className="size-4" />
      <span className="min-w-0 flex-1 truncate text-left">SCHEDULER</span>
      {next ? (
        <span className="ml-auto shrink-0 border border-[var(--zaicode-highlight,var(--color-border-hover))] px-1 text-ui-xs font-normal tabular-nums text-foreground">
          {upcoming.length} · {nextText(next, now)}
        </span>
      ) : (
        <span className="ml-auto shrink-0 text-ui-xs font-normal text-foreground-subtlest">off</span>
      )}
    </Button>
  );
}

export interface ZaicodePreparedMeter {
  lights: ZaicodeLightAttrs | null;
  hint: string | null;
}

/**
 * The "prompt ready" highlight of limit meters: lit while a schedule waits
 * for that engine's reset. Returns a lookup (usable inside a list) giving the
 * attributes to spread and a tooltip line per engine id.
 */
export function useZaicodePreparedMeters(): (engineId: string) => ZaicodePreparedMeter {
  const jobs = useZaicodeAutostartJobs();
  const now = useSlowClock(30_000);
  const rule = useZaicodeLights((state) => state.highlights.meterPrepared);
  const prepared = zaicodePreparedEngines(jobs, (job) => decideZaicodeAutostartJob(job, now));
  return (engineId) => {
    const waiting = prepared.get(engineId) ?? [];
    if (waiting.length === 0) return { lights: null, hint: null };
    return {
      lights: zaicodeHighlightAttrs("meterPrepared", rule),
      hint: `Prompt ready after the reset: ${waiting
        .map(({ job }) => `${job.name || "schedule"} (${job.prompt || ZAICODE_HIT_AND_GO_PROMPT})`)
        .join(", ")}`,
    };
  };
}

/**
 * An agent's own beat (SRC-038: "each agent keeps its part -- which project,
 * when to start, why, when to stop"): its schedules and one click to add one.
 */
export function ZaicodeAgentSchedules({ agentId, agentName }: { agentId: string; agentName: string }) {
  const jobs = useZaicodeAutostartJobs();
  const runner = `${ZAICODE_AUTOSTART_AGENT_PREFIX}${agentId}`;
  const own = jobs.filter((job) => job.engineId === runner);
  return (
    <div className="flex flex-col gap-1" data-zaicode-agent-schedules>
      <span className="text-ui-xs text-foreground-subtle">Schedules</span>
      {own.length === 0 ? (
        <span className="text-ui-xs text-foreground-subtlest">None: this agent works only when you queue a task.</span>
      ) : (
        own.map((job) => (
          <span key={job.id} className={cn("text-ui-xs", job.enabled ? "text-foreground" : "text-foreground-subtlest")}>
            {job.enabled ? "● " : "○ "}
            {describeZaicodeSchedule(job, agentName)}
          </span>
        ))
      )}
      <Button
        size="sm"
        variant="outline"
        className="self-start"
        title="Give this agent its own beat: which project or section, when, and when to stop"
        onClick={() => {
          addZaicodeAutostartJob({
            name: agentName,
            projectPath: readZaicodeCurrentWorkspace()?.path ?? "",
            engineId: runner,
            trigger: "daily",
          });
          openZaicodeScheduler();
        }}
      >
        <CalendarClock className="size-3" />
        Schedule this agent…
      </Button>
    </div>
  );
}
