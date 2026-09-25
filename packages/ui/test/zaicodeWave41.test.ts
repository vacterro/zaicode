import assert from "node:assert/strict";
import test from "node:test";
import { normalizeZaicodeSaipenStatus, zaicodeProjectRuntimeState, type ZaicodeProjectRuntimeSnapshot } from "@zcode/shared";
import { parseSaipenState, type ZaicodeSaipenSnapshot } from "../src/zaicode/zaicodeSaipenModel.js";
import { assembleZaicodeProjectRuntime, sameZaicodeProjectPath, zaicodeSaipenHeadline } from "../src/zaicode/zaicodeProjectRuntime.js";

/** Shape of `saipen status --json` (SAIPEN 8.0.1), trimmed to what the read model reads. */
const STATUS = {
  ok: true,
  protocol_version: "8.0.1",
  phase: "VERIFY",
  task: "T-39",
  next_action: "PHASE VERIFY T-39",
  computed_next_action: "PHASE VERIFY T-39",
  blocker: "none",
  claimed_ticket: "T-39",
  top_workable_ticket: "T-10",
  board_errors: [],
  recovery_pending: false,
  recovery_conflict: false,
  parked_work: ["T-9 blocked: OPERATOR_REQUIRED: interactive desktop E2E"],
  automation: { closure_complete: false },
  telegrams: { state: "NOT_CONFIGURED", detail: "set SAIMAIL_WORKSPACE" },
};

const FILES: ZaicodeSaipenSnapshot = {
  phase: "BUILD",
  task: "T-3",
  nextAction: null,
  blocker: null,
  updated: null,
  lastAction: null,
  lastActionTime: null,
  doing: { id: "T-3", title: "x" },
  nextTicket: null,
  counts: { doing: 1, todo: 1, done: 2, blocked: 0 },
};

function snapshot(saipen: ZaicodeSaipenSnapshot | null, extra: { running?: number; waiting?: number; workers?: number } = {}): ZaicodeProjectRuntimeSnapshot {
  const at = (n = 0) => Array.from({ length: n }, () => ({ workspacePath: "V:\\proj" }));
  return assembleZaicodeProjectRuntime({
    projectPath: "V:/proj/",
    saipen,
    running: at(extra.running),
    waiting: at(extra.waiting),
    workers: Array.from({ length: extra.workers ?? 0 }, () => ({ projectPath: "v:\\PROJ", exitCode: null })),
  });
}

test("saipen status --json becomes the protocol projection; 'none' and NOT_CONFIGURED read as absent", () => {
  const projection = normalizeZaicodeSaipenStatus(STATUS, 1);
  assert.equal(projection?.source, "saipen");
  assert.equal(projection?.blocker, null);
  assert.equal(projection?.claimedTicket, "T-39");
  assert.equal(projection?.closureComplete, false);
  assert.equal(projection?.unreadTelegrams, null);
  assert.equal(projection?.parkedWork.length, 1);
  assert.equal(normalizeZaicodeSaipenStatus({ ok: false }, 1), null);
  assert.equal(normalizeZaicodeSaipenStatus("junk", 1), null);
});

test("one verdict: blocked and waiting before running, running before open work, done only when SAIPEN says so", () => {
  const projection = normalizeZaicodeSaipenStatus(STATUS, 1)!;
  const withProjection = { ...FILES, projection };
  // Open Work but nothing runs: pending, not "working" (the old tint said working).
  assert.equal(zaicodeProjectRuntimeState(snapshot(withProjection)).state, "pending");
  // Something runs for this project (paths compared case/slash-insensitively).
  assert.equal(zaicodeProjectRuntimeState(snapshot(withProjection, { running: 1 })).state, "working");
  assert.equal(zaicodeProjectRuntimeState(snapshot(withProjection, { workers: 2 })).state, "working");
  // A session waiting for the human outranks running work.
  assert.equal(zaicodeProjectRuntimeState(snapshot(withProjection, { running: 1, waiting: 1 })).state, "waiting");
  // SAIPEN's blocker / recovery / board errors outrank everything.
  const blocked = { ...withProjection, projection: { ...projection, blocker: "WAIT: operator" } };
  assert.equal(zaicodeProjectRuntimeState(snapshot(blocked, { running: 1 })).state, "blocked");
  const recovering = { ...withProjection, projection: { ...projection, recoveryPending: true } };
  assert.equal(zaicodeProjectRuntimeState(snapshot(recovering)).label, "RECOVERY");
  // Done comes from SAIPEN's closure, even when the files still show BLOCKED tickets.
  const closed = { ...withProjection, projection: { ...projection, claimedTicket: null, topWorkableTicket: null, closureComplete: true } };
  const done = zaicodeProjectRuntimeState(snapshot(closed));
  assert.equal(done.state, "done");
  assert.equal(done.label, "DONE · 1 parked");
  // No .saipen/: idle.
  assert.equal(zaicodeProjectRuntimeState(snapshot(null)).state, "idle");
});

test("without SAIPEN's projection the files decide conservatively and say so", () => {
  const verdict = snapshot(FILES);
  assert.equal(verdict.protocol?.source, "files");
  assert.equal(zaicodeProjectRuntimeState(verdict).state, "pending");
  const finished = snapshot({ ...FILES, doing: null, counts: { doing: 0, todo: 0, done: 4, blocked: 1 } });
  assert.equal(zaicodeProjectRuntimeState(finished).state, "done");
  const empty = snapshot({ ...FILES, doing: null, counts: { doing: 0, todo: 0, done: 0, blocked: 0 } });
  assert.equal(zaicodeProjectRuntimeState(empty).state, "idle");
});

test("owner and generation come from STATE; paths compare like Windows does", () => {
  const state = parseSaipenState('---\nphase: BUILD\ntask: T-1\nagent: claude-code\nlast_event: 614\nblocker: none\n---\n');
  assert.equal(state.owner, "claude-code");
  assert.equal(state.generation, 614);
  assert.equal(sameZaicodeProjectPath("V:\\A\\b\\", "v:/a/B"), true);
  assert.equal(sameZaicodeProjectPath("V:/a", "V:/ab"), false);
});

test("surface headlines print SAIPEN's projection, the file parse only without it", () => {
  const files = zaicodeSaipenHeadline({ ...FILES, nextAction: "PHASE BUILD T-3", nextTicket: { id: "T-4", title: "four" } });
  assert.equal(files?.nextAction, "PHASE BUILD T-3");
  assert.equal(files?.nextTicket?.id, "T-4");
  const projection = normalizeZaicodeSaipenStatus(STATUS, 1)!;
  const headline = zaicodeSaipenHeadline({
    ...FILES,
    nextTicket: { id: "T-4", title: "four" },
    projection,
    detail: {
      state: [],
      tickets: [{ id: "T-10", section: "TODO", priority: "P3", title: "delegation", fields: {} }],
      log: [],
    },
  });
  assert.equal(headline?.phase, "VERIFY");
  assert.equal(headline?.task, "T-39");
  assert.equal(headline?.nextAction, "PHASE VERIFY T-39");
  assert.equal(headline?.blocker, null);
  // SAIPEN's top workable ticket, titled from BOARD; never the claimed ticket twice.
  assert.deepEqual(headline?.nextTicket, { id: "T-10", title: "delegation" });
  const same = zaicodeSaipenHeadline({ ...FILES, projection: { ...projection, topWorkableTicket: "T-39" } });
  assert.equal(same?.nextTicket, null);
  assert.equal(zaicodeSaipenHeadline(null), null);
});
