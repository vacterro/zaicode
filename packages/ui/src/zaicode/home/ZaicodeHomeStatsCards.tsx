import { useState, type KeyboardEvent } from "react";
import {
  ZAICODE_STREAK_MEASURES,
  formatZaicodeCompactCount,
  formatZaicodeDuration,
  zaicodeIntensity,
  zaicodeStreakValue,
  type ZaicodeHomeStats,
  type ZaicodeStatsActivity,
  type ZaicodeStatsDay,
  type ZaicodeStatsTotals,
  type ZaicodeStreakMeasure,
} from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { openZaicodeWorkspaceView } from "../zaicodeActions.js";
import { projectNameOf } from "../zaicodeEngines.js";
import { ZaicodeHomeCard, ZaicodeTruthValue } from "./ZaicodeHomeCards.js";
import { formatZaicodePercent, formatZaicodeRatio, formatZaicodeRuntime, type ZaicodeHomeTruth } from "./zaicodeHomeModel.js";
import { useZaicodeHomePrefs } from "./zaicodeHomePrefs.js";
import type { ZaicodeHomeJournalEvent } from "./zaicodeHomeJournal.js";

/**
 * SAIHOME statistics cards (T-56): token totals, the activity grid, the
 * derived numbers and the recent timeline. Every number here comes from the
 * local statistics service; its provenance is on the tooltip, and a
 * denominator of zero reads "not enough data", never 0 %.
 */

const MEASURE_LABEL: Record<ZaicodeStreakMeasure, string> = {
  activity: "Activity",
  tokens: "Tokens",
  tasks: "Tasks done",
  runs: "Runs",
  runtime: "Runtime",
};

function statsTruth(stats: ZaicodeHomeStats | null, error: string | null): ZaicodeHomeTruth {
  if (!stats) return "unavailable";
  if (error) return "stale";
  const agent = stats.sources.find((source) => source.source === "agent-db");
  return agent?.state === "fresh" ? "authoritative" : agent?.state === "stale" ? "stale" : "stale";
}

function exact(value: number): string {
  return value.toLocaleString("en-GB");
}

function TokenTile({ label, totals, truth }: { label: string; totals: ZaicodeStatsTotals; truth: ZaicodeHomeTruth }) {
  return (
    <div
      className="flex min-w-[92px] flex-1 flex-col border border-border/70 bg-background px-1.5 py-1"
      title={`${label}: ${exact(totals.tokens)} tokens (in ${exact(totals.input)} · out ${exact(totals.output)} · cache read ${exact(totals.cacheRead)} · cache write ${exact(totals.cacheWrite)})\n${exact(totals.requests)} model requests · ${exact(totals.turns)} turns · ${totals.jobsDone} queue runs done`}
    >
      <span className="text-[10px] tracking-wide text-foreground-subtlest">{label.toUpperCase()}</span>
      <ZaicodeTruthValue truth={truth} className="text-ui-base text-foreground">
        {formatZaicodeCompactCount(totals.tokens)}
      </ZaicodeTruthValue>
      <span className="truncate text-[10px] text-foreground-subtlest">
        {formatZaicodeCompactCount(totals.requests)} req · {totals.jobsDone} done
      </span>
    </div>
  );
}

const RIBBON_PERIODS = [
  ["today", "Today"],
  ["yesterday", "Yday"],
  ["week", "Week"],
  ["month", "Month"],
  ["all", "All"],
] as const;

/**
 * T-52 (SRC-038): token totals in the SAIHOME title row, top left, whatever
 * preset is on. Same numbers and truth marks as the Tokens & work card.
 */
export function ZaicodeHomeTokenRibbon({ stats, error }: { stats: ZaicodeHomeStats | null; error: string | null }) {
  if (!stats) return null;
  const truth = statsTruth(stats, error);
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 tabular-nums" data-zaicode-token-ribbon aria-label="Tokens">
      {RIBBON_PERIODS.map(([key, label]) => {
        const totals = stats.periods[key];
        return (
          <span key={key} className="flex items-baseline gap-1" title={`${label}: ${exact(totals.tokens)} tokens · ${exact(totals.requests)} model requests`}>
            <span className="text-[10px] tracking-wide text-foreground-subtlest">{label.toUpperCase()}</span>
            <ZaicodeTruthValue truth={truth} className="text-foreground">
              {formatZaicodeCompactCount(totals.tokens)}
            </ZaicodeTruthValue>
          </span>
        );
      })}
    </span>
  );
}

export function ZaicodeHomeStats({ stats, error }: { stats: ZaicodeHomeStats | null; error: string | null }) {
  const range = useZaicodeHomePrefs((state) => state.statsRange);
  const update = useZaicodeHomePrefs((state) => state.update);
  const truth = statsTruth(stats, error);
  if (!stats) {
    return (
      <ZaicodeHomeCard title="Tokens & work" widget="stats">
        <span className="text-foreground-subtle">{error ? `Statistics unavailable: ${error}` : "Reading local statistics…"}</span>
      </ZaicodeHomeCard>
    );
  }
  if (stats.eventCount === 0) {
    return (
      <ZaicodeHomeCard title="Tokens & work" widget="stats">
        <span className="text-foreground-subtle">Statistics start locally with your first run.</span>
      </ZaicodeHomeCard>
    );
  }
  const period = range === "today" ? stats.periods.today : range === "week" ? stats.periods.week : range === "month" ? stats.periods.month : stats.periods.all;
  const coverage = stats.coverage.share;
  return (
    <ZaicodeHomeCard
      title="Tokens & work"
      widget="stats"
      right={coverage !== null && coverage < 0.995 ? `${formatZaicodePercent(coverage)} measured` : "measured"}
    >
      <div className="flex flex-wrap gap-1">
        <TokenTile label="Today" totals={stats.periods.today} truth={truth} />
        <TokenTile label="Yesterday" totals={stats.periods.yesterday} truth={truth} />
        <TokenTile label="Week" totals={stats.periods.week} truth={truth} />
        <TokenTile label="Month" totals={stats.periods.month} truth={truth} />
        <TokenTile label="All time" totals={stats.periods.all} truth={truth} />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-foreground-subtle">
        <span role="group" aria-label="Range" className="flex gap-px">
          {(["today", "week", "month", "all"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={range === value}
              className={cn("border px-1", range === value ? "border-[var(--zaicode-highlight,var(--color-border-hover))] text-foreground" : "border-border hover:text-foreground")}
              onClick={() => update({ statsRange: value })}
            >
              {value}
            </button>
          ))}
        </span>
        <span title="Input / output / cache read tokens of the chosen range">
          in {formatZaicodeCompactCount(period.input)} · out {formatZaicodeCompactCount(period.output)} · cache {formatZaicodeCompactCount(period.cacheRead)}
        </span>
        <span title="Queue runs + CLI worker sessions (autonomous runtime) · model generation time">
          agents {formatZaicodeRuntime(period.agentMs)} · model {formatZaicodeRuntime(period.modelMs)}
        </span>
        <span>
          {period.jobsDone} done · {period.jobsFailed} failed · {period.workerSessions} worker session(s)
        </span>
      </div>
      <span className="text-[10px] text-foreground-subtlest" title={stats.sources.map((source) => `${source.label}: ${source.state} — ${source.detail}`).join("\n")}>
        Local only. Tokens: in-app model requests (agent usage store). CLI workers report no token counts
        {stats.coverage.unmeasuredMs > 0 ? ` (${formatZaicodeRuntime(stats.coverage.unmeasuredMs)} unmeasured)` : ""}.
      </span>
    </ZaicodeHomeCard>
  );
}

function dayTitle(day: ZaicodeStatsDay, measure: ZaicodeStreakMeasure): string {
  const t = day.totals;
  return `${day.date}: ${exact(t.tokens)} tokens · ${t.requests} requests · ${t.turns} turns · ${t.jobsDone} tasks done · ${t.workerSessions} worker session(s) · runtime ${formatZaicodeRuntime(t.agentMs + t.modelMs)}${measure !== "activity" ? ` · ${MEASURE_LABEL[measure]}: ${exact(zaicodeStreakValue(t, measure))}` : ""}`;
}

const LEVEL_COLORS = [
  "var(--color-background)",
  "color-mix(in srgb, var(--color-success) 30%, var(--color-background))",
  "color-mix(in srgb, var(--color-success) 55%, var(--color-background))",
  "color-mix(in srgb, var(--color-success) 80%, var(--color-background))",
  "var(--color-success)",
];

export function ZaicodeHomeStreak({ stats }: { stats: ZaicodeHomeStats | null }) {
  const measure = useZaicodeHomePrefs((state) => state.streakMeasure);
  const update = useZaicodeHomePrefs((state) => state.update);
  const [focus, setFocus] = useState<number | null>(null);
  if (!stats) return null;
  const days = stats.days;
  const values = days.map((day) => zaicodeStreakValue(day.totals, measure));
  const max = Math.max(0, ...values);
  // Columns are weeks, rows weekdays (first day of week on top), like developer activity calendars.
  const firstWeekday = (new Date(`${days[0]!.date}T12:00:00Z`).getUTCDay() - stats.weekStartsOn + 7) % 7;
  const cells: ({ day: ZaicodeStatsDay; index: number } | null)[] = [...Array.from({ length: firstWeekday }, () => null), ...days.map((day, index) => ({ day, index }))];
  const columns = Math.ceil(cells.length / 7);
  const detail = focus !== null ? days[focus] : days[days.length - 1];
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = focus ?? days.length - 1;
    const step = event.key === "ArrowLeft" ? -7 : event.key === "ArrowRight" ? 7 : event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
    if (step === 0) return;
    event.preventDefault();
    setFocus(Math.max(0, Math.min(days.length - 1, current + step)));
  };
  return (
    <ZaicodeHomeCard
      title="Activity"
      widget="streak"
      right={`streak ${stats.streak.current}d · longest ${stats.streak.longest}d · ${stats.streak.activeDays} active day(s)`}
    >
      <div className="flex flex-wrap items-center gap-1 text-foreground-subtle">
        <span>Measure</span>
        {ZAICODE_STREAK_MEASURES.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={measure === value}
            className={cn("border px-1", measure === value ? "border-[var(--zaicode-highlight,var(--color-border-hover))] text-foreground" : "border-border hover:text-foreground")}
            onClick={() => update({ streakMeasure: value })}
          >
            {MEASURE_LABEL[value]}
          </button>
        ))}
      </div>
      <div
        role="grid"
        aria-label={`Activity by day, ${MEASURE_LABEL[measure]}. Arrow keys move between days.`}
        tabIndex={0}
        onKeyDown={onKey}
        className="grid w-max max-w-full gap-[2px] overflow-x-auto pb-0.5 outline-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--zaicode-highlight,var(--color-border-hover))]"
        style={{ gridTemplateRows: "repeat(7, 10px)", gridTemplateColumns: `repeat(${columns}, 10px)`, gridAutoFlow: "column" }}
      >
        {cells.map((cell, position) =>
          cell ? (
            <span
              key={cell.day.date}
              role="gridcell"
              aria-label={dayTitle(cell.day, measure)}
              title={dayTitle(cell.day, measure)}
              onMouseEnter={() => setFocus(cell.index)}
              className={cn("size-[10px] border", cell.index === days.length - 1 ? "border-[var(--zaicode-highlight,var(--color-warning))]" : "border-black/30", focus === cell.index && "outline outline-1 outline-foreground")}
              style={{ background: LEVEL_COLORS[zaicodeIntensity(values[cell.index] ?? 0, max)] }}
            />
          ) : (
            <span key={`gap-${position}`} aria-hidden />
          ),
        )}
      </div>
      {detail ? <span className="truncate text-foreground-subtle">{dayTitle(detail, measure)}</span> : null}
    </ZaicodeHomeCard>
  );
}

function Fact({ label, value, formula }: { label: string; value: string; formula: string }) {
  return (
    <div className="flex min-w-0 justify-between gap-2 border-b border-border/40 py-0.5 last:border-b-0" title={formula}>
      <span className="truncate text-foreground-subtle">{label}</span>
      <span className="shrink-0 tabular-nums text-foreground">{value}</span>
    </div>
  );
}

export function ZaicodeHomeNerdStats({ stats }: { stats: ZaicodeHomeStats | null }) {
  if (!stats || stats.eventCount === 0) return null;
  const d = stats.derived;
  const hour = d.peakHour === null ? "not enough data" : `${String(d.peakHour).padStart(2, "0")}:00–${String((d.peakHour + 1) % 24).padStart(2, "0")}:00`;
  return (
    <ZaicodeHomeCard title="Numbers" widget="nerd" right="hover a line for its formula">
      <div className="flex flex-col">
        <Fact label="Current / longest streak" value={`${stats.streak.current}d / ${stats.streak.longest}d`} formula="Consecutive local days with at least one recorded event (current: ending today, or yesterday while today is empty)" />
        <Fact label="Tokens today vs yesterday" value={formatZaicodeRatio(d.tokensTodayVsYesterday)} formula="today tokens ÷ yesterday tokens" />
        <Fact label="Last 7 days vs the 7 before" value={formatZaicodeRatio(d.tokensWeekVsPreviousWeek)} formula="tokens of the last 7 days ÷ tokens of the 7 days before them" />
        <Fact label="Queue run success" value={formatZaicodePercent(d.jobSuccessRate)} formula="runs done ÷ (runs done + runs failed), all time" />
        <Fact label="Model request failures" value={formatZaicodePercent(d.requestFailureRate)} formula="failed model requests ÷ all model requests, all time" />
        <Fact label="Cache share" value={formatZaicodePercent(d.cacheShare)} formula="cache-read tokens ÷ (input + cache-read + cache-write tokens), all time" />
        <Fact label="Tasks per 1M tokens" value={d.jobsPerMillionTokens === null ? "not enough data" : d.jobsPerMillionTokens.toFixed(2)} formula="queue runs done ÷ (measured tokens ÷ 1,000,000), all time" />
        <Fact label="Recovered runs" value={String(d.recoveredRuns)} formula="queue runs that finished OK as a retry of an earlier run" />
        <Fact label="Average run" value={formatZaicodeRuntime(d.averageJobMs)} formula="queue run time ÷ finished queue runs" />
        <Fact label="Longest autonomous run" value={formatZaicodeRuntime(d.longestRunMs)} formula="longest queue run or CLI worker session" />
        <Fact label="Peak hour" value={hour} formula="local hour with the most model requests, all time" />
        <Fact label="Busiest day" value={d.busiestDay ? `${d.busiestDay.date} · ${formatZaicodeCompactCount(d.busiestDay.tokens)}` : "not enough data"} formula="local date with the most tokens" />
        <Fact label="Most used model" value={d.mostUsedModel ? d.mostUsedModel.key : "not enough data"} formula="provider / model with the most tokens" />
        <Fact label="Most active project" value={d.mostActiveProject ? projectNameOf(d.mostActiveProject.key) : "not enough data"} formula="project folder with the most tokens (then events)" />
      </div>
    </ZaicodeHomeCard>
  );
}

const JOURNAL_LABEL: Record<string, string> = {
  "agent.done": "turn finished",
  "agent.failed": "turn failed",
  "agent.question": "question for you",
  "agent.human": "permission needed",
  "limits.refill": "quota refilled",
  "limits.low": "quota low",
  "autostart.fire": "schedule fired",
  "autostart.missed": "schedule missed",
  "router.free": "free model added",
  "router.ready": "SAIFREN ready",
  "saimail.new": "SAIMAIL letter",
};

export interface ZaicodeHomeTimelineLine {
  key: string;
  at: number;
  text: string;
  detail: string;
  bad: boolean;
  duration: number | null;
}

/** Queue runs and worker sessions (statistics) merged with the app's own event journal, newest first. */
export function zaicodeHomeTimeline(
  activity: readonly ZaicodeStatsActivity[],
  journal: readonly ZaicodeHomeJournalEvent[],
): ZaicodeHomeTimelineLine[] {
  const lines: ZaicodeHomeTimelineLine[] = activity.map((entry) => {
    const what =
      entry.kind === "worker.session"
        ? `${entry.engine ?? "worker"} session ${entry.result === "failed" ? "failed" : "ended"}`
        : entry.result === "completed"
          ? entry.recovered
            ? "run recovered"
            : "run done"
          : entry.result === "cancelled"
            ? "run cancelled"
            : "run failed";
    return {
      key: entry.id,
      at: entry.at,
      text: `${what}${entry.project ? ` · ${projectNameOf(entry.project)}` : ""}`,
      detail: [entry.failure, entry.project].filter(Boolean).join("\n"),
      bad: entry.result === "failed",
      duration: entry.durationMs,
    };
  });
  for (const event of journal) {
    lines.push({
      key: `j-${event.scenario}-${event.at}`,
      at: event.at,
      text: `${JOURNAL_LABEL[event.scenario] ?? event.scenario} · ${event.title}`,
      detail: event.body,
      bad: event.scenario === "agent.failed" || event.scenario === "autostart.missed" || event.scenario === "limits.low",
      duration: null,
    });
  }
  return lines.sort((left, right) => right.at - left.at);
}

export function ZaicodeHomeActivity({ lines, now }: { lines: readonly ZaicodeHomeTimelineLine[]; now: number }) {
  if (lines.length === 0) return null;
  return (
    <ZaicodeHomeCard title="Recent" widget="activity" onOpen={() => void openZaicodeWorkspaceView()} openLabel="Open the ZAICODE workspace">
      <ul className="flex flex-col gap-0.5">
        {lines.slice(0, 12).map((line) => (
          <li key={line.key} className="flex min-w-0 gap-2" title={line.detail || undefined}>
            <span className="w-[64px] shrink-0 tabular-nums text-foreground-subtlest">{formatZaicodeDuration(Math.max(0, now - line.at))} ago</span>
            <span className={cn("min-w-0 flex-1 truncate", line.bad ? "text-destructive" : "text-foreground")}>{line.text}</span>
            {line.duration !== null ? <span className="shrink-0 tabular-nums text-foreground-subtlest">{formatZaicodeRuntime(line.duration)}</span> : null}
          </li>
        ))}
      </ul>
    </ZaicodeHomeCard>
  );
}
