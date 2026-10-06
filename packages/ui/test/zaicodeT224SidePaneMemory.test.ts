/**
 * T-224 / SRC-154:R003 — the right SAIPEN/task side pane (Ctrl+Alt+B) keeps a
 * persisted visibility policy, not an in-memory shrug.
 *
 * Two modes: `everywhere` (one global answer for every project and session)
 * and `perOwner` (each project/session remembers its own answer). Every claim
 * here runs against the pure policy plus the real prefs normalizer, which is
 * the exact restart path: `load()` parses the stored JSON through
 * `normalizeZaicodeUiPrefs`, so a JSON round-trip IS a restart.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  normalizeZaicodeUiPrefs,
  ZAICODE_UI_DEFAULT_PREFS,
  type ZaicodeUiPrefs,
} from "@/zaicode/zaicodeUiPrefs.js";
import {
  clearZaicodeSidePaneVisibilityMemory,
  normalizeZaicodeSidePaneVisibility,
  persistedSidePaneCollapsedFor,
  pruneZaicodeSidePaneVisibility,
  resolveZaicodeSidePaneVisibility,
  sidePaneVisibilityOwnerKey,
  toggleZaicodeSidePaneVisibility,
  zaicodeSidePaneVisibilityScopeLabel,
  ZAICODE_SIDE_PANE_DRAFT_OWNER_KEY,
  ZAICODE_SIDE_PANE_VISIBILITY_DEFAULT,
  ZAICODE_SIDE_PANE_VISIBILITY_MAX_OWNERS,
  type ZaicodeSidePaneVisibilityPrefs,
} from "@/zaicode/zaicodeSidePaneVisibility.js";

const prefs = (
  visibility: Partial<ZaicodeSidePaneVisibilityPrefs> = {},
): ZaicodeSidePaneVisibilityPrefs => ({
  ...ZAICODE_SIDE_PANE_VISIBILITY_DEFAULT,
  ...visibility,
});

const uiPrefs = (
  visibility: Partial<ZaicodeSidePaneVisibilityPrefs> = {},
): ZaicodeUiPrefs => ({
  ...ZAICODE_UI_DEFAULT_PREFS,
  sidePaneVisibility: prefs(visibility),
});


/** A restart: what the store writes is JSON, what it reads is the normalizer. */
const restart = (before: ZaicodeUiPrefs): ZaicodeUiPrefs =>
  normalizeZaicodeUiPrefs(JSON.parse(JSON.stringify(before)));

const ownerA = sidePaneVisibilityOwnerKey({ sessionId: "session-a", workspaceKey: "proj-A" });
const ownerB = sidePaneVisibilityOwnerKey({ sessionId: "session-b", workspaceKey: "proj-B" });

test("R003: everywhere open stays open across A -> B -> A", () => {
  const p = prefs({ mode: "everywhere", everywhere: true });
  assert.equal(resolveZaicodeSidePaneVisibility(p, ownerA, false), true);
  assert.equal(resolveZaicodeSidePaneVisibility(p, ownerB, false), true);
  assert.equal(resolveZaicodeSidePaneVisibility(p, ownerA, false), true);
});

test("R003: everywhere closed stays closed across A -> B -> A", () => {
  const p = prefs({ mode: "everywhere", everywhere: false });
  assert.equal(resolveZaicodeSidePaneVisibility(p, ownerA, true), false);
  assert.equal(resolveZaicodeSidePaneVisibility(p, ownerB, true), false);
  assert.equal(resolveZaicodeSidePaneVisibility(p, ownerA, true), false);
});

test("R003: per-owner A open / B closed, and back to A needs no toggle", () => {
  let p = prefs({ mode: "perOwner", everywhere: false });
  p = { ...p, ...toggleZaicodeSidePaneVisibility(p, ownerA, false) };
  assert.equal(resolveZaicodeSidePaneVisibility(p, ownerA, false), true);
  assert.equal(resolveZaicodeSidePaneVisibility(p, ownerB, false), false);
  assert.equal(resolveZaicodeSidePaneVisibility(p, ownerA, false), true);
});

test("R003: sessions in one project keep their own answers", () => {
  const first = sidePaneVisibilityOwnerKey({ sessionId: "s1", workspaceKey: "proj" });
  const second = sidePaneVisibilityOwnerKey({ sessionId: "s2", workspaceKey: "proj" });
  assert.notEqual(first, second, "sessions must not collapse into one owner");
  let p = prefs({ mode: "perOwner" });
  p = { ...p, ...toggleZaicodeSidePaneVisibility(p, first, false) };
  assert.equal(resolveZaicodeSidePaneVisibility(p, first, false), true);
  assert.equal(resolveZaicodeSidePaneVisibility(p, second, false), false);
});

test("R003: a sessionless pane belongs to its project, not to every draft", () => {
  const draftA = sidePaneVisibilityOwnerKey({ workspaceKey: "proj-A" });
  const draftB = sidePaneVisibilityOwnerKey({ workspaceKey: "proj-B" });
  assert.notEqual(draftA, draftB);
  assert.notEqual(draftA, ZAICODE_SIDE_PANE_DRAFT_OWNER_KEY);
  let p = prefs({ mode: "perOwner" });
  p = { ...p, ...toggleZaicodeSidePaneVisibility(p, draftA, false) };
  assert.equal(resolveZaicodeSidePaneVisibility(p, draftA, false), true);
  assert.equal(resolveZaicodeSidePaneVisibility(p, draftB, false), false);
});

test("R003: restart keeps both the mode and every remembered answer", () => {
  let visibility = prefs({ mode: "perOwner" });
  visibility = { ...visibility, ...toggleZaicodeSidePaneVisibility(visibility, ownerA, false) };
  const after = restart(uiPrefs(visibility));
  assert.equal(after.sidePaneVisibility.mode, "perOwner");
  assert.equal(resolveZaicodeSidePaneVisibility(after.sidePaneVisibility, ownerA, false), true);
  assert.equal(resolveZaicodeSidePaneVisibility(after.sidePaneVisibility, ownerB, false), false);

  const global = restart(uiPrefs({ mode: "everywhere", everywhere: true }));
  assert.equal(resolveZaicodeSidePaneVisibility(global.sidePaneVisibility, ownerA, false), true);
  assert.equal(resolveZaicodeSidePaneVisibility(global.sidePaneVisibility, ownerB, false), true);
});

test("R003: a rename keeps the answer while the canonical id is stable", () => {
  const beforeMove = sidePaneVisibilityOwnerKey({
    sessionId: "session-a",
    workspaceKey: "/old/path/proj",
  });
  const afterMove = sidePaneVisibilityOwnerKey({
    sessionId: "session-a",
    workspaceKey: "/new/path/proj",
  });
  assert.equal(beforeMove, afterMove, "the session id is the identity, not the path");
  let p = prefs({ mode: "perOwner" });
  p = { ...p, ...toggleZaicodeSidePaneVisibility(p, beforeMove, false) };
  assert.equal(resolveZaicodeSidePaneVisibility(p, afterMove, false), true);
});

test("R003: deleted owners are cleaned up without touching the survivors", () => {
  const p = prefs({ mode: "perOwner", byOwner: { [ownerA]: true, [ownerB]: false } });
  const patch = pruneZaicodeSidePaneVisibility(p, new Set([ownerA]));
  assert.deepEqual(patch, { byOwner: { [ownerA]: true } });
  const kept = { ...p, ...patch };
  assert.equal(resolveZaicodeSidePaneVisibility(kept, ownerA, false), true);
});

test("R003: the map cannot grow without bound; dead owners age out", () => {
  const byOwner: Record<string, boolean> = {};
  for (let i = 0; i < ZAICODE_SIDE_PANE_VISIBILITY_MAX_OWNERS + 5; i += 1) {
    byOwner[`owner-${i}`] = i % 2 === 0;
  }
  const normalized = normalizeZaicodeSidePaneVisibility({ mode: "perOwner", byOwner });
  assert.equal(Object.keys(normalized.byOwner).length, ZAICODE_SIDE_PANE_VISIBILITY_MAX_OWNERS);
  assert.equal(normalized.byOwner["owner-0"], undefined, "the oldest answer ages out first");
  assert.equal(typeof normalized.byOwner[`owner-${ZAICODE_SIDE_PANE_VISIBILITY_MAX_OWNERS + 4}`], "boolean");
});

test("R003: everywhere -> perOwner -> everywhere loses nothing", () => {
  let p = prefs({ mode: "everywhere", everywhere: true, byOwner: { [ownerA]: false } });
  p = { ...p, mode: "perOwner" };
  assert.equal(resolveZaicodeSidePaneVisibility(p, ownerA, true), false, "the per-owner answer shows");
  p = { ...p, mode: "everywhere" };
  assert.equal(resolveZaicodeSidePaneVisibility(p, ownerA, true), true, "the global answer is intact");
  assert.equal(resolveZaicodeSidePaneVisibility(p, ownerB, true), true);
  assert.equal(p.byOwner[ownerA], false, "the per-owner answer is still stored");
});

test("R003: a toggle writes its own scope and nothing else", () => {
  const global = prefs({ mode: "everywhere", everywhere: true, byOwner: { [ownerA]: false } });
  assert.deepEqual(toggleZaicodeSidePaneVisibility(global, ownerB, true), { everywhere: false });
  assert.equal(global.byOwner[ownerA], false, "untouched scope is untouched");

  const perOwner = prefs({ mode: "perOwner", everywhere: true, byOwner: { [ownerA]: false } });
  const patch = toggleZaicodeSidePaneVisibility(perOwner, ownerB, true);
  assert.deepEqual(patch, { byOwner: { [ownerA]: false, [ownerB]: false } });
  assert.equal(perOwner.everywhere, true, "the global answer survives a per-owner toggle");
});

test("R003: garbage in storage falls back instead of poisoning the pane", () => {
  const normalized = normalizeZaicodeSidePaneVisibility({
    mode: "everywhere-at-once",
    everywhere: "yes",
    byOwner: { good: true, bad: "no", "  ": false },
  });
  assert.equal(normalized.mode, "everywhere");
  assert.equal(normalized.everywhere, null);
  assert.deepEqual(normalized.byOwner, { good: true });
  assert.equal(resolveZaicodeSidePaneVisibility(normalized, ownerA, true), true, "fresh pane with content shows");
  assert.equal(resolveZaicodeSidePaneVisibility(normalized, ownerA, false), false, "fresh empty pane stays shut");
});

test("R003: the collapsed flag the app reads matches the visible answer", () => {
  assert.equal(persistedSidePaneCollapsedFor(prefs({ mode: "everywhere", everywhere: true }), ownerA), false);
  assert.equal(persistedSidePaneCollapsedFor(prefs({ mode: "everywhere", everywhere: false }), ownerA), true);
  assert.equal(persistedSidePaneCollapsedFor(prefs({ mode: "everywhere", everywhere: null }), ownerA), undefined);
  const perOwner = prefs({ mode: "perOwner", byOwner: { [ownerA]: true } });
  assert.equal(persistedSidePaneCollapsedFor(perOwner, ownerA), false);
  assert.equal(persistedSidePaneCollapsedFor(perOwner, ownerB), undefined);
});

test("R003: the scope label always says whose answer this is", () => {
  assert.equal(zaicodeSidePaneVisibilityScopeLabel(prefs({ mode: "everywhere" }), ownerA), "Everywhere");
  assert.equal(
    zaicodeSidePaneVisibilityScopeLabel(prefs({ mode: "perOwner" }), ownerA),
    "Not set for this one yet",
  );
  const set = prefs({ mode: "perOwner", byOwner: { [ownerA]: true } });
  assert.equal(zaicodeSidePaneVisibilityScopeLabel(set, ownerA), "This project/session");
});

test("R003: forgetting wipes the answers but keeps the mode", () => {
  const p = prefs({ mode: "perOwner", everywhere: true, byOwner: { [ownerA]: true } });
  const cleared = { ...p, ...clearZaicodeSidePaneVisibilityMemory() };
  assert.deepEqual(cleared.byOwner, {});
  assert.equal(cleared.everywhere, null);
  assert.equal(cleared.mode, "perOwner");
});

test("R003: the settings surface names both modes in plain words", () => {
  const layout = readFileSync(join(import.meta.dirname, "../src/settings/ZaicodeLayoutSettings.tsx"), "utf8");
  assert.match(layout, /testId="side-pane-memory"/, "the policy has its own block");
  assert.match(layout, /Ctrl\+Alt\+B/, "the toggle that owns the pane is named");
  assert.match(layout, /ZAICODE_SIDE_PANE_VISIBILITY_MODES/, "both modes are offered from the model");
  assert.match(layout, /ZAICODE_SIDE_PANE_VISIBILITY_LABELS/, "the wording comes from the model, not copy-paste");
  assert.match(
    layout,
    /each project and session remembers its own/,
    "per-owner behavior is spelled out, not implied",
  );
});

test("R003: the toggle and the restores all go through the persisted policy", () => {
  const panels = readFileSync(join(import.meta.dirname, "../src/hooks/useAppPanels.ts"), "utf8");
  assert.match(panels, /persistSidePaneVisible\(/, "writes go through one helper");
  assert.match(panels, /persistedSidePaneCollapsed\(/, "reads go through one helper");
  assert.equal(
    (panels.match(/persistedSidePaneCollapsed\(/g) ?? []).length >= 3,
    true,
    "init, workspace switch and owner switch all consult the policy",
  );
  assert.match(panels, /sidePaneVisibilityOwnerKey/, "the canonical owner key is used, not a new id");
  assert.doesNotMatch(panels, /localStorage\.setItem\("side-pane/, "no second store beside the settings mechanism");
});

test("R003: the preference rides the existing settings snapshot, not memory alone", () => {
  const prefsSrc = readFileSync(join(import.meta.dirname, "../src/zaicode/zaicodeUiPrefs.ts"), "utf8");
  assert.match(prefsSrc, /sidePaneVisibility: ZaicodeSidePaneVisibilityPrefs/);
  assert.match(prefsSrc, /normalizeZaicodeSidePaneVisibility\(r\.sidePaneVisibility\)/);
});
