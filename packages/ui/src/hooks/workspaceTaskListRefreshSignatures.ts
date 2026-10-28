import type { ZCodeTaskMeta } from "@zcode/shared";

type WorkspaceTaskListVersionEntry = readonly [workspaceKey: string, version: number];

interface WorkspaceRemoteSessionSignatureEntry {
  workspaceKey: string;
  remoteSessionId?: string;
  ready: boolean;
}

function sortByWorkspaceKey<T extends { workspaceKey: string }>(entries: ReadonlyArray<T>): T[] {
  return [...entries].sort((left, right) => left.workspaceKey.localeCompare(right.workspaceKey));
}

export function buildWorkspaceTaskListVersionSignature(
  entries: ReadonlyArray<WorkspaceTaskListVersionEntry>,
): string {
  return JSON.stringify([...entries].sort(([left], [right]) => left.localeCompare(right)));
}

export function buildWorkspaceRemoteSessionSignature(
  entries: ReadonlyArray<WorkspaceRemoteSessionSignatureEntry>,
): string {
  return sortByWorkspaceKey(entries)
    .map((entry) => `${entry.workspaceKey}:${entry.remoteSessionId ?? "base"}:${entry.ready}`)
    .join("|");
}

export function areTaskListItemsEquivalent(left: ZCodeTaskMeta[], right: ZCodeTaskMeta[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((leftTask, index) => {
    const rightTask = right[index];
    return Boolean(
      rightTask &&
      leftTask.taskId === rightTask.taskId &&
      leftTask.title === rightTask.title &&
      leftTask.updatedAt === rightTask.updatedAt &&
      leftTask.createdAt === rightTask.createdAt &&
      leftTask.status === rightTask.status &&
      leftTask.unreadAt === rightTask.unreadAt &&
      leftTask.provider === rightTask.provider &&
      leftTask.model === rightTask.model,
    );
  });
}

interface PendingWorkspaceTaskQuery {
  workspaceKey: string;
  queryKey: string;
}

/**
 * Which workspace task lists to refresh in the next round.
 *
 * Cold start loads the active workspace first, so its model state is not competing with every
 * historical workspace. Once the active workspace has a list, a stale active list refreshes
 * together with the others: while a session runs in the active project its list turns stale on
 * every activity change, and "active first" then starved every other project -- their working
 * badge appeared only after switching to them (T-136 / SRC-100).
 */
export function selectPendingWorkspaceTaskQueries<T extends PendingWorkspaceTaskQuery>(
  queryConfigs: ReadonlyArray<T>,
  resultsByQueryKey: Readonly<Record<string, { stale?: boolean } | null | undefined>>,
  activeWorkspaceKey: string,
): T[] {
  const pending = queryConfigs.filter((config) => {
    const cachedResult = resultsByQueryKey[config.queryKey];
    return cachedResult == null || cachedResult.stale === true;
  });
  const activeColdStart = pending.filter(
    (config) =>
      config.workspaceKey === activeWorkspaceKey && resultsByQueryKey[config.queryKey] == null,
  );
  return activeColdStart.length > 0 ? activeColdStart : pending;
}
