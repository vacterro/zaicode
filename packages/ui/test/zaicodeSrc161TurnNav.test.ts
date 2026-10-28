// SRC-161:REQ-009 (T-240) -- the paired navigation affordance.
//
// T-236/SRC-139 shipped the assistant half. REQ-009 keeps its rule (one stable row id,
// derived fresh every render, never the text) and adds the operator's own latest
// message on the other side, as an INDEPENDENT target: one side having nothing to offer
// must not decide the other.
//
// The identities below are the whole point of the file: two messages that read exactly
// the same must still navigate to their own rows, and a row that is a userInput without
// being the operator at the keyboard (a goal continuation, a mailbox delivery, a
// background result, a workflow launch) must never be offered as "your last message".
import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantTextRow, UserInputRow } from "@zcode/shared/zcode-protocol-v4";
import {
  isMeaningfulUserInput,
  latestTurnAnchors,
  latestUserMessage,
  type ConversationAnswerSource,
} from "../src/v4/conversationLatestAnswer.js";

function userInput(
  rowId: number,
  text: string,
  origin: UserInputRow["origin"] = "realUser",
  entityId?: string,
): UserInputRow {
  return {
    kind: "userInput",
    rowId,
    turnId: "turn-" + rowId,
    ...(entityId ? { entityId } : {}),
    createdAt: "2026-10-06T00:00:00.000Z",
    createdAtSeq: rowId,
    text,
    origin,
  };
}

function answer(rowId: number, text: string, state: AssistantTextRow["state"] = "complete"): AssistantTextRow {
  return {
    kind: "assistantText",
    rowId,
    turnId: "turn-" + rowId,
    createdAt: "2026-10-06T00:00:00.000Z",
    createdAtSeq: rowId,
    text,
    state,
  };
}

test("SRC-161:REQ-009 the operator's newest message is the anchor, by its own row id", () => {
  const units: ConversationAnswerSource[] = [
    { visibleUserInputs: [userInput(3, "first question")], assistantTextRows: [] },
    { visibleUserInputs: [userInput(11, "second question", "realUser", "u-11")], assistantTextRows: [] },
  ];
  const latest = latestUserMessage(units);
  assert.equal(latest?.rowId, 11, "the jump anchor is the row's own id");
  assert.equal(latest?.identity, "u-11", "entityId is the identity when the frame carries it");
  assert.equal(latest?.unitIndex, 1, "the unit that must be mounted first");
  assert.equal(latest?.preview, "second question");
  assert.equal(latest?.side, "user");
  // No entityId: the rowId is the identity, exactly as on the answer side.
  assert.equal(latestUserMessage([{ visibleUserInputs: [userInput(4, "x")], assistantTextRows: [] }])?.identity, "4");
});

test("SRC-161:REQ-009 identical text in two messages never confuses navigation", () => {
  const text = "yes";
  const units: ConversationAnswerSource[] = [
    { visibleUserInputs: [userInput(5, text)], assistantTextRows: [] },
    { visibleUserInputs: [userInput(9, text)], assistantTextRows: [answer(10, text)] },
  ];
  const anchors = latestTurnAnchors(units);
  assert.equal(anchors.user?.rowId, 9, "the later identical message wins by row id");
  assert.equal(anchors.assistant?.rowId, 10, "and the answer is a different row again");
  assert.equal(anchors.user?.identity, "9");
  assert.equal(anchors.assistant?.identity, "10");
});

test("SRC-161:REQ-009 only the operator's own input is offered as 'your last message'", () => {
  assert.equal(isMeaningfulUserInput(userInput(1, "typed by hand")), true);
  assert.equal(isMeaningfulUserInput(userInput(1, "   \n ")), false, "whitespace is not a message");
  for (const origin of ["backgroundResult", "goalContinuation", "mailbox", "synthetic", "workflowLaunch"] as const) {
    assert.equal(
      isMeaningfulUserInput(userInput(1, "not the operator", origin)),
      false,
      `${origin} is a userInput row, but not a message the operator typed`,
    );
  }
  // A turn whose only userInputs are machine-made offers no user chip at all.
  const units: ConversationAnswerSource[] = [
    { visibleUserInputs: [userInput(2, "continue", "goalContinuation")], assistantTextRows: [answer(3, "done")] },
  ];
  const anchors = latestTurnAnchors(units);
  assert.equal(anchors.user, null, "nothing to navigate to: the chip is not invented");
  assert.equal(anchors.assistant?.rowId, 3, "the other side is unaffected");
});

test("SRC-161:REQ-009 each side is derived on its own", () => {
  // Answer only (the operator has not sent anything in this projection).
  const answerOnly = latestTurnAnchors([{ assistantTextRows: [answer(7, "an answer")] }]);
  assert.equal(answerOnly.user, null);
  assert.equal(answerOnly.assistant?.rowId, 7);
  // Message only (nothing has been answered yet).
  const messageOnly = latestTurnAnchors([{ visibleUserInputs: [userInput(8, "a question")], assistantTextRows: [] }]);
  assert.equal(messageOnly.assistant, null);
  assert.equal(messageOnly.user?.rowId, 8);
  // Neither: no strip at all.
  const neither = latestTurnAnchors([]);
  assert.equal(neither.user, null);
  assert.equal(neither.assistant, null);
  // A unit that carries no user inputs at all (older projection) is not an error.
  assert.equal(latestTurnAnchors([{ assistantTextRows: [answer(1, "x")] }]).user, null);
});

test("SRC-161:REQ-009 a conversation switch resets both sides, because nothing is remembered", () => {
  const before: ConversationAnswerSource[] = [
    { visibleUserInputs: [userInput(1, "in the old conversation")], assistantTextRows: [answer(2, "old answer")] },
  ];
  const after: ConversationAnswerSource[] = [
    { visibleUserInputs: [userInput(40, "in the new one")], assistantTextRows: [answer(41, "new answer")] },
  ];
  assert.equal(latestTurnAnchors(before).user?.rowId, 1);
  const switched = latestTurnAnchors(after);
  assert.equal(switched.user?.rowId, 40, "the anchor is re-derived, never carried over");
  assert.equal(switched.assistant?.rowId, 41);
  // A streaming answer is still not offered (the SRC-139 rule is unchanged).
  assert.equal(
    latestTurnAnchors([{ visibleUserInputs: [userInput(1, "q")], assistantTextRows: [answer(2, "half a sen", "streaming")] }])
      .assistant,
    null,
  );
});
