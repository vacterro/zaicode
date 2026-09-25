import type { ReactNode } from "react";
import { AlertTriangle, CalendarClock, ChevronRight, Mail, Pause, Play, RefreshCw, Route } from "lucide-react";
import {
  ZAICODE_HIT_AND_GO_PROMPT,
  formatZaicodeDuration,
  formatZaicodeCompactCount,
} from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useServices } from "@/hooks/useServices.js";
import { setPendingSettingsSection } from "@/lib/settingsNavigation.js";
import { openZaicodeSettings } from "../zaicodeActions.js";
import { refreshZaicodeEngineLimits } from "../zaicodeEngines.js";
import { ZaicodeAccountLimits, useZaicodeClock } from "../ZaicodeLimitViews.js";
import { openZaicodeScheduler, useZaicodePreparedMeters } from "../ZaicodeSchedulerBits.js";
import { runZaicodeAutostartNow, updateZaicodeAutostartJob } from "../zaicodeAutostart.js";
import { describeZaicodeSchedule, type ZaicodeScheduleNext } from "../zaicodeScheduler.js";
import { useZaicodeRouter } from "../zaicodeRouter.js";
import { runZaicodeRouterSetup } from "../useZaicodeRouterAutoSetup.js";
import { useZaicodeRouterSetup } from "../zaicodeRouterSetup.js";
import { useZaicodeSaimailDesk } from "../zaicodeSaimail.js";
import { openZaicodeSession, useZaicodeSessionNav } from "../zaicodeSessionNav.js";
import type { ZaicodeHomeActionItem, ZaicodeHomeLimitRow, ZaicodeHomeRouting, ZaicodeHomeTruth } from "./zaicodeHomeModel.js";

/**
 * SAIHOME operational cards (T-56): the frame every module uses, then Now,
 * Needs you, AI limits, Scheduler, Routing and SAIMAIL. Each reads the one
 * assembled snapshot it is given; none of them polls anything itself.
 */

export function ZaicodeHomeCard({
  title,
  right,
  onOpen,
  openLabel,
  children,
  className,
  widget,
}: {
  title: string;
  right?: ReactNode;
  /** The authoritative surface behind this card. */
  onOpen?: () => void;
  openLabel?: string;
  children: ReactNode;
  className?: string;
  widget: string;
}) {
  return (
    <section
      className={cn("flex min-w-0 flex-col gap-1.5 border border-border bg-card p-2 text-ui-xs", className)}
      aria-label={title}
      data-zaicode-home-widget={widget}
    >
      <header className="flex min-w-0 items-center gap-2">
        <h2 className="shrink-0 text-ui-xs tracking-wide text-foreground-subtle">{title.toUpperCase()}</h2>
        <span className="min-w-0 flex-1 truncate text-right text-foreground-subtlest">{right}</span>
        {onOpen ? (
          <button
            type="button"
            className="flex shrink-0 items-center text-foreground-subtle hover:text-foreground"
            title={openLabel ?? `Open ${title}`}
            aria-label={openLabel ?? `Open ${title}`}
            onClick={onOpen}
          >
            <ChevronRight className="size-3.5" />
          </button>
        ) : null}
      </header>
      {children}
    </section>
  );
}

/** A value with its provenance: stale / estimated / unavailable never look like a confident number. */
export function ZaicodeTruthValue({
  truth,
  children,
  title,
  className,
}: {
  truth: ZaicodeHomeTruth;
  children: ReactNode;
  title?: string;
  className?: string;
}) {
  const note = truth === "stale" ? " (stale)" : truth === "estimated" ? " (estimated)" : "";
  return (
    <span
      className={cn(
        "tabular-nums",
        truth === "stale" && "text-foreground-subtle italic",
        truth === "unavailable" && "text-foreground-subtlest",
        className,
      )}
      title={`${title ?? ""}${title ? "\n" : ""}Source: ${truth}${note}`}
      data-zaicode-truth={truth}
    >
      {truth === "unavailable" ? "—" : children}
    </span>
  );
}

export interface ZaicodeHomeNowFacts {
  sessionsRunning: number;
  sessionsWaiting: number;
  workersRunning: number;
  projectsWorking: number;
  queue: { running: number; ready: number; waiting: number; blocked: number } | null;
  today: { tokens: number | null; jobsDone: number | null; jobsFailed: number | null; agentMs: number | null; truth: ZaicodeHomeTruth };
  nextReset: { label: string; at: number } | null;
  nextSchedule: { label: string; at: number | null } | null;
  problems: number;
  now: number;
}

function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: "bad" | "warn" | "good" }) {
  return (
    <div className="flex min-w-[88px] flex-1 flex-col border border-border/70 bg-background px-1.5 py-1" title={hint}>
      <span className="text-[10px] tracking-wide text-foreground-subtlest">{label}</span>
      <span
        className={cn(
          "truncate text-ui-sm tabular-nums",
          tone === "bad" ? "text-destructive" : tone === "warn" ? "text-[var(--color-warning)]" : tone === "good" ? "text-[var(--color-success)]" : "text-foreground",
        )}
      >
        {value}
      </span>
    </div>
  );
}

/** The first answers: is anything working, broken, resetting, starting; how much happened today. */
export function ZaicodeHomeNow({ facts }: { facts: ZaicodeHomeNowFacts }) {
  const queue = facts.queue;
  const working = facts.sessionsRunning + facts.workersRunning;
  return (
    <ZaicodeHomeCard title="Now" widget="now">
      <div className="flex flex-wrap gap-1">
        <Stat
          label="WORKING"
          value={working > 0 ? `${facts.sessionsRunning} sess · ${facts.workersRunning} wkr` : "idle"}
          hint={`${facts.sessionsRunning} session(s) and ${facts.workersRunning} worker(s) running in ${facts.projectsWorking} project(s)`}
          {...(working > 0 ? { tone: "good" as const } : {})}
        />
        <Stat
          label="QUEUE"
          value={queue ? `${queue.running} run · ${queue.ready} ready` : "—"}
          hint={queue ? `running ${queue.running}, ready ${queue.ready}, waiting ${queue.waiting}, blocked ${queue.blocked} (ZAICODE queue)` : "queue not available here"}
          {...(queue && queue.blocked > 0 ? { tone: "warn" as const } : {})}
        />
        <Stat
          label="TODAY"
          value={
            <ZaicodeTruthValue truth={facts.today.truth}>
              {facts.today.tokens === null ? "—" : `${formatZaicodeCompactCount(facts.today.tokens)} tok`}
              {facts.today.jobsDone !== null ? ` · ${facts.today.jobsDone} done` : ""}
            </ZaicodeTruthValue>
          }
          hint={`Measured tokens of in-app model requests today${facts.today.jobsFailed ? `; ${facts.today.jobsFailed} run(s) failed` : ""}`}
        />
        <Stat
          label="NEXT RESET"
          value={facts.nextReset ? `${facts.nextReset.label} ${formatZaicodeDuration(Math.max(0, facts.nextReset.at - facts.now))}` : "none pending"}
          hint="Nearest subscription window that refills"
        />
        <Stat
          label="NEXT START"
          value={facts.nextSchedule ? `${facts.nextSchedule.label}${facts.nextSchedule.at ? ` ${formatZaicodeDuration(Math.max(0, facts.nextSchedule.at - facts.now))}` : " at reset"}` : "nothing armed"}
          hint="Nearest armed SCHEDULER entry"
        />
        <Stat
          label="HEALTH"
          value={facts.problems === 0 ? "all clear" : `${facts.problems} to look at`}
          tone={facts.problems === 0 ? "good" : "bad"}
          hint="Problems listed under NEEDS YOU"
        />
      </div>
    </ZaicodeHomeCard>
  );
}

export function ZaicodeHomeActions({ items, onOpenProject }: { items: readonly ZaicodeHomeActionItem[]; onOpenProject: (path: string) => void }) {
  const { providerSettingsService } = useServices();
  const waiting = useZaicodeSessionNav((state) => state.waiting);
  if (items.length === 0) return null;
  const run = (item: ZaicodeHomeActionItem) => {
    const { kind, target } = item.action;
    if (kind === "troubleshoot-router") void runZaicodeRouterSetup(providerSettingsService, "troubleshoot");
    else if (kind === "open-router") void openZaicodeSettings("zaicodeRouter");
    else if (kind === "open-engines") void openZaicodeSettings("zaicodeEngines");
    else if (kind === "read-engine") void refreshZaicodeEngineLimits(target);
    else if (kind === "open-project" && target) onOpenProject(target);
    else if (kind === "open-waiting" && waiting[0]) void openZaicodeSession(waiting[0]);
    else if (kind === "open-scheduler") openZaicodeScheduler();
    else if (kind === "open-home-settings") {
      setPendingSettingsSection("zaicodeLayout");
      void openZaicodeSettings("zaicodeLayout");
    }
  };
  return (
    <ZaicodeHomeCard title="Needs you" right={`${items.length} item(s)`} widget="actions" className="border-[var(--color-warning)]">
      <ul className="flex flex-col gap-1">
        {items.slice(0, 8).map((item) => (
          <li key={item.id} className="flex min-w-0 items-start gap-2 border border-border/70 bg-background px-1.5 py-1">
            <AlertTriangle className={cn("mt-0.5 size-3.5 shrink-0", item.severity === "blocking" ? "text-destructive" : "text-[var(--color-warning)]")} />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-foreground" title={item.what}>{item.what}</span>
              <span className="truncate text-foreground-subtle" title={`Why: ${item.why}\nImpact: ${item.impact}`}>
                {item.why} · {item.impact}
              </span>
            </div>
            <button
              type="button"
              className="shrink-0 border border-border bg-card px-1.5 text-foreground hover:bg-hover"
              onClick={() => run(item)}
            >
              {item.action.label}
            </button>
          </li>
        ))}
      </ul>
    </ZaicodeHomeCard>
  );
}

export function ZaicodeHomeLimits({
  rows,
  filtered,
  showAll,
  onShowAll,
  probing,
}: {
  rows: readonly ZaicodeHomeLimitRow[];
  filtered: number;
  showAll: boolean;
  onShowAll: (showAll: boolean) => void;
  probing: readonly string[];
}) {
  const now = useZaicodeClock(30_000);
  const prepared = useZaicodePreparedMeters();
  const right =
    filtered > 0 || showAll ? (
      <button type="button" className="hover:text-foreground" onClick={() => onShowAll(!showAll)} title="A temporary view: the saved meter filters stay as they are">
        {showAll ? "filtered view" : `show all (+${filtered})`}
      </button>
    ) : (
      `${rows.length} engine(s)`
    );
  return (
    <ZaicodeHomeCard title="AI limits" right={right} widget="limits" onOpen={() => void openZaicodeSettings("zaicodeEngines")} openLabel="Engines & limits">
      {rows.length === 0 ? (
        <button type="button" className="self-start text-foreground-subtle hover:text-foreground" onClick={() => void openZaicodeSettings("zaicodeEngines")}>
          No subscription engine found yet: open Engines & limits
        </button>
      ) : (
        <div className="flex flex-col gap-1.5">
          {rows.map((row) => {
            const ready = prepared(row.account.id);
            return (
              <div
                key={row.account.id}
                className="border border-border/70 bg-background px-1.5 py-1"
                title={ready.hint ?? undefined}
                {...(ready.lights ?? {})}
                data-zaicode-home-engine={row.account.id}
                data-zaicode-truth={row.truth}
              >
                <ZaicodeAccountLimits account={row.account} snapshot={row.snapshot} now={now} probing={probing.includes(row.account.id)} compact />
                {ready.hint ? <div className="pl-2 text-[var(--zaicode-highlight,var(--color-warning))]">Prepared: starts at reset</div> : null}
                {row.truth === "stale" ? <div className="pl-2 text-foreground-subtlest">stale reading</div> : null}
              </div>
            );
          })}
        </div>
      )}
    </ZaicodeHomeCard>
  );
}

function scheduleWhen(next: ZaicodeScheduleNext, now: number): string {
  const due = next.decision.dueAt;
  if (next.decision.state === "waiting-reset" && !due) return "at reset";
  if (next.decision.state === "waiting-quota") return "waiting for quota";
  return due ? (due > now ? `in ${formatZaicodeDuration(due - now)}` : "now") : "";
}

export function ZaicodeHomeScheduler({ upcoming, now }: { upcoming: readonly ZaicodeScheduleNext[]; now: number }) {
  return (
    <ZaicodeHomeCard title="Scheduler" right={upcoming.length > 0 ? `${upcoming.length} armed` : undefined} widget="scheduler" onOpen={() => openZaicodeScheduler()} openLabel="Open the SCHEDULER">
      {upcoming.length === 0 ? (
        <button type="button" className="flex items-center gap-1 self-start text-foreground-subtle hover:text-foreground" onClick={() => openZaicodeScheduler()}>
          <CalendarClock className="size-3.5" />
          Nothing armed: plan a prompt for the next quota reset
        </button>
      ) : (
        <ul className="flex flex-col gap-1">
          {upcoming.slice(0, 5).map((next) => (
            <li key={next.job.id} className="group flex min-w-0 items-center gap-2" title={describeZaicodeSchedule(next.job, next.job.engineId)}>
              <span className="w-[84px] shrink-0 tabular-nums text-foreground">{scheduleWhen(next, now)}</span>
              <span className="min-w-0 flex-1 truncate text-foreground-subtle">
                {next.job.name || "schedule"} · {next.job.prompt.trim() || ZAICODE_HIT_AND_GO_PROMPT}
                {next.job.stopAt ? ` · stop ${next.job.stopAt}` : ""}
              </span>
              {/* Always laid out, shown on hover / focus: the row never changes size. */}
              <span className="invisible flex shrink-0 gap-px group-focus-within:visible group-hover:visible">
                <button
                  type="button"
                  className="flex size-5 items-center justify-center border border-border hover:bg-hover"
                  title="Run now (a test run; the planned moment still fires once)"
                  aria-label={`Run ${next.job.name || "schedule"} now`}
                  onClick={() => runZaicodeAutostartNow(next.job.id)}
                >
                  <Play className="size-3" />
                </button>
                <button
                  type="button"
                  className="flex size-5 items-center justify-center border border-border hover:bg-hover"
                  title="Pause this schedule (the SCHEDULER page switches it on again)"
                  aria-label={`Pause ${next.job.name || "schedule"}`}
                  onClick={() => updateZaicodeAutostartJob(next.job.id, { enabled: false })}
                >
                  <Pause className="size-3" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </ZaicodeHomeCard>
  );
}

export function ZaicodeHomeRouting({ routing }: { routing: ZaicodeHomeRouting }) {
  const busy = useZaicodeRouterSetup((state) => state.busy);
  const { providerSettingsService } = useServices();
  const tone =
    routing.state === "healthy" ? "text-[var(--color-success)]" : routing.state === "down" ? "text-destructive" : routing.state === "degraded" ? "text-[var(--color-warning)]" : "text-foreground-subtle";
  return (
    <ZaicodeHomeCard
      title="Routing"
      widget="routing"
      right={routing.mode ?? undefined}
      onOpen={() => {
        useZaicodeRouter.getState().requestTab(null);
        void openZaicodeSettings("zaicodeRouter");
      }}
      openLabel="Open Router"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <Route className={cn("size-3.5 shrink-0", tone)} />
        <span className={cn("min-w-0 flex-1 truncate", tone)} title={routing.lastError ?? routing.headline}>
          {routing.headline}
        </span>
        {routing.state === "down" || routing.state === "degraded" ? (
          <button
            type="button"
            disabled={busy !== null}
            className="flex shrink-0 items-center gap-1 border border-border bg-card px-1 hover:bg-hover disabled:opacity-50"
            onClick={() => void runZaicodeRouterSetup(providerSettingsService, "troubleshoot")}
          >
            <RefreshCw className="size-3" />
            {busy === "troubleshoot" ? "fixing…" : "Fix"}
          </button>
        ) : null}
      </div>
      {routing.pools.length > 0 || routing.providers.total > 0 ? (
        <span className="truncate text-foreground-subtlest">
          {routing.pools.map((pool) => `${pool.name} ${pool.models}`).join(" · ")}
          {routing.providers.total > 0 ? ` · providers ${routing.providers.active}/${routing.providers.total}` : ""}
          {routing.restarts > 0 ? ` · ${routing.restarts} restart(s)` : ""}
          {routing.lastScanAt ? ` · scan ${formatZaicodeDuration(Date.now() - routing.lastScanAt)} ago` : ""}
        </span>
      ) : null}
    </ZaicodeHomeCard>
  );
}

/** SAIMAIL: only what its desk reports; healthy emptiness takes no space. */
export function ZaicodeHomeSaimail() {
  const { mailbox, desk } = useZaicodeSaimailDesk(null);
  if (!mailbox || !desk || desk.unread.length === 0) return null;
  return (
    <ZaicodeHomeCard title="SAIMAIL" widget="saimail" right={`${desk.unread.length} unread`}>
      <div className="flex items-center gap-1.5 text-[var(--zaicode-highlight,var(--color-warning))]">
        <Mail className="size-3.5" />
        <span className="truncate">{desk.unread.length} message(s) wait on the desk — the envelope in the title bar opens them</span>
      </div>
    </ZaicodeHomeCard>
  );
}
