// T-188: score the EXACT reading that produced the successful start, old vs new.
// Every number is read out of the packaged app's own cache; the old expression is
// reproduced verbatim from bb6b75f1^.
import {
  markZaicodeWindowsStartingOnUse,
  zaicodeIdleWindowToStart,
} from "file:///V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_ZAICODE/zcode/packages/shared/dist/zaicode-engines.js";

const HOUR = 3_600_000;
const TOLERANCE_MS = 3 * 60_000;
const START = 1791158709691; // the successful start, ms
const CHECKED = 1791158739000; // the sweep that observed it, ~30 s later

const account = { id: "antigravity:default", vendor: "antigravity", status: "ready" };
const config = { keepWindowsRolling: true, hiddenAccounts: [] };

// Verbatim from the packaged instance's cache immediately before the start.
const live = [
  { key: "weekly@gemini_models", rem: 41.758522391319275, resetsAt: Date.UTC(2026, 9, 10, 20, 15, 39), minutes: 10080 },
  { key: "five_hour@gemini_models", rem: 95.80098986625671, resetsAt: Date.UTC(2026, 9, 5, 3, 1, 7), minutes: 300 },
  { key: "weekly@claude_and_gpt_models", rem: 49.577561020851135, resetsAt: Date.UTC(2026, 9, 10, 21, 42, 20), minutes: 10080 },
  { key: "five_hour@claude_and_gpt_models", rem: 99.94872212409973, resetsAt: Date.UTC(2026, 9, 5, 0, 3, 40), minutes: 300 },
];

/** pre-fix: raw number, no rolling recognition. bb6b75f1^ */
function oldIdle(window, readAt) {
  const looksIdle = window.resetsAt !== null && window.durationMinutes > 0 &&
    Math.abs(window.resetsAt - (readAt + window.durationMinutes * 60_000)) <= TOLERANCE_MS;
  const waitingFromCache = window.startsOnUse === true;
  return (looksIdle || waitingFromCache) && !(window.remainingPercent !== null && window.remainingPercent < 100);
}

const toWindow = (w) => ({
  key: w.key, label: w.key, group: w.key.split("@")[1] ?? "", groupLabel: "",
  remainingPercent: w.rem, resetsAt: w.resetsAt, durationMinutes: w.minutes,
  gatedBy: null, assumedFull: false, startsOnUse: false,
});
const snapshot = (windows) => ({
  accountId: account.id, windows, plan: null, fetchedAt: CHECKED, checkedAt: CHECKED, error: null, source: "agy -p /usage",
});

const before = markZaicodeWindowsStartingOnUse(live.map(toWindow), CHECKED, null, null, null);
const target = before.find((w) => w.key === "five_hour@claude_and_gpt_models");
const admitted = zaicodeIdleWindowToStart({ account, snapshot: snapshot(before), config, now: CHECKED });

const out = {
  readAt: new Date(CHECKED).toISOString(),
  successfulStartAt: new Date(START).toISOString(),
  reading: {
    key: target.key,
    remainingPercent: target.remainingPercent,
    renderedPercent: Math.round(target.remainingPercent),
    resetsAt: new Date(target.resetsAt).toISOString(),
    secondsSinceReset: Math.round((CHECKED - target.resetsAt) / 1000),
  },
  oldAdmits: oldIdle({ ...target }, CHECKED),
  newAdmits: admitted !== null,
  newAdmittedKey: admitted?.key ?? null,
  whyOldRefused: [
    `raw ${target.remainingPercent} < 100 so the pre-fix guard !(remainingPercent < 100) is false`,
    "pre-fix has no rolled-over clause, and this vendor never sets startsOnUse, so looksIdle was the only path and it needs |resetsAt - (readAt + 5h)| <= 180000",
    `here that difference is ${Math.round(Math.abs(target.resetsAt - (CHECKED + 300 * 60_000)) / 1000)} s`,
  ],
};
console.log(JSON.stringify(out, null, 2));
process.exit(0);
