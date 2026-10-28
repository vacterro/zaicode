import { create } from "zustand";
import type { ZaicodeRunningSession } from "./zaicodeSidebarPrefs.js";
import { playZaicodeSound } from "./zaicodeSoundBus.js";
import type { ZaicodeDispatchProject } from "./zaicodeDispatch.js";

/**
 * Session navigation from anywhere: the header meter (click a worker cell ->
 * its session) and "Focus next session" (click = next, right-click = back,
 * round the ring). The sidebar publishes how to open a task, the active one,
 * the sessions waiting for the operator and the active project's recent ones.
 */

export interface ZaicodeSessionRef {
  sessionId: string;
  title: string;
  workspacePath?: string;
  workspaceIdentity?: string;
}

type OpenTask = (workspacePath: string, taskId: string, workspaceIdentity?: string) => void;

interface ZaicodeSessionNavState {
  open: OpenTask | null;
  activeTaskId: string | null;
  activeWorkspacePath: string | null;
  waiting: ZaicodeSessionRef[];
  recent: ZaicodeSessionRef[];
  /** Openers of the sidebar's projects in visible order (F-keys "projects" mode). */
  projects: (() => void)[];
  /** The sidebar's projects (path + name) in visible order, for Dispatch. */
  projectList: ZaicodeDispatchProject[];
  publish: (patch: Partial<Omit<ZaicodeSessionNavState, "publish">>) => void;
}

function sameRefs(left: readonly ZaicodeSessionRef[], right: readonly ZaicodeSessionRef[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (session, index) =>
        session.sessionId === right[index]!.sessionId &&
        session.title === right[index]!.title &&
        session.workspacePath === right[index]!.workspacePath &&
        session.workspaceIdentity === right[index]!.workspaceIdentity,
    )
  );
}

function sameProjects(left: readonly ZaicodeDispatchProject[], right: readonly ZaicodeDispatchProject[]): boolean {
  return (
    left.length === right.length &&
    left.every((project, index) => project.path === right[index]!.path && project.name === right[index]!.name && project.identity === right[index]!.identity)
  );
}

export const useZaicodeSessionNav = create<ZaicodeSessionNavState>((set, get) => ({
  open: null,
  activeTaskId: null,
  activeWorkspacePath: null,
  waiting: [],
  recent: [],
  projects: [],
  projectList: [],
  // The sidebar republishes on every task-list push; unchanged lists keep their identity so
  // subscribers (every project row, the header meter) do not re-render for nothing (SRC-043).
  publish: (patch) => {
    const current = get();
    const next = { ...patch };
    if (next.waiting && sameRefs(current.waiting, next.waiting)) delete next.waiting;
    if (next.recent && sameRefs(current.recent, next.recent)) delete next.recent;
    if (next.projectList && sameProjects(current.projectList, next.projectList)) delete next.projectList;
    set(next);
  },
}));

/**
 * The cycle ring: sessions waiting for you first (they are stuck on you), then
 * the working ones; when nothing works or waits, the active project's recent
 * sessions. Duplicates keep their first place.
 */
export function zaicodeSessionRing(
  running: readonly ZaicodeSessionRef[],
  waiting: readonly ZaicodeSessionRef[],
  recent: readonly ZaicodeSessionRef[],
): ZaicodeSessionRef[] {
  const live = [...waiting, ...running];
  const source = live.length > 0 ? live : recent;
  const seen = new Set<string>();
  return source.filter((session) => {
    if (seen.has(session.sessionId)) return false;
    seen.add(session.sessionId);
    return true;
  });
}

/** Next entry of the ring after `activeId` in `direction`; from outside the ring: first (or last). */
export function nextZaicodeRingSession<T extends { sessionId: string }>(
  ring: readonly T[],
  activeId: string | null,
  direction: 1 | -1,
): T | null {
  if (ring.length === 0) return null;
  const index = activeId ? ring.findIndex((session) => session.sessionId === activeId) : -1;
  if (index < 0) return direction > 0 ? ring[0]! : ring[ring.length - 1]!;
  return ring[(index + direction + ring.length) % ring.length]!;
}

/** Opens one session; false when it cannot be located. */
export function openZaicodeSession(session: ZaicodeSessionRef): boolean {
  const nav = useZaicodeSessionNav.getState();
  const path = session.workspacePath ?? nav.activeWorkspacePath;
  if (!nav.open || !path) return false;
  nav.open(path, session.sessionId, session.workspaceIdentity);
  playZaicodeSound("session.open");
  return true;
}

/** Click = next, right-click = previous. Returns the session it moved to. */
export function cycleZaicodeSession(
  direction: 1 | -1,
  running: readonly ZaicodeRunningSession[],
): ZaicodeSessionRef | null {
  const nav = useZaicodeSessionNav.getState();
  const ring = zaicodeSessionRing(running, nav.waiting, nav.recent);
  const next = nextZaicodeRingSession(ring, nav.activeTaskId, direction);
  if (!next) return null;
  return openZaicodeSession(next) ? next : null;
}
