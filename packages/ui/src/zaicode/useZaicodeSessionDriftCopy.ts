import { useCallback, useEffect, useRef, useState } from "react";
import { ZCODE_VERSION, ZCODE_COMMIT, ZCODE_BUILD_TIME } from "@zcode/shared";
import type { ZCodeTaskTarget } from "@zcode/services";
import { useServices } from "@/hooks/useServices.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { copySessionDriftEvidence } from "./zaicodeSessionDriftCopy.js";

export type SessionCopyState = {
  status: "idle" | "reading" | "copied" | "error";
  detail?: string;
};

type SessionCopyView = SessionCopyState & { identity: string };

export function useZaicodeSessionDriftCopy(target: ZCodeTaskTarget | null, ready: boolean) {
  const services = useServices();
  const platform = useOptionalPlatform();
  const identity = target
    ? JSON.stringify([
        target.workspaceIdentity?.trim() || target.workspacePath,
        target.remoteSessionId ?? "",
        target.sessionId,
      ])
    : "draft";
  const latest = useRef({ identity, services, platform, ready });
  latest.current = { identity, services, platform, ready };
  const mounted = useRef(true);
  const pending = useRef<object | null>(null);
  const [view, setView] = useState<SessionCopyView>({ identity, status: "idle" });
  useEffect(() => {
    mounted.current = true;
    // 同一 session ID 失去可用快照也必须取消取证；恢复可用时不能残留永久 Reading 状态。
    if (!ready) setView({ identity, status: "idle" });
    return () => {
      mounted.current = false;
      pending.current = null;
    };
  }, [identity, services, platform, ready]);
  const enabled = Boolean(target && ready && platform?.writeClipboardText);
  const onCopy = useCallback(
    async () => {
      if (!target || !ready || !platform?.writeClipboardText || pending.current) return;
      const operation = {};
      pending.current = operation;
      const captured = latest.current;
      const isCurrent = () =>
        mounted.current &&
        latest.current.ready &&
        pending.current === operation &&
        latest.current.identity === captured.identity &&
        latest.current.services === captured.services &&
        latest.current.platform === captured.platform;
      setView({ identity, status: "reading" });
      try {
        const result = await copySessionDriftEvidence({
          target,
          sessionService: services.zcodeSessionService,
          fileService: services.fileService,
          writeClipboardText: (text) => platform.writeClipboardText!(text),
          isCurrent,
          app: { version: ZCODE_VERSION, commit: ZCODE_COMMIT, buildTime: ZCODE_BUILD_TIME },
        });
        if (isCurrent())
          setView({
            identity,
            status: "copied",
            detail: `Full forensic · ${result.messages} messages copied (${result.characters.toLocaleString()} characters)`,
          });
      } catch (error) {
        if (isCurrent())
          setView({
            identity,
            status: "error",
            detail: error instanceof Error ? error.message : String(error),
          });
      } finally {
        if (pending.current === operation) pending.current = null;
      }
    },
    [target, ready, platform, identity, services],
  );
  return { enabled, onCopy, state: view.identity === identity ? view : { status: "idle" as const } };
}
