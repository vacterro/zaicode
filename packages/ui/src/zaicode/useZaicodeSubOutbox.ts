import { useEffect, useState } from "react";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import {
  isZaicodeSubOutboxRole,
  parseZaicodeOutbox,
  zaicodeOutboxCounts,
  zaicodeReadyProducers,
  type ZaicodeOutboxCounts,
  type ZaicodeOutboxPackage,
} from "./zaicodeSubOutbox.js";

/**
 * SRC-112: one OUTBOX reader per project. Read-only -- a SubSaipen owns its
 * file, ZAICODE only projects it. Polls like the SAIPEN poller (a subSaipen
 * may be writing while the user watches) and stays quiet on a project with no
 * SubSaipen instances at all.
 */

const POLL_MS = 5000;
const OUTBOX_BYTES = 131072;

export interface ZaicodeSubOutboxSnapshot {
  packages: ZaicodeOutboxPackage[];
  counts: ZaicodeOutboxCounts;
  /** Producers with at least one ready package; the collect targets. */
  producers: string[];
  /** `.saipen/extensions/subs/` exists but could not be read. */
  readError?: string;
}

export const ZAICODE_OUTBOX_EMPTY: ZaicodeSubOutboxSnapshot = {
  packages: [],
  counts: { ready: 0, draft: 0, blocked: 0, reviewed: 0, stale: 0, actionable: 0 },
  producers: [],
};

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /\bENOENT\b|no such file|not found/i.test(message);
}

function readError(error: unknown): string {
  return (
    (error instanceof Error ? error.message : String(error ?? "")).trim() || "unknown error"
  );
}

function summarize(packages: ZaicodeOutboxPackage[]): ZaicodeSubOutboxSnapshot {
  return { packages, counts: zaicodeOutboxCounts(packages), producers: zaicodeReadyProducers(packages) };
}

export function useZaicodeSubOutbox(
  workspacePath: string,
  workspaceIdentity?: string,
): ZaicodeSubOutboxSnapshot | null {
  const { fileService } = useWorkspaceServices(workspacePath, undefined, workspaceIdentity);
  const [snapshot, setSnapshot] = useState<ZaicodeSubOutboxSnapshot | null>(null);

  useEffect(() => {
    if (!workspacePath) {
      setSnapshot(null);
      return undefined;
    }
    const root = `${workspacePath.replace(/[\\/]+$/, "")}/.saipen/extensions/subs`;
    let disposed = false;
    let timer: number | null = null;
    const tick = async () => {
      timer = null;
      if (disposed || (typeof document !== "undefined" && document.visibilityState === "hidden")) {
        timer = window.setTimeout(() => void tick(), POLL_MS);
        return;
      }
      try {
        const roles = (await fileService.readdir({ path: root, includeHidden: true })).filter(
          isZaicodeSubOutboxRole,
        );
        const packages: ZaicodeOutboxPackage[] = [];
        for (const role of roles) {
          const content = await fileService
            .readTextFile({ path: `${root}/${role.name}/kitchen/OUTBOX.md`, length: OUTBOX_BYTES })
            .then((slice) => slice.content)
            .catch(() => "");
          packages.push(...parseZaicodeOutbox(content));
        }
        if (!disposed) setSnapshot(summarize(packages));
      } catch (error) {
        // An absent `.saipen/` is "no subSaipens here"; an unreadable one is not.
        if (disposed) return;
        if (isMissing(error)) setSnapshot(null);
        else setSnapshot({ ...ZAICODE_OUTBOX_EMPTY, readError: readError(error) });
      } finally {
        if (!disposed) timer = window.setTimeout(() => void tick(), POLL_MS);
      }
    };
    void tick();
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [fileService, workspacePath]);

  return snapshot;
}