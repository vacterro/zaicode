import type { ZaicodeModeAction } from "./zaicodeMainSession.js";

interface ModeContext {
  sessionId: string | null;
  mainId: string | null;
  mainWorking: boolean;
  disabled: boolean;
  helperSession?: boolean;
}

interface ModePorts {
  send: (command: string) => boolean | void;
  claimMain: () => void | (() => void);
  queueMain: (sessionId: string, command: string) => void;
  openMain: (sessionId: string) => void;
  openHelper: (command: string) => void;
  openMainDraft: (command: string) => void;
}

/** The selected action owns routing; no name-based promotion to a persistent role. */
export function dispatchZaicodeModeAction(
  action: ZaicodeModeAction,
  context: ModeContext,
  ports: ModePorts,
): void {
  if (action.kind === "subSaipen") {
    if (context.mainWorking && !action.parallel) return;
    ports.openHelper(action.command);
    return;
  }
  const { mainId, sessionId, mainWorking, disabled } = context;
  if (!mainId) {
    if (context.helperSession) {
      ports.openMainDraft(action.command);
      return;
    }
    if (disabled) return;
    const rollback = ports.claimMain();
    let accepted = false;
    try {
      accepted = ports.send(action.command) !== false;
    } finally {
      if (!accepted && typeof rollback === "function") rollback();
    }
  } else if (mainId === sessionId && !mainWorking && !disabled) {
    ports.send(action.command);
  } else {
    // Core 工作必须留在 MAIN；侧会话不能为了绕过 busy 状态另起写入者。
    ports.queueMain(mainId, action.command);
    if (mainId !== sessionId) ports.openMain(mainId);
  }
}
