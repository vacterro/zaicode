// T-188: does the real post-roll Antigravity reading admit a window?
//
// Every number below was READ OUT of the packaged isolated app's own cache at
// 2026-10-04T22:05:38Z (.saipen/evidence/T-188-packaged-acceptance.json), from
// `agy -p /usage` on the operator's own signed-in account. Nothing here is invented.
// The old admission expression is reproduced verbatim from pre-fix zaicode-engines.ts
// so the same reading can be scored both ways.

import {
  markZaicodeWindowsStartingOnUse,
  zaicodeIdleWindowToStart,
} from "file:///V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_ZAICODE/zcode/packages/shared/dist/zaicode-engines.js";

const HOUR = 3_600_000;
const TOLERANCE_MS = 3 * 60_000;
const ROLL = Date.UTC(2026, 9, 4, 22, 1, 7); // the real vendor reset, measured
const CHECKED = Date.UTC(2026, 9, 4, 22, 5, 38, 573); // when the app actually read it

const account = { id: "antigravity:default", vendor: "antigravity", status: "ready" };
const config = { keepWindowsRolling: true, hiddenAccounts: [] };

/** Exactly the two live windows the packaged app saw, verbatim. */
const live = [
  { key: "weekly@gemini_models", rem: 42.447736859321594, resetsAt: Date.UTC(2026, 9, 10, 20, 15, 39), minutes: 10080 },
  { key: "five_hour@gemini_models", rem: 99.93627071380615, resetsAt: ROLL + 5 * HOUR, minutes: 300 },
  { key: "weekly@claude_and_gpt_models", rem: 49.60319995880127, resetsAt: Date.UTC(2026, 9, 10, 21, 42, 20), minutes: 10080 },
  { key: "five_hour@claude_and_gpt_models", rem: 99.94872212409973, resetsAt: Date.UTC(2026, 9, 5, 0, 3, 40), minutes: 300 },
];

const toWindow = (w) => ({
  key: w.key, label: w.key, group: w.key.split("@")[1] ?? "", groupLabel: "",
  remainingPercent: w.rem, resetsAt: w.resetsAt, durationMinutes: w.minutes,
  gatedBy: null, assumedFull: false, startsOnUse: false,
});

/** pre-fix admission: the raw number, no rounding, and a rolling vendor unrecognised. */
function oldIdle(window, readAt, previousStart) {
  const looksIdle = window.resetsAt !== null && window.durationMinutes > 0 &&
    Math.abs(window.resetsAt - (readAt + window.durationMinutes * 60_000)) <= TOLERANCE_MS;
  const durationMs = window.durationMinutes * 60_000;
  const anchoredAfterStart = previousStart?.ok === true && window.resetsAt !== null &&
    readAt - previousStart.at >= 10_000 && readAt - previousStart.at < durationMs &&
    window.resetsAt > readAt && window.resetsAt <= previousStart.at + durationMs + 5_000;
  const waitingFromCache = window.startsOnUse === true && !anchoredAfterStart;
  return (looksIdle || waitingFromCache) && window.remainingPercent >= 100 && !anchoredAfterStart;
}

// The reading exactly as the app held it.
const snapshot = (windows) => ({
  accountId: account.id, windows, plan: null, fetchedAt: CHECKED, checkedAt: CHECKED, error: null, source: "agy -p /usage",
});

const windows = markZaicodeWindowsStartingOnUse(live.map(toWindow), CHECKED);
const admitted = zaicodeIdleWindowToStart({ account, snapshot: snapshot(windows), config, now: CHECKED });
const fiveHour = windows.find((w) => w.key === "five_hour@gemini_models");
const oldAdmits = oldIdle({ ...fiveHour }, CHECKED, null);

// How wide is the vendor's own idle shape? It only holds for TOLERANCE_MS after a roll.
const sweepOffsets = [20, 40, 60, 120, 180, 240, 269, 271, 300, 600].map((s) => {
  const readAt = ROLL + s * 1000;
  const w = { ...fiveHour, resetsAt: ROLL + 5 * HOUR };
  const marked = markZaicodeWindowsStartingOnUse([toWindow(live[1])], readAt);
  const fresh = zaicodeIdleWindowToStart({ account, snapshot: snapshot(marked), config, now: readAt });
  return {
    secondsAfterRoll: s,
    oldAdmits: oldIdle({ ...w }, readAt, null),
    newAdmits: fresh !== null,
  };
});

const result = {
  readAt: new Date(CHECKED).toISOString(),
  roll: new Date(ROLL).toISOString(),
  liveReading: { key: fiveHour.key, remainingPercent: fiveHour.remainingPercent, resetsAt: new Date(fiveHour.resetsAt).toISOString() },
  oldAdmitsAtThisReading: oldAdmits,
  newAdmitsAtThisReading: admitted !== null,
  admittedKey: admitted?.key ?? null,
  sweepOffsets,
};
console.log(JSON.stringify(result, null, 2));