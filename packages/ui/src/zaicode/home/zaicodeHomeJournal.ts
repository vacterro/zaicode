import { create } from "zustand";

/**
 * SAIHOME's local event journal (T-56). notifyZaicode() is the one place
 * every ZAICODE app event passes through (quota refilled / low, schedule
 * fired / missed, free model added, turn finished / failed, question,
 * SAIMAIL letter); it records the work-relevant ones here before any card
 * or quiet-hours filter, so the timeline shows what happened, not only what
 * was shown. Local only, newest 80 kept.
 */

export interface ZaicodeHomeJournalEvent {
  scenario: string;
  at: number;
  title: string;
  body: string;
}

/** Scenarios that describe work; personal timers, sounds and counters stay out. */
export const ZAICODE_HOME_JOURNAL_SCENARIOS: ReadonlySet<string> = new Set([
  "agent.done",
  "agent.failed",
  "agent.question",
  "agent.human",
  "limits.refill",
  "limits.low",
  "autostart.fire",
  "autostart.missed",
  "router.free",
  "router.ready",
  "saimail.new",
]);

const STORAGE_KEY = "zaicode-home-journal-v1";
const KEEP = 80;

function load(): ZaicodeHomeJournalEvent[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (entry): entry is ZaicodeHomeJournalEvent =>
          Boolean(entry) &&
          typeof (entry as ZaicodeHomeJournalEvent).scenario === "string" &&
          typeof (entry as ZaicodeHomeJournalEvent).at === "number" &&
          typeof (entry as ZaicodeHomeJournalEvent).title === "string",
      )
      .map((entry) => ({ ...entry, body: typeof entry.body === "string" ? entry.body : "" }))
      .slice(-KEEP);
  } catch {
    return [];
  }
}

export const useZaicodeHomeJournal = create<{ events: ZaicodeHomeJournalEvent[] }>(() => ({
  events: typeof localStorage === "undefined" ? [] : load(),
}));

/** Adds one event (ignored for scenarios outside the journal). */
export function recordZaicodeHomeEvent(scenario: string, title: string, body: string, at: number = Date.now()): void {
  if (!ZAICODE_HOME_JOURNAL_SCENARIOS.has(scenario)) return;
  const events = [...useZaicodeHomeJournal.getState().events, { scenario, at, title: title.slice(0, 160), body: body.slice(0, 240) }].slice(-KEEP);
  useZaicodeHomeJournal.setState({ events });
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(events));
  } catch {
    // this session only
  }
}

export function clearZaicodeHomeJournal(): void {
  useZaicodeHomeJournal.setState({ events: [] });
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // nothing stored
  }
}
