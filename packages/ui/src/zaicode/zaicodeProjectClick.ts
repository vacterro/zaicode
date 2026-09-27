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
 * Now a click is always one of two things:
 * - go to the project: its MAIN session when the row is a session, otherwise
 *   the new-task screen there;
 * - already there: fold / unfold the row's sessions. Never a navigation.
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
}

/**
 * MAIN counts when the list has it. A list that is still empty (a cold
 * project) cannot say it is gone, so the remembered id is trusted then.
 */
export function zaicodeMainIsValid(mainId: string | null, sessionIds: readonly string[]): mainId is string {
  return Boolean(mainId) && (sessionIds.length === 0 || sessionIds.includes(mainId!));
}

export function decideZaicodeProjectClick(input: ZaicodeProjectClickInput): ZaicodeProjectClick {
  const rowIsSession = input.projectIsMain && zaicodeMainIsValid(input.mainId, input.sessionIds);
  if (rowIsSession) {
    const mainOpen = input.activeWorkspace && input.activeTaskId === input.mainId;
    return mainOpen ? { action: "fold" } : { action: "open", sessionId: input.mainId! };
  }
  // A folder row: the first click goes to the project (the new-task screen, an earlier
  // operator request); once there, clicks only fold and unfold.
  return input.activeWorkspace ? { action: "fold" } : { action: "draft" };
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
