import {
  normalizeZaicodeSoundSettings,
  readZaicodeSoundSettings,
  writeZaicodeSoundSettings,
  type ZaicodeSoundEventSetting,
  type ZaicodeSoundSelectionMode,
} from "./zaicodeSoundSettingsModel.js";
import { heaviestPoolSound, seedPool, togglePoolMember } from "./zaicodeSoundPools.js";

/**
 * What a click in the pool controls does to the stored table (T-127). Each one reads the table at the moment of
 * the click (never a copy the screen drew a moment ago), so two quick clicks cannot undo each other.
 */

function update(eventId: string, change: (row: ZaicodeSoundEventSetting) => Partial<ZaicodeSoundEventSetting>): void {
  const current = readZaicodeSoundSettings();
  const row = current.events[eventId];
  if (!row) return;
  writeZaicodeSoundSettings(normalizeZaicodeSoundSettings({ ...current, events: { ...current.events, [eventId]: { ...row, ...change(row) } } }));
}

/** Adds the sound to the event's pool; a member already there is left as it is (weight, pin). */
export function addZaicodePoolMember(eventId: string, soundId: string): void {
  update(eventId, (row) => (row.pool.some((entry) => entry.id === soundId) ? {} : { pool: togglePoolMember(row.pool, soundId) }));
}

/** Adds the sound to the event's pool, or takes it out when it is a member already. */
export function toggleZaicodePoolMember(eventId: string, soundId: string): void {
  update(eventId, (row) => ({ pool: togglePoolMember(row.pool, soundId) }));
}

/**
 * Single <-> pool. Into a pool the event's sound becomes its first member; back to single the heaviest member becomes
 * the sound. The pool itself is kept, so switching to a pool again brings the same members back.
 */
export function setZaicodeSoundSelectionMode(eventId: string, mode: ZaicodeSoundSelectionMode): void {
  update(eventId, (row) =>
    mode === "pool"
      ? { soundMode: "pool", pool: seedPool(row.pool, row.sound) }
      : { soundMode: "single", sound: heaviestPoolSound(row.pool, row.sound) },
  );
}

/** Takes one member out of the pool. */
export function removeZaicodePoolMember(eventId: string, soundId: string): void {
  update(eventId, (row) => ({ pool: row.pool.filter((entry) => entry.id !== soundId) }));
}

/** Pins a member's share (or lets it go). */
export function toggleZaicodePoolPin(eventId: string, soundId: string): void {
  update(eventId, (row) => ({ pool: row.pool.map((entry) => (entry.id === soundId ? { ...entry, locked: !entry.locked } : entry)) }));
}
