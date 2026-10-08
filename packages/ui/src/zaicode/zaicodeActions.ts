import { create } from "zustand";
import { resolveWorkspaceKey } from "@zcode/shared";
import type { SettingsSectionId } from "@/lib/settingsNavigation.js";
import { setPendingSettingsSection } from "@/lib/settingsNavigation.js";

/**
 * App-wide ZAICODE actions that need the tab store (open Settings on a
 * section, open Help). The runtime component registers the opener once; any
 * module, hotkey or menu can then call these without a React context.
 */

export interface ZaicodeSaipenTarget {
  workspacePath: string;
  workspaceIdentity?: string | undefined;
}

interface ZaicodeActionsState {
  openSettings: (() => void) | null;
  setOpenSettings: (open: (() => void) | null) => void;
  /** Opens the ZAICODE workspace view (registered by the shell layout). */
  openZaicodeView: (() => void) | null;
  setOpenZaicodeView: (open: (() => void) | null) => void;
  /** Opens SAIHOME (registered by the shell layout). */
  openZaicodeHome: (() => void) | null;
  setOpenZaicodeHome: (open: (() => void) | null) => void;
  openSaipen: ((target?: ZaicodeSaipenTarget) => boolean) | null;
  setOpenSaipen: (open: ((target?: ZaicodeSaipenTarget) => boolean) | null) => void;
  saipenSidebar: ZaicodeSaipenTarget | null;
  setSaipenSidebar: (target: ZaicodeSaipenTarget | null) => void;
  /** The main view on screen now, mirrored by the shell (sidebar highlights read it). */
  mainView: string;
  setMainView: (view: string) => void;
}

export const useZaicodeActions = create<ZaicodeActionsState>((set) => ({
  openSettings: null,
  setOpenSettings: (openSettings) => set({ openSettings }),
  openZaicodeView: null,
  setOpenZaicodeView: (openZaicodeView) => set({ openZaicodeView }),
  openZaicodeHome: null,
  setOpenZaicodeHome: (openZaicodeHome) => set({ openZaicodeHome }),
  openSaipen: null,
  setOpenSaipen: (openSaipen) => set({ openSaipen }),
  saipenSidebar: null,
  setSaipenSidebar: (saipenSidebar) => set({ saipenSidebar }),
  mainView: "chat",
  setMainView: (mainView) => set({ mainView }),
}));

/** Opens SAIHOME from anywhere (menu line, hotkey, tray). No side effects beyond the view change. */
export function openZaicodeHomeView(): boolean {
  const open = useZaicodeActions.getState().openZaicodeHome;
  if (!open) return false;
  open();
  return true;
}

export function openZaicodeSaipenView(workspacePath?: string, workspaceIdentity?: string): boolean {
  const state = useZaicodeActions.getState();
  const target = workspacePath ? { workspacePath, workspaceIdentity } : undefined;
  // 草稿变成对话后 opener 可能已注册；先关闭当前可见的同项目检查器，不能另开一个。
  if (target && state.saipenSidebar && resolveWorkspaceKey(state.saipenSidebar) === resolveWorkspaceKey(target)) {
    state.setSaipenSidebar(null);
    return true;
  }
  if (state.openSaipen?.(target)) {
    state.setSaipenSidebar(null);
    return true;
  }
  // A centered draft has no visible workspace pane. Keep the inspected project explicit.
  if (!target) return false;
  state.setSaipenSidebar(target);
  return true;
}

/** Opens the ZAICODE workspace (agents, queue, SCHEDULER) from anywhere. */
export function openZaicodeWorkspaceView(): boolean {
  const open = useZaicodeActions.getState().openZaicodeView;
  if (!open) return false;
  open();
  return true;
}

export function openZaicodeSettings(section?: SettingsSectionId): boolean {
  const open = useZaicodeActions.getState().openSettings;
  if (!open) return false;
  if (section) setPendingSettingsSection(section);
  open();
  return true;
}

const HELP_TOPIC_KEY = "zaicode-help-topic";
/** Live channel for "show me this topic now", for when Help is already open. */
export const ZAICODE_HELP_TOPIC_EVENT = "zcode:zaicode-help-topic";

/** Subscribes to "show this topic now". Returns an unsubscribe function. */
export function onZaicodeHelpTopicRequest(listener: (topic: string) => void): () => void {
  const handler = (event: Event) => {
    const topic = (event as CustomEvent<string>).detail;
    if (typeof topic === "string" && topic) listener(topic);
  };
  window.addEventListener(ZAICODE_HELP_TOPIC_EVENT, handler);
  return () => window.removeEventListener(ZAICODE_HELP_TOPIC_EVENT, handler);
}

/** Opens ZAICODE Help, optionally scrolled to one topic id. */
export function openZaicodeHelp(topic?: string): boolean {
  // SRC-060: sessionStorage alone was not enough. The help section consumed the
  // stored topic once on mount, so pressing Shift+F1 while Help was already
  // open stored the id and nothing read it -- the operator got no movement at
  // all. Fire the live channel as well, so the jump works whether Help is
  // opening now or is already on screen.
  if (topic) {
    try {
      sessionStorage.setItem(HELP_TOPIC_KEY, topic);
    } catch {
      // The event below still carries it.
    }
    try {
      window.dispatchEvent(new CustomEvent<string>(ZAICODE_HELP_TOPIC_EVENT, { detail: topic }));
    } catch {
      // No window (tests): the settings deep link still works.
    }
  }
  return openZaicodeSettings("zaicodeHelp");
}

export function takeZaicodeHelpTopic(): string | null {
  try {
    const topic = sessionStorage.getItem(HELP_TOPIC_KEY);
    sessionStorage.removeItem(HELP_TOPIC_KEY);
    return topic;
  } catch {
    return null;
  }
}
