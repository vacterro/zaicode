import assert from "node:assert/strict";
import test from "node:test";
import { saipenBoardShares } from "../src/zaicode/zaicodeSaipenModel.js";
import { ZAICODE_SLOT_GROUPS, slotGroupOf } from "../src/zaicode/zaicodeSidebarPrefs.js";
import { readinessBarColor, todoReadinessRatio } from "../src/zaicode/zaicodeTodoProgress.js";
import { clampZaicodeReasoningLevel } from "../../desktop/src/host/zaicodeRunDispatch.js";

const snapshot = (counts: { doing: number; todo: number; done: number; blocked: number }) => ({
  phase: "BUILD",
  task: "T-1",
  nextAction: null,
  blocker: null,
  updated: null,
  lastAction: null,
  lastActionTime: null,
  doing: null,
  nextTicket: null,
  counts,
});

test("board strip shares: blocked / todo(+doing) / done sum to 1", () => {
  const shares = saipenBoardShares(snapshot({ doing: 1, todo: 1, done: 6, blocked: 2 }));
  assert.ok(shares);
  assert.equal(shares.total, 10);
  assert.equal(shares.blocked, 0.2);
  assert.equal(shares.todo, 0.2);
  assert.equal(shares.done, 0.6);
  assert.equal(saipenBoardShares(snapshot({ doing: 0, todo: 0, done: 0, blocked: 0 })), null);
  assert.equal(saipenBoardShares(null), null);
});

test("priority slots: AUDAPACK groups, unassigned projects sit in MAIN0", () => {
  assert.deepEqual([...ZAICODE_SLOT_GROUPS], ["MAIN0", "MAIN1", "SIDE0", "SIDE1", "SIDE2", "SIDE3"]);
  assert.equal(slotGroupOf({}, "c:/x"), "MAIN0");
  assert.equal(slotGroupOf({ "c:/x": "SIDE1" }, "c:/x"), "SIDE1");
});

test("battlezone readiness: empty todo is dark, finished is green", () => {
  assert.equal(todoReadinessRatio([]), 0);
  assert.equal(
    todoReadinessRatio([
      { status: "completed", content: "a" },
      { status: "inProgress", content: "b" },
    ]),
    0.75,
  );
  assert.match(readinessBarColor(0), /^hsl\(0 /);
  assert.match(readinessBarColor(1), /^hsl\(120 /);
});

test("dispatch clamps a reasoning level the pool does not support", () => {
  const selection = { providerId: "sairoute", modelId: "SAIFREN", options: { reasoningLevel: "high" } };
  assert.equal(
    clampZaicodeReasoningLevel(selection, ["low", "medium"]).options?.reasoningLevel,
    "medium",
  );
  assert.equal(clampZaicodeReasoningLevel(selection, ["none"]).options?.reasoningLevel, "none");
  assert.equal(clampZaicodeReasoningLevel(selection, ["high"]).options?.reasoningLevel, "high");
  assert.equal(clampZaicodeReasoningLevel(selection, undefined), selection);
});
