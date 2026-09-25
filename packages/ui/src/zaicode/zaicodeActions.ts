import { create } from "zustand";
import type { SettingsSectionId } from "@/lib/settingsNavigation.js";
import { setPendingSettingsSection } from "@/lib/settingsNavigation.js";

/**
 * App-wide ZAICODE actions that need the tab store (open Settings on a
 * section, open Help). The runtime component registers the opener once; any
 * module, hotkey or menu can then call these without a React context.
 */

interface ZaicodeActionsState {
  openSettings: (() => void) | null;
  setOpenSettings: (open: (() => void) | null) => void;
  /** Opens the ZAICODE workspace view (registered by the shell layout). */
  openZaicodeView: (() => void) | null;
  setOpenZaicodeView: (open: (() => void) | null) => void;
  /** Opens SAIHOME (registered by the shell layout). */
  openZaicodeHome: (() => void) | null;
  setOpenZaicodeHome: (open: (() => void) | null) => void;
  /** Opens the subscription chat view (T-51, registered by the shell layout). */
  openZaicodeSubchat: (() => void) | null;
  setOpenZaicodeSubchat: (open: (() => void) | null) => void;
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
  openZaicodeSubchat: null,
  setOpenZaicodeSubchat: (openZaicodeSubchat) => set({ openZaicodeSubchat }),
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

/** Opens the subscription chat view (SUBCHAT). No side effects beyond the view change. */
export function openZaicodeSubchatView(): boolean {
  const open = useZaicodeActions.getState().openZaicodeSubchat;
  if (!open) return false;
  open();
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

/** Opens ZAICODE Help, optionally scrolled to one topic id. */
export function openZaicodeHelp(topic?: string): boolean {
  try {
    if (topic) sessionStorage.setItem(HELP_TOPIC_KEY, topic);
  } catch {
    // Help still opens at the top
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
