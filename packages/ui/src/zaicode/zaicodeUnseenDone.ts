import { useEffect } from "react";
import { logger } from "../logger.js";
import { useZaicodeSessionBriefs, type ZaicodeSessionBrief } from "./zaicodeContinue.js";
import { zaicodeContinueHandleFor } from "./zaicodeContinueHost.js";
import { useZaicodeSessionNav } from "./zaicodeSessionNav.js";

/**
 * A run that finished while the operator looked elsewhere (SRC-131).
 *
 * The brief already carries the truth -- `unreadAt` means "finished unseen",
 * and the rows, the DONE inbox and the clear-on-visit path all read it -- but
 * nothing set it: only a hand-picked "mark as unread" did. Without a producer
 * a project that just finished looks exactly like one that has sat idle for a
 * week, which is the confusion the operator reported.
 *
 * So this is only the producer: the moment a session leaves `running` and comes
 * back finished while it is NOT the open one, its unreadAt is stamped through
 * the same service the manual action uses. Everything downstream -- the DONE
 * inbox, `zaicodeSessionStateOf`'s "done", the clear on navigation -- is the
 * existing machinery and is deliberately left alone.
 */

/** What the previous snapshot said about each session; only `running` matters. */
export type ZaicodeRunningSnapshot = ReadonlyMap<string, boolean>;

/**
 * Pure: the sessions this push finished out of sight.
 *
 * The rule is the transition, not the emptiness -- a session that was never
 * running, or one the operator is looking at right now, is not an unseen
 * completion. A crash cut, a Stop, a failure and a question are not "finished"
 * either: those have their own states and must not borrow DONE's marker.
 */
export function pickZaicodeUnseenDone(
  briefs: readonly ZaicodeSessionBrief[],
  previous: ZaicodeRunningSnapshot,
  activeSessionId: string | null,
): ZaicodeSessionBrief[] {
  const finished: ZaicodeSessionBrief[] = [];
  for (const brief of briefs) {
    if (brief.running || brief.waiting || brief.failed) continue;
    if (brief.interrupted || brief.manuallyStopped || brief.crashCut) continue;
    if (brief.unreadAt !== null) continue;
    if (brief.sessionId === activeSessionId) continue;
    if (previous.get(brief.sessionId) !== true) continue;
    finished.push(brief);
  }
  return finished;
}

/** Mount once (ZaicodeAppRuntime), beside the other brief watchers. */
export function useZaicodeUnseenDoneWatch(): void {
  useEffect(() => {
    let previous: ZaicodeRunningSnapshot = new Map();
    let seeded = false;
    const inFlight = new Set<string>();

    const sweep = () => {
      const briefs = useZaicodeSessionBriefs.getState().sessions;
      const running = new Map(briefs.map((brief) => [brief.sessionId, brief.running]));
      // The first sweep sees whatever was already running when the window
      // opened: nothing "finished" there, so nothing may be stamped.
      const before = seeded ? previous : new Map<string, boolean>();
      seeded = true;
      previous = running;
      const unseen = pickZaicodeUnseenDone(
        briefs,
        before,
        useZaicodeSessionNav.getState().activeTaskId,
      );
      for (const brief of unseen) {
        if (inFlight.has(brief.sessionId)) continue;
        const handle = zaicodeContinueHandleFor({
          key: brief.projectKey,
          path: brief.workspacePath,
          ...(brief.workspaceIdentity ? { identity: brief.workspaceIdentity } : {}),
        });
        if (!handle) {
          logger.warn("[zaicode] unseen done: project not connected", { sessionId: brief.sessionId });
          continue;
        }
        inFlight.add(brief.sessionId);
        void handle
          .markUnread(brief.sessionId)
          .catch((error: unknown) => {
            logger.warn("[zaicode] unseen done: could not stamp the finished session", {
              sessionId: brief.sessionId,
              error: error instanceof Error ? error.message : String(error),
            });
          })
          .finally(() => inFlight.delete(brief.sessionId));
      }
    };

    const unsubscribe = useZaicodeSessionBriefs.subscribe(sweep);
    sweep();
    return unsubscribe;
  }, []);
}