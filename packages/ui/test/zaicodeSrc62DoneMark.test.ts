import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { zaicodeProjectDoneMark } from "../src/zaicode/zaicodeProjectDone.js";

// SRC-062: "separate DONE indicators -- a special one when the project is
// fully done by SAIPEN and has a clean board, with an offer to run an A3 audit
// wave then; smart, no frills".

const clean = { doing: 0, todo: 0, done: 12, blocked: 0 };
const done = { state: "done" as const };
const day = (n: number) => Date.UTC(2026, 8, n);

test("only a DONE with a clean board is special", () => {
  assert.ok(zaicodeProjectDoneMark({ verdict: done, board: clean, parked: 0, campaigns: [], stateUpdatedAt: day(1) }));
  assert.equal(zaicodeProjectDoneMark({ verdict: { state: "pending" }, board: clean, parked: 0, campaigns: [], stateUpdatedAt: 0 }), null);
  assert.equal(zaicodeProjectDoneMark({ verdict: done, board: { ...clean, blocked: 1 }, parked: 0, campaigns: [], stateUpdatedAt: 0 }), null, "a blocked ticket is not clean");
  assert.equal(zaicodeProjectDoneMark({ verdict: done, board: clean, parked: 2, campaigns: [], stateUpdatedAt: 0 }), null, "parked work waits for a human");
  assert.equal(zaicodeProjectDoneMark({ verdict: done, board: { ...clean, todo: 1 }, parked: 0, campaigns: [], stateUpdatedAt: 0 }), null);
  assert.equal(zaicodeProjectDoneMark({ verdict: null, board: clean, parked: 0, campaigns: [], stateUpdatedAt: 0 }), null);
});

test("A3 is offered when it would look at something new, and never twice at once", () => {
  const never = zaicodeProjectDoneMark({ verdict: done, board: clean, parked: 0, campaigns: [], stateUpdatedAt: day(5) })!;
  assert.equal(never.offerA3, true, "never audited");
  assert.equal(never.lastAuditAt, null);
  const auditedAfter = zaicodeProjectDoneMark({
    verdict: done,
    board: clean,
    parked: 0,
    campaigns: [{ status: "complete", updatedAt: new Date(day(6)).toISOString() }],
    stateUpdatedAt: day(5),
  })!;
  assert.equal(auditedAfter.offerA3, false, "audited after the last change: nothing new");
  assert.match(auditedAfter.title, /nothing new to audit/);
  const changedSince = zaicodeProjectDoneMark({
    verdict: done,
    board: clean,
    parked: 0,
    campaigns: [{ status: "complete", updatedAt: new Date(day(4)).toISOString() }],
    stateUpdatedAt: day(5),
  })!;
  assert.equal(changedSince.offerA3, true, "the project changed after its last audit");
  for (const status of ["planned", "running"] as const) {
    const busy = zaicodeProjectDoneMark({
      verdict: done,
      board: clean,
      parked: 0,
      campaigns: [{ status, updatedAt: new Date(day(1)).toISOString() }],
      stateUpdatedAt: day(5),
    })!;
    assert.equal(busy.offerA3, false, `${status}: an audit is already on its way`);
  }
});

test("the row shows the mark, a switched-off row does not, and planned A3 badges are quiet", () => {
  const row = readFileSync(join(import.meta.dirname, "..", "src", "WorkspaceSidebarItem.tsx"), "utf8");
  assert.ok(row.includes("{zaicodeDoneMark && !zaicodeProjectOff ? ("));
  assert.ok(row.includes('useZaicodeWorkspaceTab.getState().setTab("audits")'), "the offer opens the audit centre");
  assert.ok(row.includes("zaicodeAuditProgress && (zaicodeAuditRunning || !zaicodeProjectOff)"));
  const badge = readFileSync(join(import.meta.dirname, "..", "src", "zaicode", "ZaicodeProjectDoneBadge.tsx"), "utf8");
  assert.ok(badge.includes("event.stopPropagation()"), "a click on the mark never opens the project row");
});
