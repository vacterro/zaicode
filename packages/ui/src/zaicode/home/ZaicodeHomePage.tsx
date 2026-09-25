import { useEffect, useRef, useState, type ReactNode } from "react";
import { MessageCirclePlus, RefreshCw, Settings2 } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { openZaicodeSettings } from "../zaicodeActions.js";
import { decideZaicodeAutostartJob, useZaicodeAutostartJobs } from "../zaicodeAutostart.js";
import { useZaicodeEngines } from "../zaicodeEngines.js";
import { useZaicodeClock } from "../ZaicodeLimitViews.js";
import { useZaicodeMeterPrefs } from "../zaicodeMeterPrefs.js";
import { useZaicodeRouter } from "../zaicodeRouter.js";
import { useZaicodeRouterSetup } from "../zaicodeRouterSetup.js";
import { zaicodeUpcomingSchedules } from "../zaicodeScheduler.js";
import { useZaicodeSessionNav } from "../zaicodeSessionNav.js";
import { useZaicodeRunningSessions } from "../zaicodeSidebarPrefs.js";
import { useZaicodeWorkers } from "../zaicodeWorkers.js";
import { useZaicodeSaimailDesk } from "../zaicodeSaimail.js";
import { ZaicodeAnalogClock } from "./ZaicodeAnalogClock.js";
import {
  ZaicodeHomeActions,
  ZaicodeHomeCard,
  ZaicodeHomeLimits,
  ZaicodeHomeNow,
  ZaicodeHomeRouting,
  ZaicodeHomeSaimail,
  ZaicodeHomeScheduler,
} from "./ZaicodeHomeCards.js";
import {
  ZaicodeHomeAgents,
  ZaicodeHomeFleet,
  ZaicodeHomeProjectProbes,
  ZaicodeHomeSaipen,
  useZaicodeHomeProjectInputs,
  useZaicodeHomeProjects,
  type ZaicodeHomeProjectRow,
} from "./ZaicodeHomeFleet.js";
import {
  ZaicodeHomeActivity,
  ZaicodeHomeNerdStats,
  ZaicodeHomeStats,
  ZaicodeHomeStreak,
  ZaicodeHomeTokenRibbon,
  zaicodeHomeTimeline,
} from "./ZaicodeHomeStatsCards.js";
import { useZaicodeHomeJournal } from "./zaicodeHomeJournal.js";
import { refreshZaicodeHome, useZaicodeHomeFeed, useZaicodeHomeFeedRefresh } from "./zaicodeHomeFeed.js";
import {
  zaicodeHomeActionItems,
  zaicodeHomeLimitRows,
  zaicodeHomeQueueCounts,
  zaicodeHomeRouting,
  zaicodeStartOfToday,
  type ZaicodeHomeTruth,
} from "./zaicodeHomeModel.js";
import {
  ZAICODE_HOME_PRESETS,
  ZAICODE_HOME_WIDGETS,
  useZaicodeHomePrefs,
  zaicodeHomeLayout,
  type ZaicodeHomePreset,
  type ZaicodeHomeWidgetEntry,
  type ZaicodeHomeWidgetId,
} from "./zaicodeHomePrefs.js";

/**
 * SAIHOME (T-56): "what is happening?". NEW TASK stays the composer
 * ("what do I want to start?"); nothing on this page starts work by being
 * opened. One snapshot is assembled here from the owners' stores and the
 * one SAIHOME feed; the widgets only render slices of it.
 */


/** Columns from the grid's own width: whole pixels, no transform scaling, no overlap. */
function useGridColumns(minColumn: number): { ref: (element: HTMLDivElement | null) => void; columns: number } {
  const [columns, setColumns] = useState(2);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = (element: HTMLDivElement | null) => {
    observer.current?.disconnect();
    if (!element || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const width = Math.floor(element.clientWidth);
      setColumns(Math.max(1, Math.min(4, Math.floor((width + 8) / (minColumn + 8)))));
    };
    observer.current = new ResizeObserver(measure);
    observer.current.observe(element);
    measure();
  };
  useEffect(() => () => observer.current?.disconnect(), []);
  return { ref, columns };
}

function span(entry: ZaicodeHomeWidgetEntry, columns: number, id: ZaicodeHomeWidgetId): number {
  if (id === "now" || id === "actions") return columns;
  return entry.size === "large" ? Math.min(2, columns) : 1;
}

function LayoutEditor({ entries, onChange, onDone }: { entries: ZaicodeHomeWidgetEntry[]; onChange: (entries: ZaicodeHomeWidgetEntry[]) => void; onDone: () => void }) {
  const move = (index: number, delta: number) => {
    const next = [...entries];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  };
  return (
    <ZaicodeHomeCard title="Edit layout" widget="editor" right="order · show · size — saved on this profile">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-1">
        {entries.map((entry, index) => {
          const def = ZAICODE_HOME_WIDGETS.find((widget) => widget.id === entry.id)!;
          return (
            <div key={entry.id} className="flex items-center gap-1 border border-border/70 bg-background px-1 py-0.5" title={def.hint}>
              <input
                type="checkbox"
                aria-label={`Show ${def.label}`}
                checked={entry.visible}
                onChange={(event) => onChange(entries.map((current) => (current.id === entry.id ? { ...current, visible: event.target.checked } : current)))}
              />
              <span className={cn("min-w-0 flex-1 truncate", entry.visible ? "text-foreground" : "text-foreground-subtlest")}>{def.label}</span>
              <select
                aria-label={`${def.label} size`}
                className="border border-border bg-background text-foreground"
                value={entry.size}
                onChange={(event) => onChange(entries.map((current) => (current.id === entry.id ? { ...current, size: event.target.value as ZaicodeHomeWidgetEntry["size"] } : current)))}
              >
                <option value="compact">compact</option>
                <option value="normal">normal</option>
                <option value="large">large</option>
              </select>
              <button type="button" aria-label={`Move ${def.label} up`} className="border border-border px-1 hover:bg-hover" onClick={() => move(index, -1)}>
                ↑
              </button>
              <button type="button" aria-label={`Move ${def.label} down`} className="border border-border px-1 hover:bg-hover" onClick={() => move(index, 1)}>
                ↓
              </button>
            </div>
          );
        })}
      </div>
      <div className="flex justify-end">
        <button type="button" className="border border-border bg-card px-2 hover:bg-hover" onClick={onDone}>
          Done
        </button>
      </div>
    </ZaicodeHomeCard>
  );
}

export function ZaicodeHomePage({
  onOpenSession,
  onNewTask,
}: {
  onOpenSession: (workspacePath: string, sessionId: string, workspaceIdentity?: string) => void;
  onNewTask: () => void;
}) {
  useZaicodeHomeFeedRefresh();
  const prefs = useZaicodeHomePrefs();
  const [editing, setEditing] = useState(false);
  const [showAllLimits, setShowAllLimits] = useState(false);
  const now = useZaicodeClock(30_000);
  const projects = useZaicodeHomeProjectInputs();
  const projectRows = Object.values(useZaicodeHomeProjects((state) => state.rows)).filter((row) => projects.some((project) => project.key === row.key));
  const engines = useZaicodeEngines();
  const meterPrefs = useZaicodeMeterPrefs();
  const autostartJobs = useZaicodeAutostartJobs();
  const router = useZaicodeRouter();
  const routerSetup = useZaicodeRouterSetup();
  const sessions = useZaicodeRunningSessions((state) => state.sessions);
  const waiting = useZaicodeSessionNav((state) => state.waiting);
  const workers = useZaicodeWorkers().workers;
  const feed = useZaicodeHomeFeed();
  const activateTabByPath = useTabStore((state) => state.activateTabByPath);
  const saimail = useZaicodeSaimailDesk(null);
  const journal = useZaicodeHomeJournal((state) => state.events);

  const limits = zaicodeHomeLimitRows({
    accounts: engines.accounts,
    hiddenAccounts: engines.config.hiddenAccounts,
    limits: engines.limits,
    meterPrefs,
    showAll: showAllLimits,
    now,
  });
  const upcoming = zaicodeUpcomingSchedules(autostartJobs, (job) => decideZaicodeAutostartJob(job, now));
  const routing = zaicodeHomeRouting({
    status: router.status,
    message: router.message,
    host: routerSetup.host,
    combos: router.combos,
    connections: router.connections,
    lastScanAt: routerSetup.lastScanAt,
  });
  const stats = feed.stats.value;
  const actions = zaicodeHomeActionItems({
    routing,
    limitRows: limits.rows,
    projects: projectRows.map((row) => ({ path: row.path, name: row.name, state: row.state, reason: row.blocker ?? row.reason, disabled: row.disabled })),
    waitingSessions: waiting.length,
    schedules: autostartJobs
      .filter((job) => job.enabled)
      .map((job) => {
        const decision = decideZaicodeAutostartJob(job, now);
        const problem = decision.state === "invalid" ? "cannot run as set up" : job.lastResult?.startsWith("missed") ? job.lastResult : null;
        return { id: job.id, name: job.name || "schedule", problem };
      }),
    statsSources: stats?.sources ?? [],
    statsError: feed.stats.error,
  });
  const queue = zaicodeHomeQueueCounts(feed.jobs.value, zaicodeStartOfToday(now));
  const nextResetRow = limits.rows
    .filter((row) => row.nextResetAt !== null)
    .sort((left, right) => left.nextResetAt! - right.nextResetAt!)[0];
  const nextSchedule = upcoming[0];
  const statsTruth: ZaicodeHomeTruth = !stats ? "unavailable" : feed.stats.error ? "stale" : "authoritative";

  const goToProject = (row: ZaicodeHomeProjectRow) => {
    activateTabByPath(row.path, row.identity ? { workspaceIdentity: row.identity } : undefined);
  };
  const openProjectByPath = (path: string) => {
    const row = projectRows.find((candidate) => candidate.path === path);
    if (row) goToProject(row);
  };

  const render = (id: ZaicodeHomeWidgetId): ReactNode => {
    switch (id) {
      case "clock":
        return (
          <ZaicodeHomeCard title="Clock" widget="clock">
            <ZaicodeAnalogClock prefs={prefs.clock} />
          </ZaicodeHomeCard>
        );
      case "now":
        return (
          <ZaicodeHomeNow
            facts={{
              sessionsRunning: sessions.length,
              sessionsWaiting: waiting.length,
              workersRunning: workers.filter((worker) => worker.exitCode === null && worker.kind === "worker").length,
              projectsWorking: projectRows.filter((row) => row.state === "working").length,
              queue,
              today: {
                tokens: stats ? stats.periods.today.tokens : null,
                jobsDone: stats ? stats.periods.today.jobsDone : null,
                jobsFailed: stats ? stats.periods.today.jobsFailed : null,
                agentMs: stats ? stats.periods.today.agentMs : null,
                truth: statsTruth,
              },
              nextReset: nextResetRow ? { label: nextResetRow.account.short, at: nextResetRow.nextResetAt! } : null,
              nextSchedule: nextSchedule ? { label: nextSchedule.job.name || "schedule", at: nextSchedule.decision.dueAt ?? null } : null,
              problems: actions.length,
              now,
            }}
          />
        );
      case "actions":
        // Healthy is the default: no problem, no card.
        return actions.length > 0 ? <ZaicodeHomeActions items={actions} onOpenProject={openProjectByPath} /> : null;
      case "stats":
        return <ZaicodeHomeStats stats={stats} error={feed.stats.error} />;
      case "limits":
        return <ZaicodeHomeLimits rows={limits.rows} filtered={limits.filtered} showAll={showAllLimits} onShowAll={setShowAllLimits} probing={engines.probing} />;
      case "scheduler":
        return <ZaicodeHomeScheduler upcoming={upcoming} now={now} />;
      case "fleet":
        return (
          <ZaicodeHomeFleet
            rows={projectRows}
            onGoToProject={goToProject}
            onOpenSession={(row, sessionId) => onOpenSession(row.path, sessionId, row.identity)}
          />
        );
      case "agents":
        return <ZaicodeHomeAgents sessions={sessions} waiting={waiting} workers={workers} jobs={feed.jobs.value} now={now} />;
      case "streak":
        return stats && stats.eventCount > 0 ? <ZaicodeHomeStreak stats={stats} /> : null;
      case "routing":
        return <ZaicodeHomeRouting routing={routing} />;
      case "saipen":
        return projectRows.some((row) => row.hasSaipen && !row.disabled) ? <ZaicodeHomeSaipen rows={projectRows} /> : null;
      case "saimail":
        return saimail.mailbox && saimail.desk && saimail.desk.unread.length > 0 ? <ZaicodeHomeSaimail /> : null;
      case "nerd":
        return stats && stats.eventCount > 0 ? <ZaicodeHomeNerdStats stats={stats} /> : null;
      case "activity": {
        const lines = zaicodeHomeTimeline(feed.activity.value, journal);
        return lines.length > 0 ? <ZaicodeHomeActivity lines={lines} now={now} /> : null;
      }
    }
  };

  const layout = zaicodeHomeLayout(prefs);
  const grid = useGridColumns(prefs.density === "compact" ? 250 : 300);
  const presets = [...(Object.keys(ZAICODE_HOME_PRESETS) as Exclude<ZaicodeHomePreset, "custom">[]), "custom" as const];
  return (
    <div className="flex h-full min-h-0 flex-col" data-zaicode-saihome>
      <ZaicodeHomeProjectProbes projects={projects} />
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-1.5 text-ui-xs">
        <h1 className="text-ui-sm tracking-wide text-foreground">SAIHOME</h1>
        {prefs.tokenRibbon && stats ? (
          <ZaicodeHomeTokenRibbon stats={stats} error={feed.stats.error} />
        ) : (
          <span className="text-foreground-subtlest">what is happening</span>
        )}
        <span className="flex-1" />
        <span role="group" aria-label="Layout preset" className="flex gap-px">
          {presets.map((preset) => (
            <button
              key={preset}
              type="button"
              aria-pressed={prefs.preset === preset}
              className={cn("border px-1.5", prefs.preset === preset ? "border-[var(--zaicode-highlight,var(--color-border-hover))] bg-selected text-foreground" : "border-border text-foreground-subtle hover:text-foreground")}
              onClick={() => prefs.update({ preset })}
            >
              {preset === "custom" ? "CUSTOM" : ZAICODE_HOME_PRESETS[preset].label}
            </button>
          ))}
        </span>
        <button
          type="button"
          aria-pressed={editing}
          className={cn("border px-1.5", editing ? "border-[var(--zaicode-highlight,var(--color-border-hover))] text-foreground" : "border-border text-foreground-subtle hover:text-foreground")}
          onClick={() => {
            if (!editing && prefs.preset !== "custom") {
              // Editing starts from what is on screen, so nothing jumps.
              const visible = new Set(layout.map((entry) => entry.id));
              const order = [...layout.map((entry) => entry.id), ...prefs.custom.map((entry) => entry.id).filter((id) => !visible.has(id))];
              prefs.editLayout(order.map((id) => ({ ...(prefs.custom.find((entry) => entry.id === id)!), visible: visible.has(id) })));
            }
            setEditing(!editing);
          }}
        >
          Edit layout
        </button>
        <button
          type="button"
          className="flex items-center gap-1 border border-border px-1.5 text-foreground-subtle hover:text-foreground"
          title={feed.lastRefreshAt ? `Last refresh ${new Date(feed.lastRefreshAt).toLocaleTimeString()}` : "Refresh"}
          onClick={() => void refreshZaicodeHome()}
        >
          <RefreshCw className="size-3" />
          {feed.refreshing ? "…" : "Refresh"}
        </button>
        <button type="button" className="flex items-center gap-1 border border-border px-1.5 text-foreground-subtle hover:text-foreground" title="SAIHOME settings" onClick={() => void openZaicodeSettings("zaicodeLayout")}>
          <Settings2 className="size-3" />
        </button>
        <button type="button" className="flex items-center gap-1 border border-border bg-card px-1.5 text-foreground hover:bg-hover" title="NEW TASK: the composer (SAIHOME itself starts nothing)" onClick={onNewTask}>
          <MessageCirclePlus className="size-3" />
          New task
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        <div
          ref={grid.ref}
          className={cn("grid items-start gap-2", prefs.density === "compact" ? "p-2" : "p-3")}
          style={{ gridTemplateColumns: `repeat(${grid.columns}, minmax(0, 1fr))`, gridAutoFlow: "row dense" }}
        >
          {editing ? (
            <div style={{ gridColumn: `span ${grid.columns}` }}>
              <LayoutEditor entries={prefs.custom} onChange={prefs.editLayout} onDone={() => setEditing(false)} />
            </div>
          ) : null}
          {layout.map((entry) => {
            const node = render(entry.id);
            if (!node) return null;
            return (
              <div key={entry.id} className="min-w-0" style={{ gridColumn: `span ${span(entry, grid.columns, entry.id)}` }}>
                {node}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
