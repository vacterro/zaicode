import { useSyncExternalStore } from "react";
import { createUuid, isZaicodeMetricsOnlyAccount, type ZaicodeEngineAccount } from "@zcode/shared";
import {
  buildZaicodeWorkerCommand,
  getZaicodeEnginesBridge,
  projectNameOf,
  readZaicodeEnginesState,
  resolveZaicodeWorkerLinePrompt,
} from "./zaicodeEngines.js";
import { cascadeZaicodeWindowRect, type ZaicodeRect } from "./zaicodeWorkerLayout.js";
import {
  commitZaicodeWorkerRecords,
  exitZaicodeWorkerRecord,
  newZaicodeWorkerIdentity,
  placeZaicodeWorkerRecord,
  readZaicodeWorkerRecords,
  zaicodeWorkerRecord,
  type ZaicodeNewWorker,
  type ZaicodeWorker,
  type ZaicodeWorkerWindowState,
} from "./zaicodeWorkerRecords.js";
import { readZaicodeWorkerPrefs, type ZaicodeWorkerPlacement } from "./zaicodeWorkerPrefs.js";
import { notifyZaicode } from "./zaicodeNotifications.js";
import { playZaicodeSound } from "./zaicodeSoundBus.js";

/**
 * ZAICODE workers: every subscription CLI (and every one-click fix) runs as a
 * terminal inside ZAICODE. A worker lives in exactly one place: the bottom
 * WORKERS panel (docked like a normal terminal, tabs or an even split) or its
 * own window (snappable, movable, resizable); either can be minimized to a
 * chip named after its engine and project. Each worker's xterm + PTY lives in
 * the persistent terminal registry, so moving, hiding or minimizing a worker
 * never stops it.
 *
 * Topology vs layout (T-42): a worker is two records. Its identity (who and
 * what runs: engine, project, command, generation, exit) is frozen and changes
 * only when its process reports an exit. Its place (panel or window,
 * minimized, geometry, stacking, panel order) is written only through
 * `placeZaicodeWorkerRecord`, which refuses any identity key. Readers get both merged
 * (records: `zaicodeWorkerRecords.ts`).
 */

export {
  ZAICODE_WORKER_PLACE_KEYS,
  readZaicodeWorkerIdentities,
  type ZaicodeWorker,
  type ZaicodeWorkerIdentity,
  type ZaicodeWorkerPlace,
  type ZaicodeWorkerWindowState,
} from "./zaicodeWorkerRecords.js";

export interface ZaicodeWorkersState {
  workers: ZaicodeWorker[];
  /** Panel: the worker shown in Tabs, the focused pane in Split. */
  activeId: string | null;
  /** The bottom WORKERS panel is shown. */
  open: boolean;
  panelMaximized: boolean;
  /** Split: one pane fills the panel until released. */
  soloId: string | null;
  /** The worker that had focus last (panel or window): hotkeys act on it. */
  focusedId: string | null;
}

let workersState: ZaicodeWorkersState = {
  workers: [],
  activeId: null,
  open: false,
  panelMaximized: false,
  soloId: null,
  focusedId: null,
};
const listeners = new Set<() => void>();
let topZ = 1;

function set(next: Partial<ZaicodeWorkersState>): void {
  workersState = { ...workersState, ...next };
  for (const listener of listeners) listener();
}

function findWorker(id: string): ZaicodeWorker | undefined {
  return workersState.workers.find((worker) => worker.id === id);
}

export function readZaicodeWorkers(): ZaicodeWorkersState {
  return workersState;
}

function subscribeWorkers(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Every change of the workers store (crash recovery records the running ones). */
export const subscribeZaicodeWorkers = subscribeWorkers;

export function useZaicodeWorkers(): ZaicodeWorkersState {
  return useSyncExternalStore(subscribeWorkers, readZaicodeWorkers, readZaicodeWorkers);
}

/**
 * One primitive fact (a count, a joined signature) read from the workers store.
 * A sidebar row reads only its own number, so dragging a worker window or
 * focusing another pane no longer re-renders every project row (SRC-043 lag).
 */
export function useZaicodeWorkersSelector<T extends string | number | boolean | null>(
  select: (state: ZaicodeWorkersState) => T,
): T {
  const read = () => select(workersState);
  return useSyncExternalStore(subscribeWorkers, read, read);
}

/** Live CLI workers (not shells / fixes) running in `projectPath`. */
export function zaicodeProjectWorkers(state: ZaicodeWorkersState, projectPath: string): ZaicodeWorker[] {
  const path = projectPath.toLowerCase();
  return state.workers.filter(
    (worker) => worker.kind === "worker" && worker.exitCode === null && worker.projectPath.toLowerCase() === path,
  );
}

/** "AG · _FastPrompter" — what a chip, a tab and a window title say. */
export function zaicodeWorkerTitle(worker: Pick<ZaicodeWorker, "short" | "projectName">): string {
  return `${worker.short} · ${worker.projectName}`;
}

/** Workers shown in the panel body, in panel order. */
export function zaicodePanelWorkers(state: ZaicodeWorkersState = workersState): ZaicodeWorker[] {
  return state.workers.filter((worker) => worker.placement === "panel" && !worker.minimized);
}

/** Workers in their own (not minimized) windows. */
export function zaicodeWindowWorkers(state: ZaicodeWorkersState = workersState): ZaicodeWorker[] {
  return state.workers.filter((worker) => worker.placement === "window" && !worker.minimized);
}

/** Chips of the tray: minimized workers, plus the panel's workers while the panel is hidden. */
export function zaicodeTrayWorkers(
  state: ZaicodeWorkersState = workersState,
  showHiddenPanel: boolean = readZaicodeWorkerPrefs().trayShowsHiddenPanel,
): ZaicodeWorker[] {
  return state.workers.filter(
    (worker) => worker.minimized || (worker.placement === "panel" && !state.open && showHiddenPanel),
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function openZaicodeWorkersPanel(activeId?: string): void {
  set({ open: true, ...(activeId ? { activeId, focusedId: activeId } : {}) });
}

export function hideZaicodeWorkersPanel(): void {
  set({ open: false, panelMaximized: false });
}

export function toggleZaicodeWorkersPanel(): void {
  if (workersState.open) hideZaicodeWorkersPanel();
  else openZaicodeWorkersPanel();
}

export function setZaicodeWorkersPanelMaximized(panelMaximized: boolean): void {
  set({ panelMaximized, open: true });
}

export function soloZaicodeWorker(id: string | null): void {
  set({ soloId: id, ...(id ? { activeId: id, focusedId: id } : {}) });
}

/** Moves worker `id` to position `to` among all workers (the panel follows this order). */
export function moveZaicodeWorker(id: string, to: number): void {
  const records = readZaicodeWorkerRecords();
  const index = records.findIndex((entry) => entry.identity.id === id);
  if (index < 0) return;
  const next = [...records];
  const [entry] = next.splice(index, 1);
  next.splice(Math.max(0, Math.min(next.length, to)), 0, entry!);
  set({ workers: commitZaicodeWorkerRecords(next) });
}

// Compatibility names used by the header, the menu and hotkeys since T-34.
export const openZaicodeWorkersDock = (activeId?: string): void =>
  activeId ? focusZaicodeWorker(activeId) : openZaicodeWorkersPanel();
export const toggleZaicodeWorkersDock = toggleZaicodeWorkersPanel;
export const minimizeZaicodeWorkersDock = hideZaicodeWorkersPanel;
export const closeZaicodeWorkersDock = hideZaicodeWorkersPanel;

// ---------------------------------------------------------------------------
// One worker
// ---------------------------------------------------------------------------

function windowBounds(): ZaicodeRect {
  const width = typeof window === "undefined" ? 1280 : window.innerWidth;
  const height = typeof window === "undefined" ? 800 : window.innerHeight;
  return { x: 8, y: 56, width: Math.max(360, width - 16), height: Math.max(180, height - 64) };
}

/** Shows worker `id` wherever it lives (restores a chip, opens the panel, raises a window). */
export function focusZaicodeWorker(id: string): void {
  const worker = findWorker(id);
  if (!worker) return;
  if (worker.placement === "panel") {
    set({
      workers: placeZaicodeWorkerRecord(id, { minimized: false }),
      open: true,
      activeId: id,
      focusedId: id,
      soloId: workersState.soloId && workersState.soloId !== id ? id : workersState.soloId,
    });
    return;
  }
  topZ += 1;
  set({ workers: placeZaicodeWorkerRecord(id, { minimized: false, z: topZ }), focusedId: id });
}
export const activateZaicodeWorker = focusZaicodeWorker;

export function raiseZaicodeWorker(id: string): void {
  const worker = findWorker(id);
  if (!worker) return;
  if (workersState.focusedId === id && (worker.placement === "window" ? worker.z === topZ : workersState.activeId === id)) return;
  topZ += 1;
  set({
    workers: worker.placement === "window" ? placeZaicodeWorkerRecord(id, { z: topZ }) : workersState.workers,
    focusedId: id,
    ...(worker.placement === "panel" ? { activeId: id } : {}),
  });
}

export function minimizeZaicodeWorker(id: string): void {
  const worker = findWorker(id);
  if (!worker) return;
  const panel = zaicodePanelWorkers().filter((item) => item.id !== id);
  set({
    workers: placeZaicodeWorkerRecord(id, { minimized: true }),
    ...(workersState.activeId === id ? { activeId: panel[0]?.id ?? null } : {}),
    ...(workersState.soloId === id ? { soloId: null } : {}),
  });
}

/** Puts worker `id` into the bottom panel and shows it there. */
export function dockZaicodeWorker(id: string): void {
  const worker = findWorker(id);
  if (!worker) return;
  set({
    workers: placeZaicodeWorkerRecord(id, { placement: "panel", minimized: false }),
    open: true,
    activeId: id,
    focusedId: id,
  });
}

/** Gives worker `id` its own window (its last one, or a new cascaded one). */
export function floatZaicodeWorker(id: string, rect?: ZaicodeRect): void {
  const worker = findWorker(id);
  if (!worker) return;
  topZ += 1;
  const windowState: ZaicodeWorkerWindowState = rect
    ? { ...rect, maximized: false }
    : (worker.window ?? { ...cascadeZaicodeWindowRect(windowBounds(), zaicodeWindowWorkers().length), maximized: false });
  const panel = zaicodePanelWorkers().filter((item) => item.id !== id);
  set({
    workers: placeZaicodeWorkerRecord(id, { placement: "window", minimized: false, window: windowState, z: topZ }),
    focusedId: id,
    ...(workersState.activeId === id ? { activeId: panel[0]?.id ?? null } : {}),
    ...(workersState.soloId === id ? { soloId: null } : {}),
  });
}

export function setZaicodeWorkerWindow(id: string, windowState: ZaicodeWorkerWindowState): void {
  set({ workers: placeZaicodeWorkerRecord(id, { window: windowState }) });
}

/** Next / previous worker overall (panel order, then windows); restores it. */
export function cycleZaicodeWorker(direction: 1 | -1): void {
  const list = workersState.workers;
  if (list.length === 0) return;
  const index = list.findIndex((worker) => worker.id === workersState.focusedId);
  const next = list[(index + direction + list.length) % list.length] ?? list[0]!;
  focusZaicodeWorker(next.id);
}

export function markZaicodeWorkerExited(id: string, exitCode: number): void {
  const worker = findWorker(id);
  set({ workers: exitZaicodeWorkerRecord(id, exitCode, Date.now()) });
  playZaicodeSound(exitCode === 0 ? "worker.exit" : "worker.fail");
  if (!worker) return;
  notifyZaicode(exitCode === 0 ? "worker.exit" : "worker.fail", {
    header: "Workers",
    title: `${zaicodeWorkerTitle(worker)} ${exitCode === 0 ? "finished" : `exited with ${exitCode}`}`,
    body: worker.label,
    status: exitCode === 0 ? "Finished" : "Crashed",
    key: `worker:${id}`,
    actions: [{ label: "Show", run: () => focusZaicodeWorker(id) }],
  });
}

/** Removes the worker; its PTY is killed through the registry (onZaicodeWorkerRemoved). */
export function removeZaicodeWorker(id: string): void {
  const records = readZaicodeWorkerRecords();
  const index = records.findIndex((entry) => entry.identity.id === id);
  const workers = commitZaicodeWorkerRecords(records.filter((entry) => entry.identity.id !== id));
  const panel = workers.filter((worker) => worker.placement === "panel" && !worker.minimized);
  const fallback = panel[Math.max(0, Math.min(panel.length - 1, index - 1))] ?? panel[0] ?? null;
  set({
    workers,
    activeId: workersState.activeId === id ? (fallback?.id ?? null) : workersState.activeId,
    focusedId: workersState.focusedId === id ? (fallback?.id ?? null) : workersState.focusedId,
    soloId: workersState.soloId === id ? null : workersState.soloId,
  });
  for (const listener of removalListeners) listener(id);
}

const removalListeners = new Set<(id: string) => void>();

export function onZaicodeWorkerRemoved(listener: (id: string) => void): () => void {
  removalListeners.add(listener);
  return () => removalListeners.delete(listener);
}


function addWorker(fields: ZaicodeNewWorker, placement?: ZaicodeWorkerPlacement, generation?: number): ZaicodeWorker {
  const prefs = readZaicodeWorkerPrefs();
  const where = placement ?? prefs.defaultPlacement;
  topZ += 1;
  const entry = zaicodeWorkerRecord(newZaicodeWorkerIdentity(fields, generation), {
    placement: where,
    minimized: false,
    window:
      where === "window"
        ? { ...cascadeZaicodeWindowRect(windowBounds(), zaicodeWindowWorkers().length), maximized: false }
        : null,
    z: topZ,
  });
  const worker = entry.view;
  set({
    workers: commitZaicodeWorkerRecords([...readZaicodeWorkerRecords(), entry]),
    focusedId: worker.id,
    ...(where === "panel"
      ? { activeId: worker.id, open: workersState.open || prefs.openPanelOnLaunch, soloId: null }
      : {}),
  });
  return worker;
}

export function runningZaicodeWorkers(projectPath?: string): ZaicodeWorker[] {
  return workersState.workers.filter(
    (worker) =>
      worker.exitCode === null &&
      worker.kind === "worker" &&
      (!projectPath || worker.projectPath.toLowerCase() === projectPath.toLowerCase()),
  );
}

export interface ZaicodeWorkerLaunchResult {
  ok: boolean;
  message: string;
  worker?: ZaicodeWorker;
}

/**
 * Starts `account` as a worker in `projectPath`. `where: "external"` opens a
 * separate PowerShell window instead (survives a ZAICODE restart); "dock" and
 * "window" pick the in-app place, otherwise the Workers setting decides.
 */
export async function launchZaicodeWorker(params: {
  account: ZaicodeEngineAccount;
  projectPath: string;
  prompt?: string;
  where?: "dock" | "window" | "external";
  /** Restart of a worker a crash cut off: its generation (default: counted in this run). */
  generation?: number;
}): Promise<ZaicodeWorkerLaunchResult> {
  const { account, projectPath } = params;
  if (isZaicodeMetricsOnlyAccount(account)) {
    return { ok: false, message: `${account.label} is shown for its limits only; it does not run workers.` };
  }
  if (account.status === "cli-missing") return { ok: false, message: account.statusDetail };
  const config = readZaicodeEnginesState().config;
  const prompt = params.prompt ?? config.workerPrompt;
  const linePrompt = await resolveZaicodeWorkerLinePrompt(prompt);
  const command = buildZaicodeWorkerCommand(account, projectPath, { prompt: linePrompt, yolo: config.workerYolo });
  if (!command) return { ok: false, message: `${account.label} has no launchable CLI.` };
  const projectName = projectNameOf(projectPath);
  if (params.where === "external") {
    const bridge = getZaicodeEnginesBridge();
    if (!bridge?.launchZaicodeExternalWorker) return { ok: false, message: "External windows need the desktop app." };
    const result = await bridge.launchZaicodeExternalWorker({
      cwd: projectPath,
      command,
      title: `${account.short} ${projectName} | ZAICODE worker`,
    });
    if (result.ok) playZaicodeSound("worker.launch");
    return result;
  }
  const worker = addWorker(
    {
      id: `zaicode-worker:${createUuid()}`,
      kind: "worker",
      accountId: account.id,
      short: account.short,
      label: account.label,
      vendor: account.vendor,
      projectPath,
      projectName,
      command,
      ...(prompt ? { prompt } : {}),
      startedAt: Date.now(),
      exitCode: null,
      endedAt: null,
    },
    params.where === "window" ? "window" : undefined,
    params.generation,
  );
  playZaicodeSound("worker.launch");
  return { ok: true, message: `${account.short} started in ${projectName}`, worker };
}

/** Runs an exact, already-shown fix command (login / install) in a worker terminal. */
export function runZaicodeFixCommand(params: {
  title: string;
  command: string;
  cwd: string;
  accountId?: string | null;
}): ZaicodeWorker {
  const worker = addWorker({
    id: `zaicode-worker:${createUuid()}`,
    kind: "fix",
    accountId: params.accountId ?? null,
    short: "FIX",
    label: params.title,
    vendor: null,
    projectPath: params.cwd,
    projectName: projectNameOf(params.cwd),
    command: params.command,
    startedAt: Date.now(),
    exitCode: null,
    endedAt: null,
  });
  playZaicodeSound("worker.fix");
  return worker;
}

/** The same command again as a new worker (same engine, project and place). */
export function duplicateZaicodeWorker(id: string): ZaicodeWorker | null {
  const worker = findWorker(id);
  if (!worker) return null;
  const copy = addWorker(
    {
      id: `zaicode-worker:${createUuid()}`,
      kind: worker.kind,
      accountId: worker.accountId,
      short: worker.short,
      label: worker.label,
      vendor: worker.vendor,
      projectPath: worker.projectPath,
      projectName: worker.projectName,
      command: worker.command,
      startedAt: Date.now(),
      exitCode: null,
      endedAt: null,
    },
    worker.placement,
  );
  playZaicodeSound("worker.launch");
  return copy;
}

/** A plain shell worker (for anything else); `launcher` = a Dispatch launcher's command line. */
export function openZaicodeShellWorker(
  cwd: string,
  placement?: ZaicodeWorkerPlacement,
  launcher?: { command: string; label: string; short: string },
): ZaicodeWorker {
  const worker = addWorker(
    {
      id: `zaicode-worker:${createUuid()}`,
      kind: "shell",
      accountId: null,
      short: launcher?.short.slice(0, 4) || "PS",
      label: launcher?.label ?? "Shell",
      vendor: null,
      projectPath: cwd,
      projectName: projectNameOf(cwd),
      command: launcher?.command ?? "",
      startedAt: Date.now(),
      exitCode: null,
      endedAt: null,
    },
    placement,
  );
  if (launcher) playZaicodeSound("worker.launch");
  return worker;
}
