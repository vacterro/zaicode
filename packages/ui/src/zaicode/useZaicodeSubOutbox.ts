import { useEffect, useState } from "react";
import { resolveWorkspaceKey } from "@zcode/shared";
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
  return (error instanceof Error ? error.message : String(error ?? "")).trim() || "unknown error";
}

function summarize(packages: ZaicodeOutboxPackage[]): ZaicodeSubOutboxSnapshot {
  return {
    packages,
    counts: zaicodeOutboxCounts(packages),
    producers: zaicodeReadyProducers(packages),
  };
}

type Listener = (snapshot: ZaicodeSubOutboxSnapshot | null) => void;

/**
 * One reader per project, shared by every open composer (SRC-112).
 *
 * A project with ten sessions open has ten composers, and each would otherwise
 * readdir the subs root and re-read every OUTBOX.md on its own timer. That is
 * ten times the file traffic for one fact -- and on a remote host it is ten
 * times the network. Same shared-poller shape as the SAIPEN reader, for the
 * same reason: one answer, many subscribers.
 */
class OutboxPoller {
  private readonly listeners = new Set<Listener>();
  private snapshot: ZaicodeSubOutboxSnapshot | null = null;
  private timer: number | null = null;
  private running = false;

  constructor(
    private readonly workspacePath: string,
    private readonly fileService: FileService,
  ) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    if (this.listeners.size === 1) void this.tick();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.timer !== null) {
        window.clearTimeout(this.timer);
        this.timer = null;
      }
    };
  }

  get idle(): boolean {
    return this.listeners.size === 0;
  }

  private schedule(delay: number) {
    if (this.listeners.size === 0) return;
    this.timer = window.setTimeout(() => void this.tick(), delay);
  }

  private emit(snapshot: ZaicodeSubOutboxSnapshot | null) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }

  private async tick() {
    this.timer = null;
    if (this.running || this.listeners.size === 0) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      this.schedule(POLL_MS);
      return;
    }
    this.running = true;
    try {
      const root = `${this.workspacePath.replace(/[\\/]+$/, "")}/.saipen/extensions/subs`;
      const roles = (await this.fileService.readdir({ path: root, includeHidden: true })).filter(
        isZaicodeSubOutboxRole,
      );
      const packages: ZaicodeOutboxPackage[] = [];
      for (const role of roles) {
        const content = await this.fileService
          .readTextFile({ path: `${root}/${role.name}/kitchen/OUTBOX.md`, length: OUTBOX_BYTES })
          .then((slice) => slice.content)
          .catch(() => "");
        packages.push(...parseZaicodeOutbox(content));
      }
      this.emit(summarize(packages));
    } catch (error) {
      // An absent `.saipen/` is "no subSaipens here"; an unreadable one is not.
      if (isMissing(error)) this.emit(null);
      else this.emit({ ...ZAICODE_OUTBOX_EMPTY, readError: readError(error) });
    } finally {
      this.running = false;
      this.schedule(POLL_MS);
    }
  }
}

type FileService = ReturnType<typeof useWorkspaceServices>["fileService"];

const pollers = new Map<string, OutboxPoller>();

function acquirePoller(
  workspacePath: string,
  fileService: FileService,
  workspaceIdentity?: string,
): OutboxPoller {
  const key = resolveWorkspaceKey({ workspacePath, workspaceIdentity });
  let poller = pollers.get(key);
  if (!poller) {
    poller = new OutboxPoller(workspacePath, fileService);
    pollers.set(key, poller);
  }
  return poller;
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
    const poller = acquirePoller(workspacePath, fileService, workspaceIdentity);
    const unsubscribe = poller.subscribe(setSnapshot);
    return () => {
      unsubscribe();
      if (poller.idle) {
        for (const [key, value] of pollers) if (value === poller) pollers.delete(key);
      }
    };
  }, [fileService, workspacePath, workspaceIdentity]);

  return snapshot;
}
