import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { ZaicodeAuditProgressChip } from "../src/zaicode/ZaicodeAuditProgressChip.js";
import { zaicodeProjectDoneMark } from "../src/zaicode/zaicodeProjectDone.js";
import {
  ZAICODE_SIDEBAR_DEFAULT_PREFS,
  normalizeZaicodeSidebarPrefs,
} from "../src/zaicode/zaicodeSidebarPrefs.js";

// T-288 (SRC-201): "the operator must be able to decide for themselves whether
// they need the A3 marks at all".
//
// Two displays carry A3 on a project row: the "A3 x/y" wave chip and the audit
// offer inside the DONE mark. One durable preference (showAuditMarks) hides
// both, and hides nothing else -- the audit centre, the Audits bar entry and
// the row menu keep opening audits either way.

const clean = { doing: 0, todo: 0, done: 12, blocked: 0 };
const done = { state: "done" as const };
const progress = { campaigns: 1, complete: 1, total: 3 };

const chip = (props: Parameters<typeof ZaicodeAuditProgressChip>[0]) =>
  renderToStaticMarkup(createElement(ZaicodeAuditProgressChip, props));

test("the A3 marks are shown until the operator switches them off", () => {
  assert.equal(ZAICODE_SIDEBAR_DEFAULT_PREFS.showAuditMarks, true);
  // A stored profile that predates the switch keeps the marks: the default is on.
  assert.equal(normalizeZaicodeSidebarPrefs(null).showAuditMarks, true);
  assert.equal(normalizeZaicodeSidebarPrefs({ compact: false }).showAuditMarks, true);
  // Only a real boolean answer turns them off; junk keeps the default.
  assert.equal(normalizeZaicodeSidebarPrefs({ showAuditMarks: false }).showAuditMarks, false);
  assert.equal(normalizeZaicodeSidebarPrefs({ showAuditMarks: "off" }).showAuditMarks, true);
  // The switch never disturbs a neighbour it shares the store with.
  const off = normalizeZaicodeSidebarPrefs({ showAuditMarks: false, compact: false });
  assert.equal(off.compact, false);
  assert.equal(off.projectFreshness, ZAICODE_SIDEBAR_DEFAULT_PREFS.projectFreshness);
});

test("the A3 wave chip is hidden only by the operator's own answer", () => {
  const shown = chip({ progress, running: false, projectOff: false, showMarks: true });
  assert.match(shown, /data-zaicode-a3-progress="1\/3"/);
  assert.match(shown, /A3 1\/3/);

  assert.equal(chip({ progress, running: false, projectOff: false, showMarks: false }), "");
  // A project with no campaign has nothing to show, switch or no switch.
  assert.equal(chip({ progress: null, running: false, projectOff: false, showMarks: true }), "");
  // A switched-off project shows no quiet audit state...
  assert.equal(chip({ progress, running: false, projectOff: true, showMarks: true }), "");
  // ...but a RUNNING audit is the one fact it still reports (SRC-062) ...
  const runningOff = chip({ progress, running: true, projectOff: true, showMarks: true });
  assert.match(runningOff, /data-zaicode-a3-running="1"/);
  // ...and the operator's switch is still the last word.
  assert.equal(chip({ progress, running: true, projectOff: true, showMarks: false }), "");
});

test("switching the marks off keeps the DONE mark and drops only the audit offer", () => {
  const base = { verdict: done, board: clean, parked: 0, campaigns: [], stateUpdatedAt: Date.UTC(2026, 8, 5) };
  const offered = zaicodeProjectDoneMark(base);
  assert.ok(offered);
  assert.equal(offered.offerA3, true, "nothing on the row was audited yet, so an audit would see something new");
  assert.match(offered.title, /Click to plan an A3 audit wave/);

  const hidden = zaicodeProjectDoneMark({ ...base, showA3Offer: false });
  assert.ok(hidden, "the DONE mark itself is not a display preference: SAIPEN's own verdict still shows");
  assert.equal(hidden.offerA3, false);
  assert.doesNotMatch(hidden.title, /plan an A3/);
  assert.match(hidden.title, /done and clean/);
  // Explicit true is the same answer as omitting it.
  assert.equal(zaicodeProjectDoneMark({ ...base, showA3Offer: true })?.offerA3, true);
});
