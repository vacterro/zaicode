import { useEffect, useState } from "react";
import { notifyZaicode } from "./zaicodeNotifications.js";
import { create } from "zustand";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import type { IPlatformService } from "@zcode/shared";
import {
  buildSaimailSnapshot,
  parseSaimailIndex,
  type ZaicodeSaimailSnapshot,
  type ZaicodeTelegramHeader, recordSaimailUnread } from "./zaicodeSaimailModel.js";
import { playZaicodeSound } from "./zaicodeSoundBus.js";

const POLL_MS = 5000;
const MISSING_POLL_MS = 20000;
const INDEX_TAIL_BYTES = 128 * 1024;

/** Machine-level SAIMAIL mailbox path (launcher preferences), loaded once per window. */
interface ZaicodeSaimailConfigState {
  loaded: boolean;
  workspace: string | null;
  load: (platform: IPlatformService) => void;
  set: (platform: IPlatformService, workspace: string | null) => Promise<void>;
  /** Creates the operator mailbox in `workspace` (explicit click only), then saves it. */
  create: (
    platform: IPlatformService,
    workspace: string,
  ) => Promise<{ ok: boolean; message: string }>;
}

export const useZaicodeSaimailConfig = create<ZaicodeSaimailConfigState>((setState, get) => ({
  loaded: false,
  workspace: null,
  load: (platform) => {
    if (get().loaded) return;
    setState({ loaded: true });
    void platform
      .getZaicodeLauncherPreferences?.()
      .then((preferences) => setState({ workspace: preferences.saimailWorkspace ?? null }))
      .catch(() => setState({ workspace: null }));
  },
  set: async (platform, workspace) => {
    const preferences = await platform.setZaicodeSaimailWorkspace?.(workspace);
    setState({ workspace: preferences?.saimailWorkspace ?? workspace });
    refreshZaicodeSaimail();
  },
  create: async (platform, workspace) => {
    if (!platform.initZaicodeSaimailWorkspace) {
      return { ok: false, message: "This ZAICODE build cannot create mailboxes." };
    }
    const result = await platform.initZaicodeSaimailWorkspace(workspace);
    if (result.ok) await get().set(platform, workspace);
    return result;
  },
}));

type FileService = ReturnType<typeof useBaseWorkspaceServices>["fileService"];
type Listener = (
  value: {
    seat: string;
    unreadNames: string[];
    headers: Map<string, ZaicodeTelegramHeader>;
  } | null,
) => void;

/**
 * One header-only poller per mailbox: reads the seat from
 * saimail-workspace.json, lists mail/inbox/<seat>/ (unread) and re-reads the
 * index.jsonl tail only when its size changed. Never touches envelope files.
 */
class SaimailPoller {
  private readonly listeners = new Set<Listener>();
  private value: Parameters<Listener>[0] = null;
  private timer: number | null = null;
  private indexSize = -1;
  private headers = new Map<string, ZaicodeTelegramHeader>();
  private seat: string | null = null;

  constructor(
    private readonly root: string,
    private readonly fileService: FileService,
  ) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.value);
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

  /** Re-read now (seat included): a mailbox was just created or re-pointed. */
  refresh() {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    this.seat = null;
    this.indexSize = -1;
    void this.tick();
  }

  private emit(value: Parameters<Listener>[0]) {
    // A letter that was not unread on the previous read is new: one sound per arrival.
    const before = new Set(this.value?.unreadNames ?? []);
    if (this.value && value && value.unreadNames.some((name) => !before.has(name))) {
      playZaicodeSound("saimail.new");
      const fresh = value.unreadNames.filter((name) => !before.has(name));
      notifyZaicode("saimail.new", {
        header: "SAIMAIL",
        title: fresh.length === 1 ? "New letter" : `${fresh.length} new letters`,
        body: fresh.slice(0, 3).join(", "),
        key: "saimail",
      });
    }
    if (value) recordSaimailUnread(value.unreadNames);
    this.value = value;
    for (const listener of this.listeners) listener(value);
  }

  private async readSeat(): Promise<string> {
    if (this.seat) return this.seat;
    const slice = await this.fileService.readTextFile({
      path: `${this.root}/saimail-workspace.json`,
      length: 16384,
    });
    const parsed = JSON.parse(slice.content) as { seat?: unknown };
    if (typeof parsed.seat !== "string" || !/^[\w.-]{1,64}$/.test(parsed.seat)) {
      throw new Error("SAIMAIL workspace has no valid seat");
    }
    this.seat = parsed.seat;
    return parsed.seat;
  }

  private async readIndexTail() {
    const path = `${this.root}/mail/index.jsonl`;
    const probe = await this.fileService.readTextFile({ path, length: 1 });
    if (probe.totalBytes === this.indexSize) return;
    const slice = await this.fileService.readTextFile({
      path,
      offset: Math.max(0, probe.totalBytes - INDEX_TAIL_BYTES),
      length: INDEX_TAIL_BYTES,
    });
    this.headers = parseSaimailIndex(slice.content);
    this.indexSize = probe.totalBytes;
  }

  private async tick() {
    this.timer = null;
    if (this.listeners.size === 0) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      if (this.timer === null) this.timer = window.setTimeout(() => void this.tick(), POLL_MS);
      return;
    }
    let delay = POLL_MS;
    try {
      const seat = await this.readSeat();
      const entries = await this.fileService
        .readdir({ path: `${this.root}/mail/inbox/${seat}`, includeHidden: false })
        .catch(() => []);
      const unreadNames = entries
        .filter((entry) => entry.type === "directory")
        .map((entry) => entry.name);
      if (unreadNames.length > 0) await this.readIndexTail().catch(() => undefined);
      this.emit({ seat, unreadNames, headers: this.headers });
    } catch {
      this.seat = null;
      this.emit(null);
      delay = MISSING_POLL_MS;
    }
    // refresh() 可能与一次进行中的 tick 并发：只保留一条轮询链。
    if (this.listeners.size > 0 && this.timer === null) {
      this.timer = window.setTimeout(() => void this.tick(), delay);
    }
  }
}

const pollers = new Map<string, SaimailPoller>();

export function refreshZaicodeSaimail(): void {
  for (const poller of pollers.values()) poller.refresh();
}

/**
 * Unread SAIMAIL telegrams (headers only) for the configured local mailbox,
 * with the count addressed to the current SAIPEN ticket. Null when SAIMAIL is
 * not set up or the folder is not a SAIMAIL workspace.
 */
export function useZaicodeSaimail(
  mailbox: string | null,
  currentTask: string | null,
): ZaicodeSaimailSnapshot | null {
  // 邮箱是本机目录：始终经本机 host 读取，即使当前项目是远端 workspace。
  const { fileService } = useBaseWorkspaceServices();
  const [raw, setRaw] = useState<Parameters<Listener>[0]>(null);

  useEffect(() => {
    if (!mailbox) {
      setRaw(null);
      return;
    }
    const root = mailbox.replace(/[\\/]+$/, "");
    const key = root.toLowerCase();
    let poller = pollers.get(key);
    if (!poller) {
      poller = new SaimailPoller(root, fileService);
      pollers.set(key, poller);
    }
    const unsubscribe = poller.subscribe(setRaw);
    return () => {
      unsubscribe();
      if (poller.idle) pollers.delete(key);
    };
  }, [fileService, mailbox]);

  if (!raw) return null;
  return buildSaimailSnapshot({
    seat: raw.seat,
    unreadEntryNames: raw.unreadNames,
    headers: raw.headers,
    currentTask,
  });
}

/**
 * Mailbox path + header-only desk in one call: `configured` is false until a
 * folder is set, `desk` is null until that folder is a SAIMAIL workspace.
 */
export function useZaicodeSaimailDesk(currentTask: string | null): {
  mailbox: string | null;
  desk: ZaicodeSaimailSnapshot | null;
} {
  const platform = usePlatform();
  const mailbox = useZaicodeSaimailConfig((state) => state.workspace);
  const load = useZaicodeSaimailConfig((state) => state.load);
  useEffect(() => load(platform), [load, platform]);
  const desk = useZaicodeSaimail(mailbox, currentTask);
  return { mailbox, desk };
}
