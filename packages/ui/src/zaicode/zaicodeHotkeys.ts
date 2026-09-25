import { useSyncExternalStore } from "react";
import { getDefaultShortcutBindings, SHORTCUT_COMMANDS } from "@zcode/shared";
import { readZaicodeSetting } from "./zaicodeSettingsSnapshot.js";
import { zaicodeKeyIs } from "./zaicodeKeys.js";

/**
 * ZAICODE hotkeys, FastPrompter's model: every action has a primary and an
 * alternative binding ("Ctrl+Q" / ""), Global ones work anywhere in Windows
 * (Electron globalShortcut), In-app ones while ZAICODE is focused. Keys match
 * by physical position on non-Latin layouts (zaicodeKeyIs), so Ctrl+Q is
 * Ctrl+Q on ЙЦУКЕН too. Bindings are plain strings: modifiers in the order
 * Ctrl, Alt, Shift, Win, then one key.
 */

export type ZaicodeHotkeyScope = "global" | "app";
export type ZaicodeHotkeyGroup =
  | "Global"
  | "Sessions"
  | "Composer"
  | "Timers"
  | "Workers"
  | "Window"
  | "Sounds"
  | "Interface";

export interface ZaicodeHotkeyAction {
  id: string;
  group: ZaicodeHotkeyGroup;
  scope: ZaicodeHotkeyScope;
  label: string;
  hint: string;
  defaults: readonly [string, string];
}

export const ZAICODE_HOTKEY_ACTIONS: readonly ZaicodeHotkeyAction[] = [
  // Global: work anywhere in Windows
  { id: "global.toggleWindow", group: "Global", scope: "global", label: "Show / hide ZAICODE", hint: "Brings ZAICODE to the front, or minimizes it when it already is", defaults: ["Alt+Z", ""] },
  { id: "global.nextSession", group: "Global", scope: "global", label: "Jump to the next working session", hint: "Brings ZAICODE up on the next session that is working or waiting for you", defaults: ["", ""] },
  { id: "global.tempTimer", group: "Global", scope: "global", label: "Temp Timer: add time", hint: "Adds the Temp Timer increment (15 min by default) without leaving your app", defaults: ["", ""] },
  { id: "global.productivity", group: "Global", scope: "global", label: "Productivity timer: start / pause", hint: "Work / break timer, from anywhere", defaults: ["", ""] },
  { id: "global.stopSounds", group: "Global", scope: "global", label: "Stop all ZAICODE sounds", hint: "Silences whatever ZAICODE is playing", defaults: ["", ""] },
  // Sessions
  { id: "session.next", group: "Sessions", scope: "app", label: "Next session (cycle)", hint: "Working / waiting sessions first, then this project's recent ones", defaults: ["Alt+Down", ""] },
  { id: "session.prev", group: "Sessions", scope: "app", label: "Previous session (cycle)", hint: "The same ring, backwards", defaults: ["Alt+Up", ""] },
  { id: "session.nextDone", group: "Sessions", scope: "app", label: "Next finished session (not seen yet)", hint: "The DONE button: the oldest finished session you have not opened", defaults: ["Alt+Right", ""] },
  { id: "session.continueAll", group: "Sessions", scope: "app", label: "CONTINUE ALL", hint: "The CONTINUE ALL button: stopped goals, failed turns, SAIPEN projects with open tickets", defaults: ["", ""] },
  { id: "session.archiveUndo", group: "Sessions", scope: "app", label: "Undo archive", hint: "Brings back the last archived session or project (text fields keep their own undo)", defaults: ["Ctrl+Z", ""] },
  // Composer
  { id: "saipen.start", group: "Composer", scope: "app", label: "START (/goal cc all)", hint: "Same as the START button under the composer", defaults: ["", ""] },
  { id: "saipen.step", group: "Composer", scope: "app", label: "STEP (cc)", hint: "Same as the STEP button", defaults: ["", ""] },
  { id: "saipen.clear", group: "Composer", scope: "app", label: "CLEAR", hint: "Same as the CLEAR button (empties this session, or opens a new one — Settings → Layout & home)", defaults: ["", ""] },
  // Timers
  { id: "timers.open", group: "Timers", scope: "app", label: "Open Timers", hint: "Alarms, interval reminders, Temp Timer, productivity, calendar", defaults: ["Ctrl+Shift+T", ""] },
  { id: "timers.temp", group: "Timers", scope: "app", label: "Temp Timer: add time", hint: "Same as Shift+Click on the clock", defaults: ["Alt+T", ""] },
  { id: "timers.productivity", group: "Timers", scope: "app", label: "Productivity timer: start / pause", hint: "Work / break timer", defaults: ["Alt+P", ""] },
  // Workers (subscription CLIs in terminals)
  { id: "ui.workers", group: "Workers", scope: "app", label: "Show / hide the WORKERS panel", hint: "The docked worker terminals under the chat; workers keep running while hidden", defaults: ["Alt+W", ""] },
  { id: "workers.next", group: "Workers", scope: "app", label: "Next worker", hint: "Shows the next worker wherever it is (panel, window or chip)", defaults: ["Alt+]", ""] },
  { id: "workers.prev", group: "Workers", scope: "app", label: "Previous worker", hint: "The same, backwards", defaults: ["Alt+[", ""] },
  { id: "workers.float", group: "Workers", scope: "app", label: "Worker: own window ↔ panel", hint: "Moves the focused worker out of the panel into its own window, or back", defaults: ["", ""] },
  { id: "workers.minimize", group: "Workers", scope: "app", label: "Worker: minimize", hint: "Turns the focused worker into a chip (it keeps running)", defaults: ["", ""] },
  { id: "workers.layout", group: "Workers", scope: "app", label: "Panel: split ↔ tabs", hint: "All docked workers side by side, or one at a time", defaults: ["", ""] },
  { id: "workers.even", group: "Workers", scope: "app", label: "Panel: share evenly", hint: "Every docked worker gets the same size", defaults: ["", ""] },
  // Window
  { id: "window.zones", group: "Window", scope: "app", label: "Window zones (Ctrl+Q picker)", hint: "Opens the zone picker, or cycles zones in fast mode", defaults: ["Ctrl+Q", ""] },
  // Sounds
  { id: "sounds.mute", group: "Sounds", scope: "app", label: "Mute / unmute all sounds", hint: "Master mute of the Sounds table", defaults: ["Alt+M", ""] },
  { id: "sounds.stop", group: "Sounds", scope: "app", label: "Stop playing sounds", hint: "Stops everything that is playing right now", defaults: ["Alt+.", ""] },
  // Interface
  { id: "ui.home", group: "Interface", scope: "app", label: "SAIHOME", hint: "Opens the operator home (clock, limits, projects, agents, statistics)", defaults: ["Alt+H", ""] },
  { id: "ui.settings", group: "Interface", scope: "app", label: "Settings", hint: "Opens Settings", defaults: ["", ""] },
  { id: "ui.help", group: "Interface", scope: "app", label: "Help", hint: "Opens ZAICODE Help", defaults: ["F1", ""] },
  { id: "ui.menu", group: "Interface", scope: "app", label: "Show / hide the sidebar menu", hint: "The New task / ZAICODE / … block", defaults: ["", ""] },
  { id: "ui.calm", group: "Interface", scope: "app", label: "Calm interface on / off", hint: "No animations, no dimming or blur, no hover pop-ups — all three at once", defaults: ["", ""] },
  { id: "ui.dispatch", group: "Interface", scope: "app", label: "Dispatch", hint: "Open a terminal or a vendor CLI in any project", defaults: ["Alt+D", ""] },
  { id: "ui.dismissToasts", group: "Interface", scope: "app", label: "Dismiss all notification cards", hint: "Clears every ZAICODE card on screen", defaults: ["Alt+N", ""] },
];

const ACTION_BY_ID = new Map(ZAICODE_HOTKEY_ACTIONS.map((action) => [action.id, action]));

/** F1..F10 as a block (FastPrompter's "F-Keys Navigation"). */
export type ZaicodeFKeysMode = "off" | "projects" | "sessions";

export interface ZaicodeHotkeySettings {
  enabled: boolean;
  fKeys: ZaicodeFKeysMode;
  bindings: Record<string, [string, string]>;
}

// ---------------------------------------------------------------------------
// Binding strings
// ---------------------------------------------------------------------------

const MODIFIERS = ["Ctrl", "Alt", "Shift", "Win"] as const;
type Modifier = (typeof MODIFIERS)[number];

const CODE_TO_KEY: Record<string, string> = {
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Space: "Space",
  Enter: "Enter",
  NumpadEnter: "Enter",
  Escape: "Esc",
  Tab: "Tab",
  Backspace: "Backspace",
  Insert: "Insert",
  Delete: "Delete",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Pause: "Pause",
  PrintScreen: "PrintScreen",
};

const NAMED_KEYS = new Set([...Object.values(CODE_TO_KEY)]);

export function normalizeZaicodeKeyName(raw: string): string | null {
  const key = raw.trim();
  if (!key) return null;
  if (/^[a-z]$/i.test(key)) return key.toUpperCase();
  if (/^[0-9]$/.test(key)) return key;
  const f = /^f([1-9]|1[0-9]|2[0-4])$/i.exec(key);
  if (f) return `F${f[1]}`;
  const numpad = /^num(?:pad)?([0-9])$/i.exec(key);
  if (numpad) return `Numpad${numpad[1]}`;
  const aliases: Record<string, string> = { escape: "Esc", arrowup: "Up", arrowdown: "Down", arrowleft: "Left", arrowright: "Right", return: "Enter", del: "Delete" };
  const alias = aliases[key.toLowerCase()];
  if (alias) return alias;
  for (const named of NAMED_KEYS) if (named.toLowerCase() === key.toLowerCase()) return named;
  return null;
}

export interface ParsedZaicodeBinding {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  win: boolean;
  key: string;
}

/** "ctrl + shift + t" -> parsed; null when the key is unknown or missing. */
export function parseZaicodeBinding(binding: string): ParsedZaicodeBinding | null {
  const text = binding.trim();
  if (!text) return null;
  // "Ctrl++" is not a thing; "+" as a key is written "=" (same physical key).
  const parts = text.split("+").map((part) => part.trim());
  const keyPart = parts.pop();
  if (!keyPart) return null;
  const parsed: ParsedZaicodeBinding = { ctrl: false, alt: false, shift: false, win: false, key: "" };
  for (const part of parts) {
    const modifier = MODIFIERS.find((name) => name.toLowerCase() === part.toLowerCase() || (name === "Ctrl" && /^control$/i.test(part)) || (name === "Win" && /^(meta|super|cmd)$/i.test(part)));
    if (!modifier) return null;
    parsed[modifier.toLowerCase() as "ctrl" | "alt" | "shift" | "win"] = true;
  }
  const key = normalizeZaicodeKeyName(keyPart);
  if (!key) return null;
  parsed.key = key;
  return parsed;
}

export function formatZaicodeBinding(parsed: ParsedZaicodeBinding): string {
  const parts: string[] = [];
  for (const modifier of MODIFIERS) if (parsed[modifier.toLowerCase() as "ctrl"]) parts.push(modifier);
  parts.push(parsed.key);
  return parts.join("+");
}

/** Canonical form, or "" for an empty / invalid binding. */
export function canonicalZaicodeBinding(binding: string): string {
  const parsed = parseZaicodeBinding(binding);
  return parsed ? formatZaicodeBinding(parsed) : "";
}

/** Physical key of an event, the way bindings name it; null for a bare modifier. */
export function zaicodeKeyNameOf(event: Pick<KeyboardEvent, "key" | "code">): string | null {
  if (["Control", "Alt", "Shift", "Meta", "AltGraph", "OS"].includes(event.key)) return null;
  const code = event.code ?? "";
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) {
    // A printed Latin letter decides (AZERTY); other layouts use the physical key.
    const printed = event.key.length === 1 ? event.key.toUpperCase() : "";
    return printed >= "A" && printed <= "Z" ? printed : letter[1]!;
  }
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1]!;
  const numpad = /^Numpad([0-9])$/.exec(code);
  if (numpad) return `Numpad${numpad[1]}`;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (CODE_TO_KEY[code]) return CODE_TO_KEY[code]!;
  return normalizeZaicodeKeyName(event.key);
}

/** The binding an event would record ("Ctrl+Shift+T"); null for a bare modifier. */
export function zaicodeBindingFromEvent(
  event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">,
): string | null {
  const key = zaicodeKeyNameOf(event);
  if (!key) return null;
  return formatZaicodeBinding({ ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, win: event.metaKey, key });
}

export function matchZaicodeBinding(
  binding: string,
  event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">,
): boolean {
  const parsed = parseZaicodeBinding(binding);
  if (!parsed) return false;
  if (parsed.ctrl !== event.ctrlKey || parsed.alt !== event.altKey || parsed.shift !== event.shiftKey || parsed.win !== event.metaKey) {
    return false;
  }
  if (/^[A-Z]$/.test(parsed.key) || /^[0-9]$/.test(parsed.key)) return zaicodeKeyIs(event, parsed.key);
  return zaicodeKeyNameOf(event) === parsed.key;
}

/** Electron accelerator for a global binding ("Alt+Z", "Ctrl+Shift+num1"); null if invalid. */
export function zaicodeAccelerator(binding: string): string | null {
  const parsed = parseZaicodeBinding(binding);
  if (!parsed) return null;
  const parts: string[] = [];
  if (parsed.ctrl) parts.push("Ctrl");
  if (parsed.alt) parts.push("Alt");
  if (parsed.shift) parts.push("Shift");
  if (parsed.win) parts.push("Super");
  const special: Record<string, string> = { Esc: "Escape", Enter: "Return", PageUp: "PageUp", PageDown: "PageDown", Up: "Up", Down: "Down", Left: "Left", Right: "Right" };
  const numpad = /^Numpad([0-9])$/.exec(parsed.key);
  parts.push(numpad ? `num${numpad[1]}` : (special[parsed.key] ?? parsed.key));
  return parts.join("+");
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const STORAGE_KEY = "zaicode-hotkeys-v1";
const CHANGE_EVENT = "zaicode-hotkeys-changed";

export function defaultZaicodeHotkeySettings(): ZaicodeHotkeySettings {
  const bindings: Record<string, [string, string]> = {};
  for (const action of ZAICODE_HOTKEY_ACTIONS) bindings[action.id] = [...action.defaults];
  return { enabled: true, fKeys: "off", bindings };
}

export function normalizeZaicodeHotkeySettings(raw: unknown): ZaicodeHotkeySettings {
  const base = defaultZaicodeHotkeySettings();
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Partial<ZaicodeHotkeySettings>;
  const bindings = { ...base.bindings };
  for (const [id, value] of Object.entries(r.bindings ?? {})) {
    if (!bindings[id] || !Array.isArray(value)) continue;
    bindings[id] = [canonicalZaicodeBinding(String(value[0] ?? "")), canonicalZaicodeBinding(String(value[1] ?? ""))];
  }
  return {
    enabled: r.enabled !== false,
    fKeys: r.fKeys === "projects" || r.fKeys === "sessions" ? r.fKeys : "off",
    bindings,
  };
}

let cached: ZaicodeHotkeySettings | null = null;

export function readZaicodeHotkeySettings(): ZaicodeHotkeySettings {
  if (cached) return cached;
  try {
    cached = normalizeZaicodeHotkeySettings(JSON.parse(readZaicodeSetting(STORAGE_KEY) ?? "null"));
  } catch {
    cached = defaultZaicodeHotkeySettings();
  }
  return cached;
}

function write(next: ZaicodeHotkeySettings): void {
  cached = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // this session only
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function setZaicodeHotkeySettings(patch: Partial<Omit<ZaicodeHotkeySettings, "bindings">>): void {
  write(normalizeZaicodeHotkeySettings({ ...readZaicodeHotkeySettings(), ...patch }));
}

export function setZaicodeHotkeyBinding(id: string, slot: 0 | 1, binding: string): void {
  const current = readZaicodeHotkeySettings();
  const row = current.bindings[id];
  if (!row) return;
  const next: [string, string] = [...row];
  next[slot] = canonicalZaicodeBinding(binding);
  write({ ...current, bindings: { ...current.bindings, [id]: next } });
}

export function resetZaicodeHotkeys(): void {
  write(defaultZaicodeHotkeySettings());
}

export function useZaicodeHotkeySettings(): ZaicodeHotkeySettings {
  return useSyncExternalStore(
    (listener) => {
      window.addEventListener(CHANGE_EVENT, listener);
      return () => window.removeEventListener(CHANGE_EVENT, listener);
    },
    readZaicodeHotkeySettings,
    readZaicodeHotkeySettings,
  );
}

export function zaicodeHotkeyAction(id: string): ZaicodeHotkeyAction | undefined {
  return ACTION_BY_ID.get(id);
}

/** Does `event` trigger action `id` (primary or alternative binding)? */
export function matchZaicodeHotkey(id: string, event: KeyboardEvent, settings = readZaicodeHotkeySettings()): boolean {
  if (!settings.enabled) return false;
  const row = settings.bindings[id];
  return Boolean(row?.some((binding) => binding && matchZaicodeBinding(binding, event)));
}

/** Current bindings of `id` joined for tooltips ("Alt+Down / Ctrl+J"); "" when unbound. */
export function zaicodeHotkeyLabel(id: string, settings = readZaicodeHotkeySettings()): string {
  return (settings.bindings[id] ?? []).filter(Boolean).join(" / ");
}

/** F1..F10 of the F-keys block ("F3" -> 2), or null. */
export function zaicodeFKeyIndex(event: Pick<KeyboardEvent, "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">): number | null {
  if (event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return null;
  const match = /^F([1-9]|10)$/.exec(event.code ?? "");
  return match ? Number(match[1]) - 1 : null;
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

/** Upstream app shortcut defaults in our binding form ("CmdOrCtrl+k" -> "Ctrl+K"). */
export function zaicodeUpstreamShortcutBindings(): Map<string, string> {
  const out = new Map<string, string>();
  for (const command of SHORTCUT_COMMANDS) {
    if (command.scope === "composer") continue;
    for (const binding of getDefaultShortcutBindings(command.id)) {
      const canonical = canonicalZaicodeBinding(binding.replace(/CmdOrCtrl/g, "Ctrl").replace(/AltGr/g, "Ctrl+Alt"));
      if (canonical) out.set(canonical, command.id);
    }
  }
  return out;
}

export interface ZaicodeHotkeyConflict {
  binding: string;
  /** ZAICODE actions sharing it (2+), or one action plus the upstream command. */
  actions: string[];
  upstream: string | null;
}

export function findZaicodeHotkeyConflicts(settings: ZaicodeHotkeySettings): ZaicodeHotkeyConflict[] {
  const byBinding = new Map<string, string[]>();
  for (const action of ZAICODE_HOTKEY_ACTIONS) {
    for (const binding of settings.bindings[action.id] ?? []) {
      if (!binding) continue;
      byBinding.set(binding, [...(byBinding.get(binding) ?? []), action.id]);
    }
  }
  if (settings.fKeys !== "off") {
    for (let index = 1; index <= 10; index += 1) {
      const binding = `F${index}`;
      byBinding.set(binding, [...(byBinding.get(binding) ?? []), `fkeys.${settings.fKeys}`]);
    }
  }
  const upstream = zaicodeUpstreamShortcutBindings();
  const conflicts: ZaicodeHotkeyConflict[] = [];
  for (const [binding, actions] of byBinding) {
    const unique = [...new Set(actions)];
    const shadowed = upstream.get(binding) ?? null;
    if (unique.length > 1 || shadowed) conflicts.push({ binding, actions: unique, upstream: shadowed });
  }
  return conflicts;
}

// ---------------------------------------------------------------------------
// Handlers: components register what an action does
// ---------------------------------------------------------------------------

type Handler = () => void;
const handlers = new Map<string, Handler[]>();

/** Registers what action `id` does; the latest registration wins. Returns the unregister. */
export function registerZaicodeHotkeyHandler(id: string, handler: Handler): () => void {
  handlers.set(id, [...(handlers.get(id) ?? []), handler]);
  return () => handlers.set(id, (handlers.get(id) ?? []).filter((candidate) => candidate !== handler));
}

/** Runs action `id`; false when nothing handles it right now. */
export function runZaicodeHotkeyAction(id: string): boolean {
  const list = handlers.get(id);
  const handler = list?.[list.length - 1];
  if (!handler) return false;
  handler();
  return true;
}
