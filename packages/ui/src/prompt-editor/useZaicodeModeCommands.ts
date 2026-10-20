import { useCallback, useEffect, useState } from "react";
import {
  hasZaicodePendingCommand,
  useZaicodeFreshSession,
  useZaicodeOpenSession,
  useZaicodePendingCommand,
} from "@/zaicode/zaicodeSaipen.js";
import {
  ZAICODE_SAIPEN_MODES,
  resolveZaicodeModeAction,
  type ZaicodeModeAction,
  useZaicodeMainSessions,
  zaicodeMainSessionIdOf,
  type ZaicodeSaipenMode,
} from "@/zaicode/zaicodeMainSession.js";
import { useZaicodeRunningSessions } from "@/zaicode/zaicodeSidebarPrefs.js";
import {
  submitWithZaicodeRole,
  useZaicodeSessionRoles,
  zaicodeRoleForCommand,
} from "@/zaicode/zaicodeSessionRoles.js";
import { dispatchZaicodeModeAction } from "@/zaicode/zaicodeModeDispatch.js";
import {
  formatIntentFeedback,
  useZaicodeActionIntents,
} from "@/zaicode/zaicodeActionIntent.js";
import { toast } from "@/components/ui/toast.js";

/** Cosmetic Shift preview; actual dispatch always reads the native activation event. */
function useShiftKey(): boolean {
  const [pressed, setPressed] = useState(false);
  useEffect(() => {
    const update = (event: KeyboardEvent) => setPressed(event.shiftKey);
    const blur = () => setPressed(false);
    window.addEventListener("keydown", update);
    window.addEventListener("keyup", update);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", update);
      window.removeEventListener("keyup", update);
      window.removeEventListener("blur", blur);
    };
  }, []);
  return pressed;
}

export function useZaicodeModeCommands(input: {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId?: string | null;
  mainId: string | null;
  mainKey: string;
  mainWorking: boolean;
  disabled: boolean;
  onCommand: (command: string) => boolean | void;
  onDirectCommand?: (command: string) => boolean | void | Promise<boolean | void>;
  queueCount?: number;
}) {
  const {
    workspacePath,
    workspaceIdentity,
    sessionId,
    mainId,
    mainKey,
    mainWorking,
    disabled,
    onCommand,
    onDirectCommand,
    queueCount = 0,
  } = input;
  const shiftPressed = useShiftKey();
  const pending = useZaicodePendingCommand();
  const freshRequest = useZaicodeFreshSession((state) => state.request);
  const hasPending = hasZaicodePendingCommand(pending, workspacePath, {
    workspaceIdentity,
    sessionId,
  });
  const executeAction = useCallback(
    (action: ZaicodeModeAction) => {
      const mains = useZaicodeMainSessions.getState();
      const currentRole = sessionId ? useZaicodeSessionRoles.getState().bySession[sessionId] : null;
      const currentMainId = zaicodeMainSessionIdOf(mains.byWorkspace, mainKey);
      dispatchZaicodeModeAction(
        action,
        {
          sessionId: sessionId ?? null,
          mainId: currentMainId,
          disabled,
          helperSession: Boolean(
            currentRole &&
            ZAICODE_SAIPEN_MODES.some((mode) => mode.shiftAction?.role === currentRole),
          ),
          mainWorking: useZaicodeRunningSessions
            .getState()
            .sessions.some((item) => item.sessionId === currentMainId),
        },
        {
          send: (command: string): boolean | void => {
            const sendFn = onDirectCommand ?? onCommand;
            const intent = useZaicodeActionIntents.getState().createIntent({
              workspacePath,
              workspaceIdentity,
              targetSessionId: sessionId ?? null,
              destination: "main",
              action,
              command,
            });
            useZaicodeActionIntents.getState().transitionState(intent.id, "ADMISSION_PENDING");
            let result: boolean | void | Promise<boolean | void>;
            try {
              result = sendFn(command);
            } catch (err) {
              const reason = err instanceof Error ? err.message : String(err);
              const rejected = useZaicodeActionIntents.getState().transitionState(intent.id, "REJECTED", {
                rejectionReason: reason,
              });
              if (rejected) toast(formatIntentFeedback(rejected), { variant: "warning" });
              throw err;
            }
            if (result instanceof Promise) {
              result
                .then((ok) => {
                  if (ok !== false) {
                    useZaicodeActionIntents.getState().transitionState(intent.id, "DISPATCHED");
                  } else {
                    const rejected = useZaicodeActionIntents.getState().transitionState(intent.id, "REJECTED", {
                      rejectionReason: "Admission rejected",
                    });
                    if (rejected) toast(formatIntentFeedback(rejected), { variant: "warning" });
                  }
                })
                .catch((err) => {
                  const reason = err instanceof Error ? err.message : String(err);
                  const rejected = useZaicodeActionIntents.getState().transitionState(intent.id, "REJECTED", {
                    rejectionReason: reason,
                  });
                  if (rejected) toast(formatIntentFeedback(rejected), { variant: "warning" });
                });
              return true;
            } else if (result !== false) {
              useZaicodeActionIntents.getState().transitionState(intent.id, "DISPATCHED");
            } else {
              const rejected = useZaicodeActionIntents.getState().transitionState(intent.id, "REJECTED", {
                rejectionReason: "Admission rejected",
              });
              if (rejected) toast(formatIntentFeedback(rejected), { variant: "warning" });
            }
            return result;
          },
          claimMain: () => mains.provision(mainKey, sessionId ?? null),
          queueMain: (targetId, command) => {
            if (sessionId === targetId) {
              const sendFn = onDirectCommand ?? onCommand;
              const intent = useZaicodeActionIntents.getState().createIntent({
                workspacePath,
                workspaceIdentity,
                targetSessionId: targetId,
                destination: "main",
                action,
                command,
              });
              useZaicodeActionIntents.getState().transitionState(intent.id, "ADMISSION_PENDING");
              let result: boolean | void | Promise<boolean | void>;
              try {
                result = sendFn(command);
              } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                const rejected = useZaicodeActionIntents.getState().transitionState(intent.id, "REJECTED", {
                  rejectionReason: reason,
                });
                if (rejected) toast(formatIntentFeedback(rejected), { variant: "warning" });
                return;
              }
              if (result instanceof Promise) {
                result
                  .then((ok) => {
                    if (ok !== false) {
                      const queued = useZaicodeActionIntents.getState().transitionState(intent.id, "QUEUED");
                      if (queued) toast(formatIntentFeedback(queued));
                    } else {
                      const rejected = useZaicodeActionIntents.getState().transitionState(intent.id, "REJECTED", {
                        rejectionReason: "Admission rejected",
                      });
                      if (rejected) toast(formatIntentFeedback(rejected), { variant: "warning" });
                    }
                  })
                  .catch((err) => {
                    const reason = err instanceof Error ? err.message : String(err);
                    const rejected = useZaicodeActionIntents.getState().transitionState(intent.id, "REJECTED", {
                      rejectionReason: reason,
                    });
                    if (rejected) toast(formatIntentFeedback(rejected), { variant: "warning" });
                  });
              } else if (result !== false) {
                const queued = useZaicodeActionIntents.getState().transitionState(intent.id, "QUEUED");
                if (queued) toast(formatIntentFeedback(queued));
              } else {
                const rejected = useZaicodeActionIntents.getState().transitionState(intent.id, "REJECTED", {
                  rejectionReason: "Admission rejected",
                });
                if (rejected) toast(formatIntentFeedback(rejected), { variant: "warning" });
              }
            } else {
              const intent = useZaicodeActionIntents.getState().createIntent({
                workspacePath,
                workspaceIdentity,
                targetSessionId: targetId,
                destination: "main",
                action,
                command,
              });
              useZaicodeActionIntents.getState().transitionState(intent.id, "ADMISSION_PENDING");
              useZaicodePendingCommand.getState().queue(
                workspacePath,
                command,
                {
                  workspaceIdentity,
                  sessionId: targetId,
                },
                action,
              );
              toast(formatIntentFeedback(intent));
              useZaicodeOpenSession.getState().open(workspacePath, workspaceIdentity, targetId);
            }
          },
          openMain: (targetId) =>
            useZaicodeOpenSession.getState().open(workspacePath, workspaceIdentity, targetId),
          openHelper: (command) => {
            const intent = useZaicodeActionIntents.getState().createIntent({
              workspacePath,
              workspaceIdentity,
              destination: "helper",
              action,
              command,
            });
            useZaicodeActionIntents.getState().transitionState(intent.id, "ADMISSION_PENDING");
            toast(formatIntentFeedback(intent));
            useZaicodeFreshSession
              .getState()
              .open(workspacePath, workspaceIdentity, command, action, sessionId, intent.id);
          },
          openMainDraft: (command) => {
            const intent = useZaicodeActionIntents.getState().createIntent({
              workspacePath,
              workspaceIdentity,
              destination: "main",
              action,
              command,
            });
            useZaicodeActionIntents.getState().transitionState(intent.id, "ADMISSION_PENDING");
            toast(formatIntentFeedback(intent));
            useZaicodeFreshSession
              .getState()
              .open(workspacePath, workspaceIdentity, command, action, sessionId, intent.id);
          },
        },
      );
    },
    [disabled, mainKey, onCommand, onDirectCommand, queueCount, sessionId, workspaceIdentity, workspacePath],
  );

  useEffect(() => {
    if (!hasPending || disabled) return;
    if (sessionId === mainId && mainWorking && !onDirectCommand) return;
    // 原草稿不能抢走 fresh-session 请求；先让 shell 完成草稿切换再消费。
    if (useZaicodeFreshSession.getState().request) return;
    const taken = pending.take(workspacePath, { workspaceIdentity, sessionId });
    if (!taken) return;
    try {
      if (taken.action?.kind === "core" || (taken.action && sessionId)) {
        executeAction(taken.action);
        return;
      }
      const role =
        taken.action?.kind === "subSaipen"
          ? taken.action.role
          : zaicodeRoleForCommand(taken.command);
      const sendFn = onDirectCommand ?? onCommand;
      submitWithZaicodeRole(mainKey, !sessionId ? role : null, () => {
        try {
          const res = sendFn(taken.command);
          if (res instanceof Promise) {
            res
              .then((val) => {
                if (val === false) {
                  pending.restore(workspacePath, taken, { workspaceIdentity, sessionId });
                }
              })
              .catch(() => {
                pending.restore(workspacePath, taken, { workspaceIdentity, sessionId });
              });
          } else if (res === false) {
            pending.restore(workspacePath, taken, { workspaceIdentity, sessionId });
          }
        } catch {
          pending.restore(workspacePath, taken, { workspaceIdentity, sessionId });
        }
      });
    } catch {
      pending.restore(workspacePath, taken, { workspaceIdentity, sessionId });
    }
  }, [
    disabled,
    executeAction,
    freshRequest,
    hasPending,
    mainId,
    mainKey,
    mainWorking,
    onCommand,
    onDirectCommand,
    pending,
    sessionId,
    workspaceIdentity,
    workspacePath,
  ]);

  const runMode = (mode: ZaicodeSaipenMode, shiftKey: boolean) => {
    // Shift 预览不决定执行；点击时解析，再把同一个 descriptor 送入延迟队列。
    executeAction(resolveZaicodeModeAction(mode, shiftKey));
  };
  return { shiftPressed, runMode };
}
