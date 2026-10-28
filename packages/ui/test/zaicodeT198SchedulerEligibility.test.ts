import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  pickZaicodeSchedulerEligibleAccounts,
  zaicodeSchedulerEligible,
  zaicodeSchedulerEligibilityPatch,
} from "../src/zaicode/zaicodeSchedulerEligibility.js";
import { normalizeZaicodeUiPrefs } from "../src/zaicode/zaicodeUiPrefs.js";

const accounts = [{ id: "claude-a" }, { id: "codex-b" }, { id: "antigravity-c" }];

test("SRC-132: Ctrl+Click takes an account off the Scheduler list and puts it back", () => {
  const empty = { schedulerIneligible: {} };
  assert.deepEqual(pickZaicodeSchedulerEligibleAccounts(accounts, empty).map((a) => a.id), ["claude-a", "codex-b", "antigravity-c"]);

  const off = zaicodeSchedulerEligibilityPatch(empty, "codex-b");
  assert.deepEqual(off, { schedulerIneligible: { "codex-b": true } });
  assert.deepEqual(pickZaicodeSchedulerEligibleAccounts(accounts, off).map((a) => a.id), ["claude-a", "antigravity-c"]);

  // A second Ctrl+Click clears the key entirely rather than storing a false.
  assert.deepEqual(zaicodeSchedulerEligibilityPatch(off, "codex-b"), { schedulerIneligible: {} });
});

test("SRC-132: one account's answer never touches another's", () => {
  const one = zaicodeSchedulerEligibilityPatch({ schedulerIneligible: { "antigravity-c": true } }, "claude-a");
  assert.deepEqual(one, { schedulerIneligible: { "antigravity-c": true, "claude-a": true } });
});

test("SRC-132: only an explicit true excludes; anything else stays eligible", () => {
  assert.equal(zaicodeSchedulerEligible({ schedulerIneligible: { a: true } }, "a"), false);
  assert.equal(zaicodeSchedulerEligible({ schedulerIneligible: { a: false } }, "a"), true);
  assert.equal(zaicodeSchedulerEligible({ schedulerIneligible: {} }, "a"), true);
});

test("SRC-132: the answer survives a restart and a poisoned store cannot widen it", () => {
  const saved = normalizeZaicodeUiPrefs({ schedulerIneligible: { "codex-b": true, junk: "yes" } });
  assert.deepEqual(saved.schedulerIneligible, { "codex-b": true });
  assert.equal(zaicodeSchedulerEligible(saved, "codex-b"), false);
  // A store with no answer at all must not exclude anyone.
  assert.equal(zaicodeSchedulerEligible(normalizeZaicodeUiPrefs(null), "codex-b"), true);
});

test("SRC-132: the tile toggles, the Scheduler reads it, and the quota rows stay untouched", () => {
  const views = readFileSync(new URL("../src/zaicode/ZaicodeLimitViews.tsx", import.meta.url), "utf8");
  // Ctrl+Click writes the answer; a plain click falls through to whatever the row did before.
  assert.match(views, /if \(!event\.ctrlKey && !event\.metaKey\) return;/);
  assert.match(views, /store\.update\(zaicodeSchedulerEligibilityPatch\(\{ schedulerIneligible: answers \}, account\.id\)\)/);
  // Telemetry is not conditional on eligibility -- the reading is still there either way.
  assert.match(views, /data-zaicode-scheduler-eligible=\{eligible \? "yes" : "no"\}/);
  assert.doesNotMatch(views, /eligible && snapshot/);

  const panel = readFileSync(new URL("../src/zaicode/ZaicodeSchedulerPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /pickZaicodeSchedulerEligibleAccounts\(\s*engines\.accounts\.filter/);
});