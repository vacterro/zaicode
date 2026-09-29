import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  ZAICODE_RUNTIME_STATE_COLOR,
  ZAICODE_WAITING_COLOR,
  isZaicodeHumanBlocker,
  normalizeZaicodeSaipenStatus,
  zaicodeProjectRuntimeState,
  type ZaicodeProjectRuntimeSnapshot,
} from "@zcode/shared";
import { parseSaipenBoard, saipenBoardShares, type ZaicodeSaipenSnapshot } from "../src/zaicode/zaicodeSaipenModel.js";
import { assembleZaicodeProjectRuntime } from "../src/zaicode/zaicodeProjectRuntime.js";

// SRC-081: "let the BLOCKED strip be orange exactly when a HUMAN is awaited, and red only for
// a real BLOCKED"; "an outline for the selected project"; "in the third (MAIN) view the TODO
// meter is shown on the other side too".

const source = (path: string) => readFileSync(join(import.meta.dirname, "../src", path), "utf8");

const BOARD = `# Board
## DOING
- [/] T-116 [P1] doing one | verify: x | owner: a
## TODO
- [ ] T-120 [P2] todo one | verify: y
## DONE
- [x] T-1 [P1] done one | verify: z
## BLOCKED
- [ ] T-9 [P3] interactive desktop E2E | verify: x | blocker: OPERATOR_REQUIRED: needs a human-run desktop session | blocker_scope: ticket
- [ ] T-94 [P1] placement acceptance | verify: x | blocker: OPERATOR_REQUIRED: live multi-monitor acceptance | blocker_scope: ticket
- [ ] T-113 [P1] wave 6 | verify: x | blocker: ACTIVE_DEPENDENCY:T-116 -- PAUSED | blocker_scope: ticket
- [ ] T-200 [P2] failing gate | verify: x | blocker: gate stays red after two fix cycles
`;

test("only a blocker a person can lift counts as waiting for a human", () => {
  for (const human of ["OPERATOR_REQUIRED: needs a desktop session", "WAIT: operator", "WAIT: manual-verify -- run it", "HUMAN_REQUIRED", "awaiting human review"]) {
    assert.equal(isZaicodeHumanBlocker(human), true, human);
  }
  for (const blocked of ["ACTIVE_DEPENDENCY:T-116 -- PAUSED", "gate stays red", "HUMANE handling", "", null, undefined, "DEBT_SNAPSHOT_FOREIGN_PROJECT"]) {
    assert.equal(isZaicodeHumanBlocker(blocked), false, String(blocked));
  }
});

test("the board parse separates tickets that wait for a person from tickets that are BLOCKED", () => {
  const parsed = parseSaipenBoard(BOARD);
  assert.deepEqual(parsed.counts, { doing: 1, todo: 1, done: 1, blocked: 4, humanBlocked: 2 });
  const snapshot: ZaicodeSaipenSnapshot = {
    phase: null, task: null, nextAction: null, blocker: null, updated: null, lastAction: null, lastActionTime: null,
    doing: null, nextTicket: null, counts: parsed.counts,
  };
  const shares = saipenBoardShares(snapshot)!;
  assert.equal(shares.total, 7);
  assert.ok(Math.abs(shares.human - 2 / 7) < 1e-9, "two of seven wait for a person");
  assert.ok(Math.abs(shares.blocked - 2 / 7) < 1e-9, "two of seven are blocked for real");
  assert.ok(Math.abs(shares.blocked + shares.human + shares.todo + shares.done - 1) < 1e-9, "the segments sum to 1");
  // A snapshot without the split (older callers) still draws every blocked ticket red.
  const old = saipenBoardShares({ ...snapshot, counts: { doing: 1, todo: 1, done: 1, blocked: 4 } })!;
  assert.equal(old.human, 0);
  assert.ok(Math.abs(old.blocked - 4 / 7) < 1e-9);
});

function verdictFor(blocker: string | null, waiting = 0) {
  const projection = normalizeZaicodeSaipenStatus(
    { ok: true, phase: "BUILD", task: "T-1", blocker: blocker ?? "none", claimed_ticket: "T-1", board_errors: [], automation: {}, telegrams: { state: "NOT_CONFIGURED" } },
    1,
  )!;
  const saipen: ZaicodeSaipenSnapshot = {
    phase: "BUILD", task: "T-1", nextAction: null, blocker, updated: null, lastAction: null, lastActionTime: null,
    doing: null, nextTicket: null, counts: { doing: 1, todo: 0, done: 0, blocked: 0 }, projection,
  };
  const at = (n: number) => Array.from({ length: n }, () => ({ workspacePath: "V:/proj/" }));
  const runtime: ZaicodeProjectRuntimeSnapshot = assembleZaicodeProjectRuntime({ projectPath: "V:/proj", saipen, running: [], waiting: at(waiting), workers: [] });
  return zaicodeProjectRuntimeState(runtime);
}

test("a project waiting for you is orange; a project really BLOCKED stays red", () => {
  const human = verdictFor("OPERATOR_REQUIRED: acceptance on a Windows desktop");
  assert.equal(human.state, "waiting");
  assert.equal(human.label, "WAITING FOR YOU");
  const hard = verdictFor("ACTIVE_DEPENDENCY:T-9 -- paused");
  assert.equal(hard.state, "blocked");
  assert.equal(ZAICODE_RUNTIME_STATE_COLOR.waiting, ZAICODE_WAITING_COLOR);
  assert.equal(ZAICODE_RUNTIME_STATE_COLOR.blocked, "var(--color-destructive)");
  assert.notEqual(ZAICODE_RUNTIME_STATE_COLOR.waiting, ZAICODE_RUNTIME_STATE_COLOR.blocked);
  // A session waiting for an answer is a person needed, too.
  assert.equal(verdictFor(null, 1).state, "waiting");
});

test("the sidebar row: orange segment for a human, red for BLOCKED; the open project is outlined; MAIN shows its TODO meter on the top edge", () => {
  const row = source("WorkspaceSidebarItem.tsx");
  assert.match(row, /data-zaicode-board-human/);
  assert.match(row, /background: ZAICODE_WAITING_COLOR/);
  assert.match(row, /data-zaicode-board-blocked/);
  const selected = /isZaicodeProductMode\(\) &&\s*isActiveWorkspace &&\s*"[^"]*outline[^"]*"/.exec(row);
  assert.ok(selected, "the open project's row carries an outline class");
  assert.match(row, /data-zaicode-project-selected=/);
  const meter = /data-zaicode-main-todo-meter=\{zaicodeMainTask\.taskId\}/.exec(row);
  assert.ok(meter, "MAIN's own TODO meter is drawn on the project row");
  const before = row.slice(Math.max(0, meter!.index - 400), meter!.index);
  assert.match(before, /top-0/, "the meter sits on the top edge, opposite the bottom board strip");
  assert.match(row, /ZaicodeTodoMiniGauge/);
});
