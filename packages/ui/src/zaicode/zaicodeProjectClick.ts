/**
 * What a click on a project row in the sidebar does (SRC-062).
 *
 * The operator: "click a project that has a session: the first click opens a
 * session, fine; the second opens some random session with a strange
 * history; the third finally starts a new one -- it is all mixed up". Two
 * paths made that:
 *
 * - The "project = MAIN" row opened the remembered MAIN id without checking
 *   it still exists. A MAIN that was archived or replaced left a stale id, and
 *   the row opened that old session.
 * - With MAIN already open, the click fell through to upstream's Collapsible
 *   logic, which starts a new-task draft when the row is folded and folds it
 *   when it is not, so repeated clicks walked MAIN -> draft -> fold.
 *
 * SRC-129 separates navigation from folding. The project label always opens
 * MAIN or a meaningful existing session; only the separate chevron folds.
 * Empty MAIN sessions are excluded, and an empty project opens a draft.
 *
 * And the row's diamond is a real switch (`decideZaicodeMainToggle`): on, the
 * project row IS a session (MAIN) and every other session is its child; off,
 * the row is a folder again and that session is listed with the others.
 */

export type ZaicodeProjectClick =
  | { action: "open"; sessionId: string }
  | { action: "fold" }
  | { action: "draft" };

export interface ZaicodeProjectClickInput {
  /** The sidebar shows "project = MAIN" rows (the ◆ view). */
  projectIsMain: boolean;
  mainId: string | null;
  /** The project's listed sessions; empty while a cold project is still loading. */
  sessionIds: readonly string[];
  /** This project is the active one. */
  activeWorkspace: boolean;
  /** The open session (any project), or null on the new-task screen / elsewhere. */
  activeTaskId: string | null;
  /**
   * MAIN is an empty chat: it never said anything and nothing runs in it. Opening it shows a
   * window with no content ("what are these incompletes?", SRC-081); the new-task screen is
   * what the operator wants there.
   */
  mainEmpty?: boolean;
  /** Sessions with readable content or live work, ordered by recency. */
  readableSessionIds?: readonly string[];
}

/**
 * MAIN counts when the list has it. A list that is still empty (a cold
 * project) cannot say it is gone, so the remembered id is trusted then.
 */
export function zaicodeMainIsValid(mainId: string | null, sessionIds: readonly string[]): mainId is string {
  return Boolean(mainId) && (sessionIds.length === 0 || sessionIds.includes(mainId!));
}

export function decideZaicodeProjectClick(input: ZaicodeProjectClickInput): ZaicodeProjectClick {
  // 项目标题只导航；折叠属于独立箭头，重复点击不能跳进空草稿。
  if (!input.mainEmpty && zaicodeMainIsValid(input.mainId, input.sessionIds)) {
    return { action: "open", sessionId: input.mainId };
  }
  const readableIds = (input.readableSessionIds ?? input.sessionIds).filter((id) => !input.mainEmpty || id !== input.mainId);
  if (input.activeWorkspace && input.activeTaskId && readableIds.includes(input.activeTaskId)) {
    return { action: "open", sessionId: input.activeTaskId };
  }
  const sessionId = readableIds[0];
  return sessionId ? { action: "open", sessionId } : { action: "draft" };
}

export type ZaicodeMainToggle =
  | { action: "unset"; sessionId: string }
  | { action: "set"; sessionId: string }
  | { action: "arm" };

/**
 * The row's diamond. On -> off: MAIN goes back to being an ordinary session.
 * Off -> on: the session open in this project becomes the row; otherwise the
 * one worked on last; a project with no session at all arms its next one.
 */
export function decideZaicodeMainToggle(input: {
  mainId: string | null;
  sessions: readonly { taskId: string; updatedAt?: number | null }[];
  activeWorkspace: boolean;
  activeTaskId: string | null;
}): ZaicodeMainToggle {
  const ids = input.sessions.map((session) => session.taskId);
  if (zaicodeMainIsValid(input.mainId, ids)) return { action: "unset", sessionId: input.mainId };
  if (input.activeWorkspace && input.activeTaskId && ids.includes(input.activeTaskId)) {
    return { action: "set", sessionId: input.activeTaskId };
  }
  let newest: { taskId: string; updatedAt?: number | null } | null = null;
  for (const session of input.sessions) {
    if (!newest || (session.updatedAt ?? 0) > (newest.updatedAt ?? 0)) newest = session;
  }
  return newest ? { action: "set", sessionId: newest.taskId } : { action: "arm" };
}
