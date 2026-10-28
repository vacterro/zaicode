import { create } from "zustand";
import { readZaicodeSetting } from "./zaicodeSettingsSnapshot.js";

/**
 * Per-session auto-continue (SRC-044, Wave 2).
 *
 * The global switch in Settings -> Workers decides the policy; this decides
 * one session against it:
 *
 *   default  -- follow the global switch (what every session did before);
 *   on       -- this session may continue itself even if the global switch is
 *               off, subject to the same safe-continuation rules;
 *   off      -- this session never continues itself, whatever the global
 *               switch says.
 *
 * An explicit On / Off is a decision about THIS session, so changing the
 * global switch later never overwrites it. The map is keyed by the session
 * id (the same id the tasks index, the crash planner and `cc` use), so it
 * survives a restart and cannot leak into another session. It is deliberately
 * NOT part of a profile bundle: this is a live fact about a machine's
 * sessions, like the MAIN-session map next to it.
 */

export const ZAICODE_AUTO_CONTINUE_MODES = ["default", "on", "off"] as const;
export type ZaicodeAutoContinueMode = (typeof ZAICODE_AUTO_CONTINUE_MODES)[number];

export const ZAICODE_AUTO_CONTINUE_LABEL: Record<ZaicodeAutoContinueMode, string> = {
  default: "Auto-continue: Default (follow the global switch)",
  on: "Auto-continue: On (this session continues itself)",
  off: "Auto-continue: Off (this session never continues itself)",
};

export const ZAICODE_AUTO_CONTINUE_SHORT: Record<ZaicodeAutoContinueMode, string> = {
  default: "Default",
  on: "On",
  off: "Off",
};

/** The one rule: an explicit per-session decision wins over the global default. */
export function zaicodeAutoContinueAllowed(mode: ZaicodeAutoContinueMode | undefined, globalOn: boolean): boolean {
  if (mode === "on") return true;
  if (mode === "off") return false;
  return globalOn;
}

/** Default -> on -> off -> default: one key press walks the three states. */
export function nextZaicodeAutoContinueMode(mode: ZaicodeAutoContinueMode): ZaicodeAutoContinueMode {
  const index = ZAICODE_AUTO_CONTINUE_MODES.indexOf(mode);
  return ZAICODE_AUTO_CONTINUE_MODES[(index + 1) % ZAICODE_AUTO_CONTINUE_MODES.length]!;
}

const STORAGE_KEY = "zaicode-auto-continue-v1";
/** Bound the file: one entry per session, and sessions are not infinite. */
const MAX_ENTRIES = 500;

type ModeMap = Record<string, ZaicodeAutoContinueMode>;

function load(): ModeMap {
  try {
    const raw: unknown = JSON.parse(readZaicodeSetting(STORAGE_KEY) ?? "null");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: ModeMap = {};
    for (const [sessionId, value] of Object.entries(raw as Record<string, unknown>)) {
      if (ZAICODE_AUTO_CONTINUE_MODES.includes(value as ZaicodeAutoContinueMode)) out[sessionId.slice(0, 128)] = value as ZaicodeAutoContinueMode;
    }
    return out;
  } catch {
    return {};
  }
}

interface ZaicodeAutoContinueState {
  modes: ModeMap;
  modeFor: (sessionId: string | null | undefined) => ZaicodeAutoContinueMode;
  setMode: (sessionId: string, mode: ZaicodeAutoContinueMode) => void;
  cycle: (sessionId: string) => ZaicodeAutoContinueMode;
  clear: (sessionId: string) => void;
}

export const useZaicodeAutoContinue = create<ZaicodeAutoContinueState>((set, get) => {
  const persist = (modes: ModeMap) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(modes));
    } catch {
      // Applies for this window anyway; the next start reads what did land.
    }
    set({ modes });
  };
  return {
    modes: load(),
    modeFor: (sessionId) => (sessionId ? get().modes[sessionId] ?? "default" : "default"),
    setMode: (sessionId, mode) => {
      if (!sessionId) return;
      const next: ModeMap = { ...get().modes, [sessionId]: mode };
      // "default" is the absence of a decision: do not store it, so a later
      // global switch really does decide for this session again.
      if (mode === "default") delete next[sessionId];
      const entries = Object.entries(next).slice(-MAX_ENTRIES);
      persist(Object.fromEntries(entries));
    },
    cycle: (sessionId) => {
      const next = nextZaicodeAutoContinueMode(get().modeFor(sessionId));
      get().setMode(sessionId, next);
      return next;
    },
    clear: (sessionId) => {
      if (!get().modes[sessionId]) return;
      const next = { ...get().modes };
      delete next[sessionId];
      persist(next);
    },
  };
});

/** What the crash planner asks, outside React. */
export function zaicodeAutoContinueModeFor(sessionId: string): ZaicodeAutoContinueMode {
  return useZaicodeAutoContinue.getState().modeFor(sessionId);
}
