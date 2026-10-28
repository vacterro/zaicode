import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  ZAICODE_UI_DEFAULT_PREFS,
  normalizeZaicodeUiPrefs,
  zaicodeAutoRetryEffectiveLabel,
  zaicodeAutoRetryEffectivePatch,
  zaicodeAutoRetryEffectiveScope,
  zaicodeAutoRetryEnabled,
  zaicodeAutoRetryPatch,
  type ZaicodeUiPrefs,
} from "../src/zaicode/zaicodeUiPrefs.js";

const prefs = (over: Partial<ZaicodeUiPrefs> = {}): ZaicodeUiPrefs => ({
  ...ZAICODE_UI_DEFAULT_PREFS,
  ...over,
});

const apply = (base: ZaicodeUiPrefs, patch: Partial<ZaicodeUiPrefs>): ZaicodeUiPrefs =>
  normalizeZaicodeUiPrefs({ ...base, ...patch });

// Fresh REQ-001 regression matrix: the primary control toggles the EFFECTIVE answer.

test("fresh REQ-001: global OFF -> ON and ON -> OFF through the effective scope", () => {
  const off = prefs({ autoRetry: false });
  assert.equal(zaicodeAutoRetryEffectiveScope(off, "p1"), "global");
  assert.equal(zaicodeAutoRetryEnabled(off, "p1"), false);
  const on = apply(off, zaicodeAutoRetryEffectivePatch(off, "p1", true));
  assert.equal(zaicodeAutoRetryEnabled(on, "p1"), true);

  const back = apply(on, zaicodeAutoRetryEffectivePatch(on, "p1", false));
  assert.equal(zaicodeAutoRetryEnabled(back, "p1"), false);
});

test("fresh REQ-001: inherited global state is spelled out, never a bare Global default", () => {
  assert.equal(zaicodeAutoRetryEffectiveLabel(prefs({ autoRetry: false }), "p9"), "Inherited: Global OFF");
  assert.equal(zaicodeAutoRetryEffectiveLabel(prefs({ autoRetry: true }), "p9"), "Inherited: Global ON");
  assert.equal(zaicodeAutoRetryEffectiveScope(prefs({ autoRetry: true }), "p9"), "global");
});

test("fresh REQ-001: project override ON/OFF is owned by the project scope", () => {
  const overridden = prefs({ autoRetry: true, autoRetryProjects: { p1: false } });
  assert.equal(zaicodeAutoRetryEffectiveScope(overridden, "p1"), "project");
  assert.equal(zaicodeAutoRetryEffectiveLabel(overridden, "p1"), "This project");
  assert.equal(zaicodeAutoRetryEnabled(overridden, "p1"), false);

  // The reported bug: editing scope says global while the project override decides.
  const editingGlobal = prefs({ autoRetry: true, autoRetryScope: "global", autoRetryProjects: { p1: false } });
  const wrongPatch = zaicodeAutoRetryPatch(editingGlobal, "p1", true);
  assert.deepEqual(wrongPatch, { autoRetry: true }, "old editing-scope patch writes the global flag");
  assert.equal(
    zaicodeAutoRetryEnabled(apply(editingGlobal, wrongPatch), "p1"),
    false,
    "old patch leaves the effective answer unchanged: the visible press does nothing",
  );

  const fixed = apply(editingGlobal, zaicodeAutoRetryEffectivePatch(editingGlobal, "p1", true));
  assert.equal(zaicodeAutoRetryEnabled(fixed, "p1"), true, "effective patch flips the answer the user sees");
  assert.deepEqual(fixed.autoRetryProjects, { p1: true });

  const offAgain = apply(fixed, zaicodeAutoRetryEffectivePatch(fixed, "p1", false));
  assert.equal(zaicodeAutoRetryEnabled(offAgain, "p1"), false);
});

test("fresh REQ-001: clear override returns to the inherited state", () => {
  const overridden = prefs({ autoRetry: false, autoRetryProjects: { p1: true } });
  assert.equal(zaicodeAutoRetryEnabled(overridden, "p1"), true);
  const clearedProjects = { ...overridden.autoRetryProjects };
  delete clearedProjects.p1;
  const cleared = apply(overridden, { autoRetryProjects: clearedProjects });
  assert.equal(zaicodeAutoRetryEffectiveScope(cleared, "p1"), "global");
  assert.equal(zaicodeAutoRetryEnabled(cleared, "p1"), false);
  assert.equal(zaicodeAutoRetryEffectiveLabel(cleared, "p1"), "Inherited: Global OFF");
});

test("fresh REQ-001: session override wins over project and global", () => {
  const base = prefs({ autoRetry: true, autoRetryProjects: { p1: false }, autoRetrySessions: { s1: true } });
  assert.equal(zaicodeAutoRetryEffectiveScope(base, "p1", "s1"), "session");
  assert.equal(zaicodeAutoRetryEffectiveLabel(base, "p1", "s1"), "This session");
  assert.equal(zaicodeAutoRetryEnabled(base, "p1", "s1"), true);

  const flipped = apply(base, zaicodeAutoRetryEffectivePatch(base, "p1", false, "s1"));
  assert.equal(zaicodeAutoRetryEnabled(flipped, "p1", "s1"), false);
  assert.equal(flipped.autoRetrySessions.s1, false);
  // Other sessions and projects are untouched.
  assert.equal(zaicodeAutoRetryEnabled(flipped, "p1"), false);
  assert.equal(zaicodeAutoRetryEnabled(flipped, "p2"), true);
});

test("fresh REQ-001: persisted prefs round-trip (reload/restart preserves the answer)", () => {
  const base = prefs({ autoRetry: false, autoRetryProjects: { p1: true }, autoRetrySessions: { s1: false } });
  const roundTripped = normalizeZaicodeUiPrefs(JSON.parse(JSON.stringify(base)));
  assert.equal(zaicodeAutoRetryEnabled(roundTripped, "p1"), true);
  assert.equal(zaicodeAutoRetryEnabled(roundTripped, "p1", "s1"), false);
  assert.equal(zaicodeAutoRetryEnabled(roundTripped, "p2"), false);
});

test("fresh REQ-001: button derives every surface from the same effective state with a bounded pending guard", () => {
  const source = readFileSync(new URL("../src/zaicode/ZaicodeAutoRetryButton.tsx", import.meta.url), "utf8");
  // SRC-162: the click flips the EFFECTIVE answer through the shared toggle rule.
  assert.match(source, /zaicodeAutoRetryToggle\(prefs, projectKey, sessionId, effective\)/);
  assert.match(source, /zaicodeAutoRetryEffectiveScope\(prefs, projectKey, sessionId\)/);
  assert.match(source, /zaicodeAutoRetryEffectiveLabel\(prefs, projectKey, sessionId\)/);
  assert.doesNotMatch(source, /zaicodeAutoRetryPatch\(prefs, projectKey, !effective\.preference/);
  assert.match(source, /lockRef/);
  assert.match(source, /data-zaicode-auto-retry-pending/);
  assert.match(source, /Saving auto retry/);
  assert.match(source, /Auto retry save failed/);
  assert.match(source, /Inherited: Global/);
  assert.match(source, /\{effectiveLabel\}/);
  assert.doesNotMatch(source, /onKeyDown/, "native button activation is the keyboard path; a manual handler would double-fire on Space");
  assert.doesNotMatch(source, /zaicodeAutoRetryScopeNext/, "no editing-scope selector may remain: the toggle writes the effective scope");
  assert.match(source, /Remove this override and inherit/);
});
