import { useEffect, useSyncExternalStore } from "react";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { useZaicodeTimerEngine } from "./useZaicodeTimerEngine.js";
import { useZaicodeRouterAutoSetup } from "./useZaicodeRouterAutoSetup.js";
import { ZaicodeToastHost } from "./ZaicodeToastHost.js";
import { ZaicodeTimersWindow } from "./ZaicodeTimersDialog.js";
import { useZaicodeActions, openZaicodeHelp, openZaicodeHomeView, openZaicodeSettings } from "./zaicodeActions.js";
import {
  matchZaicodeHotkey,
  readZaicodeHotkeySettings,
  registerZaicodeHotkeyHandler,
  runZaicodeHotkeyAction,
  useZaicodeHotkeySettings,
  zaicodeAccelerator,
  zaicodeFKeyIndex,
  ZAICODE_HOTKEY_ACTIONS,
} from "./zaicodeHotkeys.js";
import { useZaicodeTimers } from "./zaicodeTimerStore.js";
import { toggleZaicodeProductivity } from "./zaicodeProductivity.js";
import { cycleZaicodeSession, openZaicodeSession, useZaicodeSessionNav } from "./zaicodeSessionNav.js";
import { useZaicodeRunningSessions, useZaicodeSidebarPrefs } from "./zaicodeSidebarPrefs.js";
import { readZaicodeSoundSettings, setZaicodeSoundSettings, stopAllZaicodeSounds } from "./zaicodeSoundEvents.js";
import { useZaicodeToasts } from "./zaicodeNotifications.js";
import {
  cycleZaicodeWorker,
  dockZaicodeWorker,
  floatZaicodeWorker,
  minimizeZaicodeWorker,
  readZaicodeWorkers,
  toggleZaicodeWorkersPanel,
  zaicodePanelWorkers,
} from "./zaicodeWorkers.js";
import { useZaicodeWorkerPrefs } from "./zaicodeWorkerPrefs.js";
import { evenZaicodeSplitSizes } from "./zaicodeWorkerLayout.js";
import { playZaicodeSound } from "./zaicodeSoundBus.js";
import { toggleZaicodeDispatchPanel } from "./ZaicodeDispatchPanel.js";
import { isZaicodeCalm, useZaicodeUiPrefs, zaicodeCalmClasses } from "./zaicodeUiPrefs.js";
import { installZaicodePixelSnap } from "./zaicodePixelSnap.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { partitionWorkspaceTabsByPurpose } from "@/lib/workspacePurpose.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { useOptionalBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { publishZaicodeKnownProjects, type ZaicodeKnownProject } from "./zaicodeScheduler.js";
import { publishZaicodeQueueServices } from "./zaicodeAutostart.js";
import { resolveZaicodeServices } from "./zaicodeServices.js";
import { publishZaicodeHomeServices, useZaicodeWorkerStatsRecorder } from "./home/zaicodeHomeFeed.js";
import { projectNameOf } from "./zaicodeEngines.js";
import { ensureZaicodeMotionStyles } from "./zaicodeMotionCss.js";

/**
 * Everything ZAICODE runs once per window: the timer heartbeat, notification
 * cards, the Timers window, the hotkey dispatcher (in-app + global) and the
 * handlers behind hotkeys that no single component owns.
 */

export type ZaicodeGlobalHotkeyStatus = "ok" | "taken" | "invalid";

interface GlobalHotkeyBridge {
  setZaicodeGlobalHotkeys?(bindings: { id: string; accelerator: string }[]): Promise<Record<string, ZaicodeGlobalHotkeyStatus>>;
  onZaicodeGlobalHotkey?(callback: (id: string) => void): () => void;
}

function bridge(): GlobalHotkeyBridge | undefined {
  return typeof window === "undefined" ? undefined : (window as unknown as { zcode?: GlobalHotkeyBridge }).zcode;
}

// Last registration result, for the Hotkeys settings page.
let globalStatus: Record<string, ZaicodeGlobalHotkeyStatus> = {};
const STATUS_EVENT = "zaicode-global-hotkeys-status";

export function useZaicodeGlobalHotkeyStatus(): Record<string, ZaicodeGlobalHotkeyStatus> {
  return useSyncExternalStore(
    (listener) => {
      window.addEventListener(STATUS_EVENT, listener);
      return () => window.removeEventListener(STATUS_EVENT, listener);
    },
    () => globalStatus,
    () => globalStatus,
  );
}

/** Global action -> the in-app action it runs once ZAICODE has the event. */
const GLOBAL_TO_APP: Record<string, string> = {
  "global.nextSession": "session.next",
  "global.tempTimer": "timers.temp",
  "global.productivity": "timers.productivity",
  "global.stopSounds": "sounds.stop",
  // Tray menu picks (main process, zaicodeTrayMenuModel.ts).
  "tray.home": "ui.home",
  "tray.workers": "ui.workers",
  "tray.timers": "timers.open",
  "tray.settings": "ui.settings",
};

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable;
}

/** Actions whose keys are matched by their own listeners (they need the event context). */
const SELF_HANDLED = new Set(["window.zones", "session.archiveUndo"]);

function useZaicodeHotkeyDispatcher(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      const settings = readZaicodeHotkeySettings();
      if (!settings.enabled) return;
      // Settings -> Hotkeys is recording a key: never run actions under it.
      if (document.querySelector("[data-zaicode-hotkey-recording]")) return;
      const bare = !event.ctrlKey && !event.altKey && !event.metaKey;
      const fIndex = zaicodeFKeyIndex(event);
      if (settings.fKeys !== "off" && fIndex !== null) {
        const nav = useZaicodeSessionNav.getState();
        if (settings.fKeys === "projects") nav.projects[fIndex]?.();
        else {
          const session = nav.recent[fIndex];
          if (session) openZaicodeSession(session);
        }
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      for (const action of ZAICODE_HOTKEY_ACTIONS) {
        if (action.scope !== "app" || SELF_HANDLED.has(action.id)) continue;
        if (!matchZaicodeHotkey(action.id, event, settings)) continue;
        // A bare key (no modifier, not an F-key) never fires while typing.
        if (bare && !/^F\d/.test(event.code) && isTypingTarget(event.target)) return;
        if (!runZaicodeHotkeyAction(action.id)) return;
        event.preventDefault();
        event.stopPropagation();
        playZaicodeSound("ui.hotkey");
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
}

function useZaicodeGlobalHotkeys(): void {
  const settings = useZaicodeHotkeySettings();
  useEffect(() => {
    const api = bridge();
    if (!api?.setZaicodeGlobalHotkeys) return;
    const bindings: { id: string; accelerator: string }[] = [];
    if (settings.enabled) {
      for (const action of ZAICODE_HOTKEY_ACTIONS) {
        if (action.scope !== "global") continue;
        for (const binding of settings.bindings[action.id] ?? []) {
          const accelerator = binding ? zaicodeAccelerator(binding) : null;
          if (accelerator) bindings.push({ id: action.id, accelerator });
        }
      }
    }
    void api
      .setZaicodeGlobalHotkeys(bindings)
      .then((status) => {
        globalStatus = status;
        window.dispatchEvent(new Event(STATUS_EVENT));
      })
      .catch(() => undefined);
  }, [settings]);
  useEffect(() => {
    const api = bridge();
    if (!api?.onZaicodeGlobalHotkey) return;
    return api.onZaicodeGlobalHotkey((id) => {
      const target = GLOBAL_TO_APP[id];
      if (target) runZaicodeHotkeyAction(target);
    });
  }, []);
}

function useZaicodeRuntimeHandlers(): void {
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  const setOpenSettings = useZaicodeActions((state) => state.setOpenSettings);
  useEffect(() => {
    setOpenSettings(() => openSettingsTab());
    return () => setOpenSettings(null);
  }, [openSettingsTab, setOpenSettings]);

  useEffect(() => {
    const running = () => useZaicodeRunningSessions.getState().sessions;
    const unregister = [
      registerZaicodeHotkeyHandler("session.next", () => void cycleZaicodeSession(1, running())),
      registerZaicodeHotkeyHandler("session.prev", () => void cycleZaicodeSession(-1, running())),
      registerZaicodeHotkeyHandler("timers.open", () => useZaicodeTimers.getState().openDialog("alarms")),
      registerZaicodeHotkeyHandler("timers.temp", () => {
        useZaicodeTimers.getState().addTempTimer();
        playZaicodeSound("ui.toggle");
      }),
      registerZaicodeHotkeyHandler("timers.productivity", () => useZaicodeTimers.getState().setProductivity(toggleZaicodeProductivity)),
      registerZaicodeHotkeyHandler("sounds.mute", () => setZaicodeSoundSettings({ muted: !readZaicodeSoundSettings().muted })),
      registerZaicodeHotkeyHandler("sounds.stop", stopAllZaicodeSounds),
      registerZaicodeHotkeyHandler("ui.help", () => void openZaicodeHelp()),
      registerZaicodeHotkeyHandler("ui.home", () => void openZaicodeHomeView()),
      registerZaicodeHotkeyHandler("ui.settings", () => void openZaicodeSettings()),
      registerZaicodeHotkeyHandler("ui.menu", () => {
        const prefs = useZaicodeSidebarPrefs.getState();
        prefs.update({ navOpen: !prefs.navOpen });
      }),
      registerZaicodeHotkeyHandler("ui.dismissToasts", () => useZaicodeToasts.getState().dismissAll()),
      registerZaicodeHotkeyHandler("ui.dispatch", toggleZaicodeDispatchPanel),
      registerZaicodeHotkeyHandler("ui.workers", toggleZaicodeWorkersPanel),
      registerZaicodeHotkeyHandler("workers.next", () => cycleZaicodeWorker(1)),
      registerZaicodeHotkeyHandler("workers.prev", () => cycleZaicodeWorker(-1)),
      registerZaicodeHotkeyHandler("workers.float", () => {
        const { workers, focusedId } = readZaicodeWorkers();
        const worker = workers.find((item) => item.id === focusedId);
        if (!worker) return;
        if (worker.placement === "panel") floatZaicodeWorker(worker.id);
        else dockZaicodeWorker(worker.id);
      }),
      registerZaicodeHotkeyHandler("workers.minimize", () => {
        const { focusedId } = readZaicodeWorkers();
        if (focusedId) minimizeZaicodeWorker(focusedId);
      }),
      registerZaicodeHotkeyHandler("workers.layout", () => {
        const prefs = useZaicodeWorkerPrefs.getState();
        prefs.update({ panelLayout: prefs.panelLayout === "split" ? "tabs" : "split" });
      }),
      registerZaicodeHotkeyHandler("workers.even", () =>
        useZaicodeWorkerPrefs.getState().update({ splitSizes: evenZaicodeSplitSizes(zaicodePanelWorkers().length) }),
      ),
    ];
    return () => unregister.forEach((dispose) => dispose());
  }, []);
}

/** Mount once inside the tab store provider (App). */
/** Calm interface: the three switches become <html> classes (CSS in zaicodePalettes.ts). */
function useZaicodeCalmInterface(): void {
  const noMotion = useZaicodeUiPrefs((state) => state.noMotion);
  const noDim = useZaicodeUiPrefs((state) => state.noDim);
  const noHoverPopups = useZaicodeUiPrefs((state) => state.noHoverPopups);
  useEffect(() => {
    const root = document.documentElement;
    for (const [name, on] of Object.entries(zaicodeCalmClasses({ noMotion, noDim, noHoverPopups }))) {
      root.classList.toggle(name, on);
    }
  }, [noDim, noHoverPopups, noMotion]);
  useEffect(
    () =>
      registerZaicodeHotkeyHandler("ui.calm", () => {
        const prefs = useZaicodeUiPrefs.getState();
        const next = !isZaicodeCalm(prefs);
        prefs.update({ noMotion: next, noDim: next, noHoverPopups: next });
      }),
    [],
  );
}

/** SRC-038: centred columns stay on whole pixels after any resize (crisp pixel font). */
function useZaicodePixelSnap(): void {
  useEffect(() => {
    ensureZaicodeMotionStyles();
    return installZaicodePixelSnap();
  }, []);
}

/**
 * SCHEDULER (SRC-038): the runner lives outside React; it needs the open
 * projects (with their sidebar slot keys) and the local agent queue.
 */
function useZaicodeSchedulerPublishers(): void {
  const tabs = useTabStore((state) => state.tabs);
  useEffect(() => {
    const { projectWorkspaceTabs } = partitionWorkspaceTabsByPurpose(tabs.filter(isWorkspaceTab));
    const seen = new Set<string>();
    const projects: ZaicodeKnownProject[] = [];
    for (const tab of projectWorkspaceTabs) {
      const key = buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity);
      if (seen.has(key)) continue;
      seen.add(key);
      projects.push({
        path: tab.workspacePath,
        ...(tab.workspaceIdentity ? { identity: tab.workspaceIdentity } : {}),
        key,
        name: projectNameOf(tab.workspacePath),
      });
    }
    publishZaicodeKnownProjects(projects);
  }, [tabs]);
  const accessor = useOptionalBaseWorkspaceServices();
  useEffect(() => {
    publishZaicodeQueueServices(accessor ? resolveZaicodeServices(accessor) : null);
    publishZaicodeHomeServices(accessor ?? null);
  }, [accessor]);
}

export function ZaicodeAppRuntime() {
  useZaicodeWorkerStatsRecorder();
  useZaicodeCalmInterface();
  useZaicodePixelSnap();
  useZaicodeSchedulerPublishers();
  useZaicodeTimerEngine();
  useZaicodeRouterAutoSetup();
  useZaicodeHotkeyDispatcher();
  useZaicodeGlobalHotkeys();
  useZaicodeRuntimeHandlers();
  return (
    <>
      <ZaicodeToastHost />
      <ZaicodeTimersWindow />
    </>
  );
}
