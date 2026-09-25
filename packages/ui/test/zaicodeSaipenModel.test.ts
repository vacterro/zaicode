import assert from "node:assert/strict";
import test from "node:test";
import {
  parseSaipenBoard,
  parseSaipenLastAction,
  parseSaipenState,
} from "../src/zaicode/zaicodeSaipenModel.js";

test("parseSaipenState reads phase, ticket, next action and hides blocker none", () => {
  const state = parseSaipenState(
    '---\nphase: SCOUT\ntask: T-18\nnext_action: "PHASE SCOUT T-18"\nblocker: none\nupdated: "2026-09-24T04:36:02Z"\n---\n',
  );
  assert.deepEqual(state, {
    phase: "SCOUT",
    task: "T-18",
    nextAction: "PHASE SCOUT T-18",
    blocker: null,
    updated: "2026-09-24T04:36:02Z",
    owner: null,
    generation: null,
  });
  assert.equal(parseSaipenState("blocker: WAIT: operator").blocker, "WAIT: operator");
});

test("parseSaipenBoard counts sections and picks next ticket from TODO then BLOCKED", () => {
  const board = [
    "# Board",
    "## DOING",
    "- [/] T-18 [P1] UI batch | verify: x | owner: a",
    "## TODO",
    "## DONE",
    "- [x] T-15 [P1] done one | verify: y",
    "- [x] T-14 [P1] done two",
    "## BLOCKED",
    "- [ ] T-17 [P1] Paused work | blocker: dep",
  ].join("\n");
  const parsed = parseSaipenBoard(board);
  assert.deepEqual(parsed.doing, { id: "T-18", title: "UI batch" });
  assert.deepEqual(parsed.nextTicket, { id: "T-17", title: "Paused work" });
  assert.deepEqual(parsed.counts, { doing: 1, todo: 0, done: 2, blocked: 1 });
  const withTodo = parseSaipenBoard(`${board}\n## TODO\n- [ ] T-19 next up`);
  assert.equal(withTodo.nextTicket?.id, "T-19");
});

test("parseSaipenLastAction strips the Event Graph skeleton from the last LOG line", () => {
  const log =
    "partial line\n- 24.09.26 04:33 [E-220] [parent: E-219] [T-17] [agent: opencode] [op: checkpoint-1] RUN: SCOUT -- paths verified\n" +
    "- 24.09.26 04:40 [E-224] [parent: E-223] [T-18] [agent: opencode] [op: claim-4] DEC: claimed via SAIOPS -- owner opencode\n";
  assert.deepEqual(parseSaipenLastAction(log), {
    lastAction: "DEC: claimed via SAIOPS -- owner opencode",
    lastActionTime: "04:40",
  });
  assert.deepEqual(parseSaipenLastAction(""), { lastAction: null, lastActionTime: null });
});

test("parseSaipenLastAction shows a repeated event tag once", () => {
  const log =
    "- 24.09.26 07:27 [E-1600] [parent: E-1599] [T-192] [agent: claude] [op: checkpoint-7] RUN: RUN: saipen validate --json -> FAIL\n";
  assert.equal(parseSaipenLastAction(log).lastAction, "RUN: saipen validate --json -> FAIL");
});
