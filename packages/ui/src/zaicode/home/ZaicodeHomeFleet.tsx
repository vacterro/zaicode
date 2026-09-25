import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import { formatZaicodeDuration, type ZaicodeJob, type ZaicodeProjectRuntimeState } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { partitionWorkspaceTabsByPurpose } from "@/lib/workspacePurpose.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { projectNameOf } from "../zaicodeEngines.js";
import { useZaicodeSaipen } from "../zaicodeSaipen.js";
import { sameZaicodeProjectPath, useZaicodeProjectRuntime, zaicodeSaipenHeadline } from "../zaicodeProjectRuntime.js";
import { useZaicodeMainSessionId } from "../zaicodeMainSession.js";
import { useZaicodeProjectDisabled } from "../zaicodeProjectSwitch.js";
import { useZaicodeSidebarPrefs, slotGroupOf, type ZaicodeRunningSession } from "../zaicodeSidebarPrefs.js";
import { focusZaicodeWorker, zaicodeWorkerTitle, type ZaicodeWorker } from "../zaicodeWorkers.js";
import { openZaicodeSession, type ZaicodeSessionRef } from "../zaicodeSessionNav.js";
import { openZaicodeWorkspaceView } from "../zaicodeActions.js";
import { ZaicodeHomeCard } from "./ZaicodeHomeCards.js";
import { formatZaicodeRuntime } from "./zaicodeHomeModel.js";

/**
 * SAIHOME project fleet, agents and SAIPEN summary (T-56). One invisible
 * probe per project subscribes to that project's shared SAIPEN poller (the
 * sidebar already polls it; nothing new is asked) and publishes the T-41
 * read-model verdict here, so the fleet, the SAIPEN summary and NEEDS YOU
 * all read the same answer even when the fleet card is hidden.
 */

export interface ZaicodeHomeProjectInput {
  path: string;
  identity?: string;
  key: string;
  name: string;
}

export interface ZaicodeHomeProjectRow extends ZaicodeHomeProjectInput {
  slot: string;
  disabled: boolean;
  hasSaipen: boolean;
  state: ZaicodeProjectRuntimeState;
  label: string;
  reason: string;
  color: string | null;
  phase: string | null;
  task: string | null;
  nextAction: string | null;
  blocker: string | null;
  owner: string | null;
  sessionsRunning: number;
  sessionsWaiting: number;
  workersRunning: number;
  mainSessionId: string | null;
  /** SAIPEN projection read time, or null when only files were read. */
  projectedAt: number | null;
  /** Last SAIPEN LOG line and its time (HH:MM), the project's last meaningful activity. */
  lastAction: string | null;
  lastActionTime: string | null;
  /** SAIPEN board: TODO + DOING tickets, null without SAIPEN (SCHEDULER "most open work first"). */
  openTickets: number | null;
  /** SAIPEN board: BLOCKED tickets, null without SAIPEN. */
  blockedTickets: number | null;
}

export const useZaicodeHomeProjects = create<{ rows: Record<string, ZaicodeHomeProjectRow> }>(() => ({ rows: {} }));

/** The open projects (one per workspace key), in sidebar tab order. */
export function useZaicodeHomeProjectInputs(): ZaicodeHomeProjectInput[] {
  const tabs = useTabStore((state) => state.tabs);
  return useMemo(() => {
    const { projectWorkspaceTabs } = partitionWorkspaceTabsByPurpose(tabs.filter(isWorkspaceTab));
    const seen = new Set<string>();
    const projects: ZaicodeHomeProjectInput[] = [];
    for (const tab of projectWorkspaceTabs) {
      const key = buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity);
      if (seen.has(key)) continue;
      seen.add(key);
      projects.push({ path: tab.workspacePath, key, name: projectNameOf(tab.workspacePath), ...(tab.workspaceIdentity ? { identity: tab.workspaceIdentity } : {}) });
    }
    return projects;
  }, [tabs]);
}

/**
 * Probes are mounted by SAIHOME and by the sidebar's Continue strip (SRC-043);
 * a row leaves the store only when the last probe of its project unmounts.
 */
const probeCounts = new Map<string, number>();

function publishRow(row: ZaicodeHomeProjectRow | null, key: string): void {
  const rows = { ...useZaicodeHomeProjects.getState().rows };
  if (row) rows[key] = row;
  else delete rows[key];
  useZaicodeHomeProjects.setState({ rows });
}

function ProjectProbe({ project }: { project: ZaicodeHomeProjectInput }) {
  const saipen = useZaicodeSaipen(project.path, project.identity);
  const runtime = useZaicodeProjectRuntime(project.path, project.identity, saipen);
  const disabled = useZaicodeProjectDisabled(project.key);
  const groups = useZaicodeSidebarPrefs((state) => state.groups);
  const defaultSlot = useZaicodeSidebarPrefs((state) => state.defaultSlot);
  const mainSessionId = useZaicodeMainSessionId(project.identity?.trim() || project.path);
  const headline = zaicodeSaipenHeadline(saipen);
  const signature = JSON.stringify([
    runtime?.verdict,
    runtime?.snapshot.sessions,
    runtime?.snapshot.workers,
    headline,
    disabled,
    groups[project.key],
    mainSessionId,
    saipen?.owner,
    saipen?.lastAction,
    saipen?.lastActionTime,
    saipen?.counts,
  ]);
  useEffect(() => {
    if (!runtime) return;
    publishRow(
      {
        ...project,
        slot: slotGroupOf(groups, project.key, defaultSlot),
        disabled,
        hasSaipen: Boolean(saipen),
        state: runtime.verdict.state,
        label: runtime.verdict.label,
        reason: runtime.verdict.reason,
        color: runtime.color,
        phase: headline?.phase ?? null,
        task: headline?.task ?? null,
        nextAction: headline?.nextAction ?? null,
        blocker: headline?.blocker ?? null,
        owner: saipen?.owner ?? null,
        sessionsRunning: runtime.snapshot.sessions.running,
        sessionsWaiting: runtime.snapshot.sessions.waiting,
        workersRunning: runtime.snapshot.workers.running,
        mainSessionId,
        projectedAt: saipen?.projection?.readAt ?? null,
        lastAction: saipen?.lastAction ?? null,
        lastActionTime: saipen?.lastActionTime ?? null,
        openTickets: saipen ? saipen.counts.todo + saipen.counts.doing : null,
        blockedTickets: saipen ? saipen.counts.blocked : null,
      },
      project.key,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the signature carries every published fact
  }, [signature]);
  useEffect(() => {
    probeCounts.set(project.key, (probeCounts.get(project.key) ?? 0) + 1);
    return () => {
      const left = (probeCounts.get(project.key) ?? 1) - 1;
      if (left > 0) {
        probeCounts.set(project.key, left);
        return;
      }
      probeCounts.delete(project.key);
      publishRow(null, project.key);
    };
  }, [project.key]);
  return null;
}

/** Mount once on SAIHOME: keeps useZaicodeHomeProjects in step with the open projects. */
export function ZaicodeHomeProjectProbes({ projects }: { projects: readonly ZaicodeHomeProjectInput[] }) {
  return (
    <>
      {projects.map((project) => (
        <ProjectProbe key={project.key} project={project} />
      ))}
    </>
  );
}

const STATE_ORDER: Record<ZaicodeProjectRuntimeState, number> = { blocked: 0, waiting: 1, working: 2, pending: 3, done: 4, idle: 5 };

export function sortZaicodeHomeProjects(rows: readonly ZaicodeHomeProjectRow[]): ZaicodeHomeProjectRow[] {
  return [...rows].sort(
    (left, right) =>
      Number(left.disabled) - Number(right.disabled) ||
      STATE_ORDER[left.state] - STATE_ORDER[right.state] ||
      left.name.localeCompare(right.name),
  );
}

export function ZaicodeHomeFleet({
  rows,
  onGoToProject,
  onOpenSession,
}: {
  rows: readonly ZaicodeHomeProjectRow[];
  onGoToProject: (row: ZaicodeHomeProjectRow) => void;
  onOpenSession: (row: ZaicodeHomeProjectRow, sessionId: string) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const sorted = sortZaicodeHomeProjects(rows);
  const counts = sorted.reduce<Record<string, number>>((acc, row) => ({ ...acc, [row.state]: (acc[row.state] ?? 0) + 1 }), {});
  const summary = ["working", "waiting", "blocked", "pending"]
    .filter((state) => counts[state])
    .map((state) => `${counts[state]} ${state}`)
    .join(" · ");
  return (
    <ZaicodeHomeCard title="Projects" widget="fleet" right={summary || `${sorted.length} project(s)`}>
      {sorted.length === 0 ? (
        <span className="text-foreground-subtle">No project open yet: add one from the sidebar (Open folder).</span>
      ) : (
        <div className="flex max-h-[360px] flex-col overflow-y-auto" role="list">
          {sorted.map((row) => {
            const open = selected === row.key;
            return (
              <div key={row.key} role="listitem" className={cn("border-b border-border/50 last:border-b-0", row.disabled && "opacity-50")}>
                <button
                  type="button"
                  className={cn("grid w-full grid-cols-[4px_minmax(80px,1fr)_46px_minmax(0,2fr)_auto] items-center gap-1.5 px-0.5 py-0.5 text-left hover:bg-hover", open && "bg-selected")}
                  aria-expanded={open}
                  title={`${row.path}\n${row.reason}`}
                  onClick={() => setSelected(open ? null : row.key)}
                  data-zaicode-home-project={row.state}
                >
                  <span className="h-4" style={{ background: row.color ?? "var(--color-border)" }} aria-hidden />
                  <span className="truncate text-foreground">{row.name}</span>
                  <span className="truncate text-foreground-subtlest">{row.slot}</span>
                  <span className="truncate text-foreground-subtle">
                    {row.disabled ? "OFF · switched off" : row.blocker ? `BLOCKED: ${row.blocker}` : [row.task, row.phase].filter(Boolean).join(" ") || row.label}
                  </span>
                  <span className="shrink-0 tabular-nums text-foreground-subtle">
                    {row.sessionsRunning + row.workersRunning > 0 ? `${row.sessionsRunning + row.workersRunning}▸` : ""}
                    {row.sessionsWaiting > 0 ? ` ?${row.sessionsWaiting}` : ""}
                  </span>
                </button>
                {open ? (
                  <div className="flex flex-col gap-1 bg-background px-2 py-1">
                    <span className="text-foreground-subtle">
                      {row.label} — {row.reason}
                    </span>
                    {row.nextAction ? <span className="truncate text-foreground-subtlest">Next: {row.nextAction}</span> : null}
                    {row.owner ? <span className="text-foreground-subtlest">Owner: {row.owner}</span> : null}
                    {row.lastAction ? (
                      <span className="truncate text-foreground-subtlest" title={row.lastAction}>
                        Last: {row.lastActionTime ? `${row.lastActionTime} ` : ""}
                        {row.lastAction}
                      </span>
                    ) : null}
                    {!row.hasSaipen ? <span className="text-foreground-subtlest">No SAIPEN memory in this project.</span> : null}
                    <div className="flex flex-wrap gap-1">
                      <button type="button" className="border border-border bg-card px-1.5 hover:bg-hover" onClick={() => onGoToProject(row)}>
                        Go to project
                      </button>
                      {row.mainSessionId ? (
                        <button type="button" className="border border-border bg-card px-1.5 hover:bg-hover" onClick={() => onOpenSession(row, row.mainSessionId!)}>
                          Open MAIN session
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </ZaicodeHomeCard>
  );
}

export function ZaicodeHomeAgents({
  sessions,
  waiting,
  workers,
  jobs,
  now,
}: {
  sessions: readonly ZaicodeRunningSession[];
  waiting: readonly ZaicodeSessionRef[];
  workers: readonly ZaicodeWorker[];
  jobs: readonly ZaicodeJob[] | null;
  now: number;
}) {
  const runningWorkers = workers.filter((worker) => worker.exitCode === null && worker.kind === "worker");
  const runningJobs = (jobs ?? []).filter((job) => job.status === "running");
  const blockedJobs = (jobs ?? []).filter((job) => job.status === "blocked").length;
  const readyJobs = (jobs ?? []).filter((job) => job.status === "queued" || job.status === "ready").length;
  const recent = (jobs ?? []).filter((job) => job.status === "completed" && job.finishedAt !== undefined && now - job.finishedAt < 86_400_000).length;
  const summary = [
    `${sessions.length + runningWorkers.length + runningJobs.length} running`,
    waiting.length ? `${waiting.length} waiting` : "",
    readyJobs ? `${readyJobs} queued` : "",
    blockedJobs ? `${blockedJobs} blocked` : "",
    recent ? `${recent} done 24h` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const empty = sessions.length + runningWorkers.length + runningJobs.length + waiting.length === 0;
  return (
    <ZaicodeHomeCard title="Agents" widget="agents" right={summary} onOpen={() => void openZaicodeWorkspaceView()} openLabel="Open the ZAICODE workspace">
      {empty ? (
        <span className="text-foreground-subtle">Nothing runs right now.</span>
      ) : (
        <ul className="flex max-h-[260px] flex-col gap-0.5 overflow-y-auto">
          {waiting.map((session) => (
            <li key={`w-${session.sessionId}`}>
              <button type="button" className="flex w-full min-w-0 gap-2 text-left hover:bg-hover" onClick={() => void openZaicodeSession(session)}>
                <span className="shrink-0 text-destructive">?</span>
                <span className="min-w-0 flex-1 truncate text-foreground">{session.title || "session"}</span>
                <span className="shrink-0 text-foreground-subtlest">waits for you</span>
              </button>
            </li>
          ))}
          {sessions.map((session) => (
            <li key={`s-${session.sessionId}`}>
              <button
                type="button"
                className="flex w-full min-w-0 gap-2 text-left hover:bg-hover"
                onClick={() => void openZaicodeSession({ sessionId: session.sessionId, title: session.title, ...(session.workspacePath ? { workspacePath: session.workspacePath } : {}), ...(session.workspaceIdentity ? { workspaceIdentity: session.workspaceIdentity } : {}) })}
              >
                <span className="shrink-0 text-[var(--zaicode-highlight,var(--color-warning))]">▸</span>
                <span className="min-w-0 flex-1 truncate text-foreground">{session.title || "session"}</span>
                <span className="shrink-0 tabular-nums text-foreground-subtlest">{Math.round(session.ratio * 100)}%</span>
              </button>
            </li>
          ))}
          {runningWorkers.map((worker) => (
            <li key={`k-${worker.id}`}>
              <button type="button" className="flex w-full min-w-0 gap-2 text-left hover:bg-hover" onClick={() => focusZaicodeWorker(worker.id)}>
                <span className="shrink-0 text-foreground-subtle">▣</span>
                <span className="min-w-0 flex-1 truncate text-foreground">{zaicodeWorkerTitle(worker)}</span>
                <span className="shrink-0 tabular-nums text-foreground-subtlest">{formatZaicodeDuration(now - worker.startedAt)}</span>
              </button>
            </li>
          ))}
          {runningJobs.map((job) => (
            <li key={`j-${job.id}`}>
              <button type="button" className="flex w-full min-w-0 gap-2 text-left hover:bg-hover" onClick={() => void openZaicodeWorkspaceView()}>
                <span className="shrink-0 text-foreground-subtle">⚙</span>
                <span className="min-w-0 flex-1 truncate text-foreground">{job.title || "queue run"}</span>
                <span className="shrink-0 tabular-nums text-foreground-subtlest">{job.startedAt ? formatZaicodeRuntime(now - job.startedAt) : ""}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </ZaicodeHomeCard>
  );
}

export function ZaicodeHomeSaipen({ rows }: { rows: readonly ZaicodeHomeProjectRow[] }) {
  const withSaipen = rows.filter((row) => row.hasSaipen && !row.disabled);
  if (withSaipen.length === 0) return null;
  const count = (state: ZaicodeProjectRuntimeState) => withSaipen.filter((row) => row.state === state).length;
  const blocked = withSaipen.filter((row) => row.state === "blocked");
  const projected = withSaipen.filter((row) => row.projectedAt !== null).length;
  return (
    <ZaicodeHomeCard title="SAIPEN" widget="saipen" right={`${withSaipen.length} project(s) · ${projected} projected`}>
      <span className="text-foreground-subtle">
        {count("working")} working · {count("pending")} ready · {count("waiting")} waiting · {count("blocked")} blocked · {count("done")} done
      </span>
      {blocked.slice(0, 3).map((row) => (
        <span key={row.key} className="truncate text-destructive" title={row.reason}>
          {row.name}: {row.blocker ?? row.reason}
        </span>
      ))}
    </ZaicodeHomeCard>
  );
}

export function zaicodeHomeProjectForPath(rows: readonly ZaicodeHomeProjectRow[], path: string): ZaicodeHomeProjectRow | undefined {
  return rows.find((row) => sameZaicodeProjectPath(row.path, path));
}
