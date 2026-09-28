/**
 * The Sounds table: the catalog, the persisted shape, the normalizer and pool
 * selection. Deliberately free of audio, assets and IndexedDB, so the whole
 * settings model can be reasoned about and tested without an AudioContext or
 * a single decoded file. The playback engine that consumes it lives in
 * zaicodeSoundEvents.ts.
 */
import { useSyncExternalStore } from "react";
import { readZaicodeSetting } from "./zaicodeSettingsSnapshot.js";
import {
  ZAICODE_SOUND_LIMIT_MAX,
  normalizeZaicodeSoundLimit,
  normalizeZaicodeSoundOverlap,
  type ZaicodeSoundOverlap,
} from "./zaicodeSoundPolicy.js";
import { isZaicodeChokeGroup } from "./zaicodeSoundVoices.js";
import { zaicodeActionCueEvents } from "./zaicodeActionCues.js";
import {
  normalizeZaicodePool,
  pickZaicodePoolSound,
  redistributeZaicodePool,
  zaicodeRng,
  type ZaicodePoolEntry,
} from "./zaicodeSoundPools.js";

/**
 * ZAICODE sound events, FastPrompter-style: every action has its own row —
 * on/off, sound, gain in dB relative to the master volume, overlay/replace —
 * and nothing about which sound plays is hard-coded at the call site. Call
 * sites only name the event: `playZaicodeSound("session.new")`.
 *
 * Buttons can also opt in declaratively: `data-zaicode-sound="saipen.start"`
 * plays on click through one document-level listener.
 */

export type ZaicodeSoundGroup =
  | "Agent"
  | "Sessions"
  | "Composer"
  | "Sidebar"
  | "Window"
  | "Engines"
  | "SAIMAIL"
  | "Interface"
  | "Orchestra"
  | "SAIPEGGLE";

export interface ZaicodeSoundEventDef {
  id: string;
  group: ZaicodeSoundGroup;
  label: string;
  hint: string;
  /** Pictogram key (see ZaicodeSoundSettings glyphs). */
  glyph: string;
  sound: string;
  enabled: boolean;
  gainDb: number;
}

const fp = (file: string) => `fastprompter:${file}`;

export const ZAICODE_SOUND_EVENTS: readonly ZaicodeSoundEventDef[] = [
  // Agent state (the former cue table)
  { id: "agent.done", group: "Agent", label: "Turn finished", hint: "A session finished its turn", glyph: "check", sound: "default", enabled: true, gainDb: 0 },
  { id: "agent.failed", group: "Agent", label: "Turn failed", hint: "A session ended with an error", glyph: "cross", sound: fp("alert_warn01b.wav"), enabled: true, gainDb: 0 },
  { id: "agent.question", group: "Agent", label: "Question", hint: "An agent asks you something or wants a plan approved", glyph: "question", sound: fp("beep_cyoa_pda_beep2.wav"), enabled: true, gainDb: 0 },
  { id: "agent.human", group: "Agent", label: "Human needed", hint: "An agent needs your permission to continue", glyph: "hand", sound: fp("alert_system_msg.wav"), enabled: true, gainDb: 0 },
  { id: "agent.update", group: "Agent", label: "Progress update", hint: "A progress or feedback update arrived", glyph: "dot", sound: fp("blip1.wav"), enabled: false, gainDb: -6 },
  { id: "agent.started", group: "Agent", label: "Work started", hint: "A session started working after everything was idle", glyph: "play", sound: fp("activated.wav"), enabled: false, gainDb: -6 },
  { id: "audit.start", group: "Agent", label: "Audit started", hint: "An A3 audit was started (Audits)", glyph: "play", sound: fp("mm_queue.wav"), enabled: true, gainDb: -6 },
  { id: "audit.plan", group: "Agent", label: "Audit planned", hint: "An A3 audit was planned without starting it", glyph: "plus", sound: fp("item_store_add_to_cart.wav"), enabled: true, gainDb: -8 },
  { id: "audit.waveDone", group: "Agent", label: "Audit wave done", hint: "One wave of an audit finished its report", glyph: "step", sound: fp("success_scored.wav"), enabled: true, gainDb: -6 },
  { id: "audit.complete", group: "Agent", label: "Audit finished", hint: "All three waves are done and the handoff is written", glyph: "check", sound: fp("success_vote_success.wav"), enabled: true, gainDb: -4 },
  { id: "audit.blocked", group: "Agent", label: "Audit stopped", hint: "An audit wave failed or its report was incomplete", glyph: "warn", sound: fp("warn3.wav"), enabled: true, gainDb: -4 },
  { id: "audit.cancel", group: "Agent", label: "Audit cancelled", hint: "An audit was cancelled", glyph: "cross", sound: fp("record_scratch_stop.wav"), enabled: true, gainDb: -8 },
  { id: "changes.heal", group: "Agent", label: "Lines added (heal)", hint: "The Changes counter went up: a green +N floats like healing (Highlights -> Change numbers)", glyph: "plus", sound: fp("Pickup_Health_Generic_1.wav"), enabled: true, gainDb: -10 },
  { id: "changes.damage", group: "Agent", label: "Lines removed (damage)", hint: "The Changes counter lost lines: a red -N flies off like damage", glyph: "cross", sound: fp("hit_crit_hit_mini2.wav"), enabled: true, gainDb: -10 },
  { id: "changes.spawn", group: "Agent", label: "File spawned", hint: "A file the agent created that did not exist before (RPG Changes)", glyph: "plus", sound: fp("Pickup_Health_Generic_1.wav"), enabled: false, gainDb: -8 },
  // Sessions
  { id: "session.new", group: "Sessions", label: "New session", hint: "A new session or draft was created", glyph: "plus", sound: fp("ui_new.wav"), enabled: true, gainDb: -3 },
  { id: "session.open", group: "Sessions", label: "Open session", hint: "You switched to another session", glyph: "swap", sound: fp("button1.wav"), enabled: false, gainDb: -6 },
  { id: "session.archive", group: "Sessions", label: "Archive", hint: "A session or project was archived", glyph: "box", sound: fp("chest_closed.wav"), enabled: true, gainDb: -3 },
  { id: "session.restore", group: "Sessions", label: "Restore / undo archive", hint: "An archived session came back", glyph: "undo", sound: fp("chest_open.wav"), enabled: true, gainDb: -3 },
  { id: "session.rename", group: "Sessions", label: "Rename", hint: "A session got a new title", glyph: "pen", sound: fp("click_soft.wav"), enabled: true, gainDb: -6 },
  { id: "session.pin", group: "Sessions", label: "Pin / unpin", hint: "A session was pinned or unpinned", glyph: "pin", sound: fp("click_tactile_click.wav"), enabled: true, gainDb: -6 },
  // Composer / SAIPEN strip
  { id: "composer.send", group: "Composer", label: "Send prompt", hint: "A prompt was sent", glyph: "send", sound: fp("whoosh_short_whoosh.wav"), enabled: false, gainDb: -8 },
  { id: "saipen.start", group: "Composer", label: "START", hint: "START (goal cc all) was pressed", glyph: "play", sound: fp("com_go.wav"), enabled: true, gainDb: -4 },
  { id: "saipen.step", group: "Composer", label: "STEP", hint: "STEP (cc) was pressed", glyph: "step", sound: fp("menu_mnu_next.wav"), enabled: true, gainDb: -4 },
  { id: "saipen.clear", group: "Composer", label: "CLEAR", hint: "CLEAR was pressed", glyph: "cross", sound: fp("ui_clear.wav"), enabled: true, gainDb: -4 },
  { id: "saipen.mode", group: "Composer", label: "Mode button", hint: "A SAIPEN mode (WIKI, HUNT, ...) was launched", glyph: "grid", sound: fp("menu_launch_select1.wav"), enabled: true, gainDb: -4 },
  // Sidebar
  { id: "sidebar.project", group: "Sidebar", label: "Switch project", hint: "You opened another project", glyph: "folder", sound: fp("HORSE00.wav"), enabled: true, gainDb: -21.5 },
  { id: "sidebar.drop", group: "Sidebar", label: "Drag & drop", hint: "A project or session was dropped into a new place", glyph: "move", sound: fp("pop_up_08.wav"), enabled: true, gainDb: -6 },
  { id: "sidebar.mode", group: "Sidebar", label: "Group / Project view", hint: "The sidebar switched between Group and Project view", glyph: "list", sound: fp("menu_mnu_click.wav"), enabled: true, gainDb: -8 },
  { id: "sidebar.collapse", group: "Sidebar", label: "Fold / unfold", hint: "A project group was folded or unfolded", glyph: "fold", sound: fp("click_mouse_click2.wav"), enabled: false, gainDb: -10 },
  // Window
  { id: "window.snap", group: "Window", label: "Snap to zone", hint: "Ctrl+Q placed the window into a zone", glyph: "grid", sound: fp("pop_up_02.wav"), enabled: true, gainDb: -3 },
  { id: "window.picker", group: "Window", label: "Zone picker", hint: "The Ctrl+Q zone picker opened", glyph: "grid", sound: fp("menu_launch_upmenu1.wav"), enabled: true, gainDb: -8 },
  { id: "window.preset", group: "Window", label: "Save window preset", hint: "A window position was saved as a preset", glyph: "save", sound: fp("ui_save.wav"), enabled: true, gainDb: -4 },
  { id: "window.drag", group: "Window", label: "Right-drag move", hint: "The window was moved with the right mouse button", glyph: "move", sound: fp("whoosh_digital_small_whoosh.wav"), enabled: false, gainDb: -10 },
  // Engines, workers, limits, autostart
  { id: "engine.select", group: "Engines", label: "Pick engine", hint: "An engine (subscription or model pool) was selected", glyph: "engine", sound: fp("menu_launch_glow1.wav"), enabled: true, gainDb: -6 },
  { id: "worker.launch", group: "Engines", label: "Worker started", hint: "A subscription CLI started as a worker", glyph: "play", sound: fp("rocket_pack_boosters_ready.wav"), enabled: true, gainDb: -6 },
  { id: "worker.exit", group: "Engines", label: "Worker finished", hint: "A worker CLI exited normally", glyph: "check", sound: fp("sentry_finish.wav"), enabled: true, gainDb: -6 },
  { id: "worker.fail", group: "Engines", label: "Worker crashed", hint: "A worker CLI exited with an error", glyph: "cross", sound: fp("denied.wav"), enabled: true, gainDb: -4 },
  { id: "worker.fix", group: "Engines", label: "Troubleshoot", hint: "A one-click fix (login / install) started", glyph: "wrench", sound: fp("anvil_use.wav"), enabled: true, gainDb: -8 },
  { id: "limits.refill", group: "Engines", label: "Quota refilled", hint: "A subscription window reset and has quota again", glyph: "battery", sound: fp("success_powerup.wav"), enabled: true, gainDb: -4 },
  { id: "limits.low", group: "Engines", label: "Quota low", hint: "A subscription window dropped under 20%", glyph: "warn", sound: fp("pop_cartoon_pop.wav"), enabled: true, gainDb: -4 },
  { id: "limits.refresh", group: "Engines", label: "Limits refreshed", hint: "A manual quota refresh finished", glyph: "refresh", sound: fp("recharged.wav"), enabled: false, gainDb: -10 },
  { id: "autostart.fire", group: "Engines", label: "Autostart fired", hint: "A scheduled autostart launched its worker", glyph: "clock", sound: fp("NEWDAY.wav"), enabled: true, gainDb: -6 },
  { id: "autostart.missed", group: "Engines", label: "Autostart missed", hint: "A scheduled autostart missed its window", glyph: "clock", sound: fp("warn1.wav"), enabled: true, gainDb: -6 },
  // SAIMAIL
  { id: "saimail.new", group: "SAIMAIL", label: "New letter", hint: "A new SAIMAIL letter arrived", glyph: "mail", sound: fp("downmail.wav"), enabled: true, gainDb: -2 },
  { id: "saimail.open", group: "SAIMAIL", label: "Open inbox", hint: "The SAIMAIL inbox opened", glyph: "mail", sound: fp("NetricsaMessageOpen.wav"), enabled: true, gainDb: -6 },
  // Interface
  { id: "ui.settings", group: "Interface", label: "Settings", hint: "Settings opened", glyph: "gear", sound: fp("panel_open.wav"), enabled: true, gainDb: -8 },
  { id: "ui.copy", group: "Interface", label: "Copy", hint: "Something was copied to the clipboard", glyph: "copy", sound: fp("pop.wav"), enabled: true, gainDb: -8 },
  { id: "ui.hotkey", group: "Interface", label: "Keyboard shortcut", hint: "A keyboard shortcut ran an app command (Settings -> Keyboard)", glyph: "key", sound: fp("menu_mnu_click.wav"), enabled: false, gainDb: -10 },
  { id: "ui.toggle", group: "Interface", label: "Switch on / off", hint: "A ZAICODE switch was flipped", glyph: "toggle", sound: fp("switch_toggle.wav"), enabled: true, gainDb: -10 },
  { id: "ui.button", group: "Interface", label: "Button click", hint: "An ordinary button without its own cue was pressed", glyph: "dot", sound: fp("click_tactile_click.wav"), enabled: true, gainDb: -16 },
  { id: "ui.select", group: "Interface", label: "Selection changed", hint: "A dropdown or radio choice changed", glyph: "list", sound: fp("menu_mnu_click.wav"), enabled: true, gainDb: -14 },
  { id: "ui.contextMenu", group: "Interface", label: "Context menu", hint: "A context menu was requested", glyph: "grid", sound: fp("menu_launch_upmenu1.wav"), enabled: true, gainDb: -12 },
  { id: "todo.tick", group: "Interface", label: "Todo done", hint: "A todo item completed", glyph: "check", sound: fp("tick_on.wav"), enabled: true, gainDb: -8 },
  { id: "problip.goal", group: "Interface", label: "Problip goal", hint: "The problip counter reached a round number", glyph: "star", sound: fp("success_levelup.wav"), enabled: true, gainDb: -4 },
  // Orchestra (SRC-060): every kind of control has its own voice. One listener
  // per kind (installZaicodeDeclarativeSounds); a control with its own cue wins.
  { id: "ui.tab", group: "Orchestra", label: "Tab", hint: "A tab was picked (Agents & tasks, Scheduler, Audits, ...)", glyph: "list", sound: fp("click_hint.wav"), enabled: true, gainDb: -12 },
  { id: "ui.menuItem", group: "Orchestra", label: "Menu item", hint: "An entry in a menu or list was picked", glyph: "list", sound: fp("menu_launch_select1.wav"), enabled: true, gainDb: -14 },
  { id: "ui.menuOpen", group: "Orchestra", label: "Menu opens", hint: "A button that opens a menu, a list or a panel was pressed", glyph: "grid", sound: fp("menu1.wav"), enabled: true, gainDb: -14 },
  { id: "ui.checkOn", group: "Orchestra", label: "Tick on", hint: "A tick box was ticked", glyph: "check", sound: fp("tick_on.wav"), enabled: true, gainDb: -12 },
  { id: "ui.checkOff", group: "Orchestra", label: "Tick off", hint: "A tick box was cleared", glyph: "cross", sound: fp("tick_off.wav"), enabled: true, gainDb: -12 },
  { id: "ui.slider", group: "Orchestra", label: "Slider", hint: "A slider was let go at a new value", glyph: "dot", sound: fp("blip2.wav"), enabled: true, gainDb: -16 },
  { id: "ui.link", group: "Orchestra", label: "Link", hint: "A link was followed", glyph: "swap", sound: fp("click_soft.wav"), enabled: true, gainDb: -12 },
  { id: "ui.expand", group: "Orchestra", label: "Unfold", hint: "A section, row or panel was unfolded", glyph: "fold", sound: fp("menu_launch_dnmenu1.wav"), enabled: true, gainDb: -14 },
  { id: "ui.collapse", group: "Orchestra", label: "Fold", hint: "A section, row or panel was folded", glyph: "fold", sound: fp("click_mouse_click2.wav"), enabled: true, gainDb: -14 },
  { id: "ui.dialogOpen", group: "Orchestra", label: "Window opens", hint: "A dialog or panel appeared by itself (after your own click the click sound plays instead)", glyph: "box", sound: fp("wpn_hudon.wav"), enabled: true, gainDb: -12 },
  { id: "ui.dialogClose", group: "Orchestra", label: "Window closes", hint: "A dialog or panel went away by itself", glyph: "box", sound: fp("wpn_hudoff.wav"), enabled: true, gainDb: -12 },
  { id: "ui.denied", group: "Orchestra", label: "Not available", hint: "You pressed a control that is switched off right now", glyph: "cross", sound: fp("menu_launch_deny1.wav"), enabled: true, gainDb: -12 },
  { id: "ui.paste", group: "Orchestra", label: "Paste", hint: "Something was pasted", glyph: "copy", sound: fp("pop1.wav"), enabled: true, gainDb: -12 },
  { id: "ui.toast", group: "Orchestra", label: "Notice", hint: "A notice popped up in the corner (not right after your own click)", glyph: "dot", sound: fp("notify_notification.wav"), enabled: true, gainDb: -14 },
  { id: "ui.escape", group: "Orchestra", label: "Esc", hint: "Esc was pressed (close, cancel)", glyph: "undo", sound: fp("whoosh_short_whoosh2.wav"), enabled: false, gainDb: -14 },
  { id: "ui.hover", group: "Orchestra", label: "Hover", hint: "The pointer moved onto a button", glyph: "dot", sound: fp("cs_style/buttonrollover.wav"), enabled: false, gainDb: -22 },
  { id: "ui.typing", group: "Orchestra", label: "Typing", hint: "A key was typed into a text field (typewriter)", glyph: "key", sound: fp("type_key_1.wav"), enabled: false, gainDb: -20 },
  // SAIPEGGLE (SRC-062): the game's own voices; the peg hits climb a scale within a shot.
  { id: "saipeggle.shoot", group: "SAIPEGGLE", label: "Cannon fires", hint: "SAIPEGGLE: a ball leaves the cannon", glyph: "play", sound: fp("pop_lavapop.wav"), enabled: true, gainDb: -8 },
  { id: "saipeggle.peg", group: "SAIPEGGLE", label: "Peg hit", hint: "SAIPEGGLE: a peg lights up (each hit of a shot one note higher)", glyph: "dot", sound: fp("chime_bell_ding1.wav"), enabled: true, gainDb: -10 },
  { id: "saipeggle.clear", group: "SAIPEGGLE", label: "Lit pegs pop", hint: "SAIPEGGLE: the lit pegs of a shot disappear", glyph: "dot", sound: fp("pop1.wav"), enabled: true, gainDb: -16 },
  { id: "saipeggle.power", group: "SAIPEGGLE", label: "Green peg power", hint: "SAIPEGGLE: a green peg gives the master's power", glyph: "star", sound: fp("menu_launch_glow1.wav"), enabled: true, gainDb: -6 },
  { id: "saipeggle.bucket", group: "SAIPEGGLE", label: "Free ball (bucket)", hint: "SAIPEGGLE: the ball lands in the moving bucket", glyph: "check", sound: fp("coin_kaching.wav"), enabled: true, gainDb: -6 },
  { id: "saipeggle.freeBall", group: "SAIPEGGLE", label: "Free ball (score)", hint: "SAIPEGGLE: one shot scored 25,000 / 75,000 / 125,000", glyph: "plus", sound: fp("success_powerup.wav"), enabled: true, gainDb: -6 },
  { id: "saipeggle.style", group: "SAIPEGGLE", label: "Style shot", hint: "SAIPEGGLE: a Long Shot", glyph: "star", sound: fp("success_scored.wav"), enabled: true, gainDb: -6 },
  { id: "saipeggle.lost", group: "SAIPEGGLE", label: "Ball lost", hint: "SAIPEGGLE: the ball fell past the bucket", glyph: "cross", sound: fp("blip_cbar_miss1.wav"), enabled: true, gainDb: -12 },
  { id: "saipeggle.fever", group: "SAIPEGGLE", label: "Extreme Fever", hint: "SAIPEGGLE: the last orange peg is hit", glyph: "star", sound: fp("chime_twinkle1.wav"), enabled: true, gainDb: -4 },
  { id: "saipeggle.feverBucket", group: "SAIPEGGLE", label: "Fever bucket", hint: "SAIPEGGLE: the ball lands in a 10K / 50K / 100K bucket", glyph: "check", sound: fp("coin_mvm_money_pickup.wav"), enabled: true, gainDb: -4 },
  { id: "saipeggle.win", group: "SAIPEGGLE", label: "Level clear", hint: "SAIPEGGLE: every orange peg is gone", glyph: "check", sound: fp("success_levelup.wav"), enabled: true, gainDb: -4 },
  { id: "saipeggle.fail", group: "SAIPEGGLE", label: "Out of balls", hint: "SAIPEGGLE: no balls left, orange pegs remain", glyph: "warn", sound: fp("record_scratch_stop.wav"), enabled: true, gainDb: -8 },
  { id: "saipeggle.wall", group: "SAIPEGGLE", label: "Wall bounce", hint: "SAIPEGGLE: the ball bounces off a side wall", glyph: "dot", sound: fp("he_bounce-1.wav"), enabled: false, gainDb: -18 },

  // Wave 3, part C: the agent-action cues join the SAME table, in the same
  // Agent group, with the same row controls (sound, pool, gain, mix).
  ...zaicodeActionCueEvents(),
];

const EVENT_BY_ID = new Map(ZAICODE_SOUND_EVENTS.map((event) => [event.id, event]));

export const ZAICODE_SOUND_GAIN_MIN = -24;
export const ZAICODE_SOUND_GAIN_MAX = 12;

export interface ZaicodeSoundEventSetting {
  enabled: boolean;
  /** The single sound, in Single mode; the fallback in Pool mode. */
  sound: string;
  gainDb: number;
  /**
   * Wave 3: automatic loudness compensation, dB, ON TOP of the operator's own
   * gainDb. Kept apart so "Undo normalization" can drop it without touching
   * what the operator picked or how loud they asked for it.
   */
  normalizeDb: number;
  /** replace = stop this event's previous sound first; overlay = let them mix. */
  mode: "overlay" | "replace";
  /** single = one sound; pool = a weighted set, one of which plays each time. */
  soundMode: ZaicodeSoundSelectionMode;
  /** Only consulted in pool mode; shares come from normalizing the weights. */
  pool: ZaicodePoolEntry[];
}

export const ZAICODE_SOUND_SELECTION_MODES = ["single", "pool"] as const;
export type ZaicodeSoundSelectionMode = (typeof ZAICODE_SOUND_SELECTION_MODES)[number];

/** Every gain that plays is the operator's gain plus the automatic compensation. */
export function zaicodeEffectiveGainDb(row: Pick<ZaicodeSoundEventSetting, "gainDb" | "normalizeDb">): number {
  return row.gainDb + row.normalizeDb;
}

/** What this event will play right now: a pool draw, or the single sound. */
export function zaicodeSoundForEvent(id: string, seed = "default"): string | null {
  const row = readZaicodeSoundSettings().events[id];
  if (!row) return null;
  if (row.soundMode !== "pool" || row.pool.length === 0) return row.sound;
  return pickZaicodePoolSound(row.pool, zaicodeRng(`${id}:${seed}`)) ?? row.sound;
}

/** Every sound an event can reach: its single sound and every usable pool member. */
export function zaicodeSoundsForEvent(id: string): string[] {
  const row = readZaicodeSoundSettings().events[id];
  if (!row) return [];
  return [...new Set([row.sound, ...row.pool.filter((entry) => !entry.missing).map((entry) => entry.id)])];
}

/** The effective probabilities of a pool, exactly as the settings screen shows them. */
export function zaicodePoolSharesForEvent(id: string) {
  const row = readZaicodeSoundSettings().events[id];
  return row ? normalizeZaicodePool(row.pool) : { shares: [], selectable: 0, totalBps: 0 };
}

/** Move one pool entry's weight; the rest of the pool is redistributed around it. */
export function zaicodeSetPoolWeight(id: string, soundId: string, weight: number): void {
  const current = readZaicodeSoundSettings();
  const row = current.events[id];
  if (!row) return;
  const pool = redistributeZaicodePool(row.pool, soundId, weight);
  writeZaicodeSoundSettings(normalizeZaicodeSoundSettings({ ...current, events: { ...current.events, [id]: { ...row, pool } } }));
}

export interface ZaicodeSoundSettings {
  /** 0..100 */
  masterVolume: number;
  muted: boolean;
  /** Also play while the ZAICODE window is focused. */
  whenFocused: boolean;
  /**
   * SRC-062: interface sounds (buttons, menus, sidebar, sessions, window) cut
   * each other instead of piling up: a new one fades the one still ringing.
   * Agent, engine and mail sounds always mix.
   */
  interfaceOneAtATime: boolean;
  /**
   * How a sound meets the ones still ringing: mix (at most `overlapLimit` at
   * once), queue (one after another, at most `overlapLimit` waiting) or cut
   * (the new one fades the rest). Previews, SAIPEGGLE and the background
   * (Problip, Ambience) keep their own rules.
   */
  overlap: ZaicodeSoundOverlap;
  overlapLimit: number;
  events: Record<string, ZaicodeSoundEventSetting>;
}

export function isZaicodeInterfaceSound(id: string): boolean {
  const group = EVENT_BY_ID.get(id)?.group;
  return group !== undefined && isZaicodeChokeGroup(group);
}

export const STORAGE_KEY = "zaicode-sound-events-v1";
export const LEGACY_CUES_KEY = "zaicode-cues-v1";
export const CHANGE_EVENT = "zaicode-sound-events-changed";

function normalizeStoredPool(raw: unknown): ZaicodePoolEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: ZaicodePoolEntry[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as { id?: unknown; weight?: unknown; locked?: unknown; missing?: unknown };
    if (typeof value.id !== "string" || !value.id || out.some((candidate) => candidate.id === value.id)) continue;
    out.push({ id: value.id.slice(0, 200), weight: clamp(value.weight, 0, 1000, 1), locked: value.locked === true, missing: value.missing === true });
  }
  return out;
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

export function defaultZaicodeSoundSettings(): ZaicodeSoundSettings {
  const events: Record<string, ZaicodeSoundEventSetting> = {};
  for (const event of ZAICODE_SOUND_EVENTS) {
    events[event.id] = { enabled: event.enabled, sound: event.sound, gainDb: event.gainDb, normalizeDb: 0, mode: "overlay", soundMode: "single", pool: [] };
  }
  return {
    masterVolume: 60,
    muted: false,
    whenFocused: true,
    interfaceOneAtATime: true,
    overlap: "mix",
    overlapLimit: ZAICODE_SOUND_LIMIT_MAX,
    events,
  };
}

/** Old per-event cue table (0..100 volume) -> rows of the new table. */
function migrateLegacyCues(raw: unknown, into: ZaicodeSoundSettings): ZaicodeSoundSettings {
  const legacy = raw as { enabled?: unknown; whenFocused?: unknown; events?: Record<string, { enabled?: unknown; sound?: unknown; volume?: unknown }> } | null;
  if (!legacy || typeof legacy !== "object") return into;
  const next = { ...into, events: { ...into.events } };
  if (legacy.enabled === false) next.muted = true;
  if (typeof legacy.whenFocused === "boolean") next.whenFocused = legacy.whenFocused;
  for (const [cue, value] of Object.entries(legacy.events ?? {})) {
    const id = `agent.${cue}`;
    const current = next.events[id];
    if (!current || !value) continue;
    const volume = clamp(value.volume, 0, 100, 60);
    next.events[id] = {
      ...current,
      enabled: typeof value.enabled === "boolean" ? value.enabled : current.enabled,
      // "custom" was the file imported for this cue; it keeps playing as the row's own file.
      sound:
        value.sound === "custom"
          ? `custom:${id}`
          : typeof value.sound === "string" && value.sound
            ? value.sound
            : current.sound,
      gainDb: volume <= 0 ? ZAICODE_SOUND_GAIN_MIN : Math.round(20 * Math.log10(volume / 60)),
    };
  }
  return next;
}

export function normalizeZaicodeSoundSettings(raw: unknown): ZaicodeSoundSettings {
  const base = defaultZaicodeSoundSettings();
  if (!raw || typeof raw !== "object") return base;
  const record = raw as Partial<ZaicodeSoundSettings>;
  const events = { ...base.events };
  for (const [id, value] of Object.entries(record.events ?? {})) {
    const current = events[id];
    if (!current || !value || typeof value !== "object") continue;
    events[id] = {
      enabled: typeof value.enabled === "boolean" ? value.enabled : current.enabled,
      sound: typeof value.sound === "string" && value.sound ? value.sound : current.sound,
      gainDb: Math.round(clamp(value.gainDb, ZAICODE_SOUND_GAIN_MIN, ZAICODE_SOUND_GAIN_MAX, current.gainDb) * 2) / 2,
      normalizeDb: Math.round(clamp(value.normalizeDb, ZAICODE_SOUND_GAIN_MIN, ZAICODE_SOUND_GAIN_MAX, 0) * 2) / 2,
      mode: value.mode === "replace" ? "replace" : "overlay",
      soundMode: value.soundMode === "pool" ? "pool" : "single",
      pool: normalizeStoredPool(value.pool),
    };
  }
  return {
    masterVolume: Math.round(clamp(record.masterVolume, 0, 100, base.masterVolume)),
    muted: record.muted === true,
    whenFocused: record.whenFocused !== false,
    interfaceOneAtATime: record.interfaceOneAtATime !== false,
    overlap: normalizeZaicodeSoundOverlap(record.overlap),
    overlapLimit: normalizeZaicodeSoundLimit(record.overlapLimit),
    events,
  };
}

let cached: ZaicodeSoundSettings | null = null;

export function readZaicodeSoundSettings(): ZaicodeSoundSettings {
  if (cached) return cached;
  const stored = readZaicodeSetting(STORAGE_KEY);
  if (stored) {
    try {
      cached = migrateProjectSwitchCue(normalizeZaicodeSoundSettings(JSON.parse(stored)));
      return cached;
    } catch {
      // fall through to defaults
    }
  }
  let legacy: unknown = null;
  try {
    legacy = JSON.parse(readZaicodeSetting(LEGACY_CUES_KEY) ?? "null");
  } catch {
    legacy = null;
  }
  cached = migrateLegacyCues(legacy, defaultZaicodeSoundSettings());
  return cached;
}

export function writeZaicodeSoundSettings(next: ZaicodeSoundSettings): void {
  cached = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // applies for this window anyway
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function setZaicodeSoundSettings(patch: Partial<Omit<ZaicodeSoundSettings, "events">>): void {
  writeZaicodeSoundSettings(normalizeZaicodeSoundSettings({ ...readZaicodeSoundSettings(), ...patch }));
}

export function setZaicodeSoundEvent(id: string, patch: Partial<ZaicodeSoundEventSetting>): void {
  const current = readZaicodeSoundSettings();
  const row = current.events[id];
  if (!row) return;
  writeZaicodeSoundSettings(normalizeZaicodeSoundSettings({ ...current, events: { ...current.events, [id]: { ...row, ...patch } } }));
}

export function setAllZaicodeSoundEvents(enabled: boolean): void {
  const current = readZaicodeSoundSettings();
  const events: Record<string, ZaicodeSoundEventSetting> = {};
  for (const [id, row] of Object.entries(current.events)) events[id] = { ...row, enabled };
  writeZaicodeSoundSettings({ ...current, events });
}

export function resetZaicodeSoundSettings(): void {
  writeZaicodeSoundSettings(defaultZaicodeSoundSettings());
}

// SRC-051: the project-switch cue shipped disabled by default, so "switch
// project" stayed silent unless the operator had found the sound table first.
// One-time migration: a stored table from before this change gets the cue on;
// anything the operator explicitly set afterwards is never touched again.
const PROJECT_SWITCH_MIGRATION_KEY = "zaicode-sound-project-switch-on";
export function migrateProjectSwitchCue(into: ZaicodeSoundSettings): ZaicodeSoundSettings {
  if (typeof localStorage === "undefined") return into;
  if (localStorage.getItem(PROJECT_SWITCH_MIGRATION_KEY) === "1") return into;
  try {
    localStorage.setItem(PROJECT_SWITCH_MIGRATION_KEY, "1");
  } catch {
    return into;
  }
  const row = into.events["sidebar.project"];
  if (!row || row.enabled) return into;
  return { ...into, events: { ...into.events, "sidebar.project": { ...row, enabled: true } } };
}

export function useZaicodeSoundSettings(): ZaicodeSoundSettings {
  return useSyncExternalStore(
    (listener) => {
      window.addEventListener(CHANGE_EVENT, listener);
      return () => window.removeEventListener(CHANGE_EVENT, listener);
    },
    readZaicodeSoundSettings,
    readZaicodeSoundSettings,
  );
}

export function zaicodeSoundEventDef(id: string): ZaicodeSoundEventDef | undefined {
  return EVENT_BY_ID.get(id);
}
