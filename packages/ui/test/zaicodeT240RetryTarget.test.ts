import assert from "node:assert/strict";
import test from "node:test";
import { pickZaicodeAutoRetryAction } from "../src/zaicode/zaicodeAutoRetry.js";

const oldUser = { rowId: 1, kind: "userInput" as const, entityId: "old-user", text: "Same text", actions: { canEdit: true as const } };
const oldAnswer = { rowId: 2, kind: "assistantText" as const, entityId: "old-answer", actions: { canRetry: true as const } };
const latestUser = { rowId: 3, kind: "userInput" as const, entityId: "failed-user", text: "Same text", actions: { canEdit: true as const } };

test("T-240: retry chooses the latest failed user input over a previous answered turn, even with identical text", () => {
  assert.deepEqual(pickZaicodeAutoRetryAction([oldUser, oldAnswer, latestUser]), {
    kind: "edit", target: { rowId: 3, entityId: "failed-user" }, text: "Same text",
  });
});

test("T-240: the current turn's runtime-admitted answer remains the retry target", () => {
  const currentAnswer = { ...oldAnswer, rowId: 4, entityId: "current-answer" };
  assert.deepEqual(pickZaicodeAutoRetryAction([oldUser, oldAnswer, latestUser, currentAnswer]), {
    kind: "retry", target: { rowId: 4, entityId: "current-answer" },
  });
});

test("T-240: an unavailable latest input cannot fall back to older work", () => {
  assert.equal(pickZaicodeAutoRetryAction([oldUser, oldAnswer, { ...latestUser, actions: undefined }]), null);
  assert.equal(pickZaicodeAutoRetryAction([oldUser, oldAnswer, { ...latestUser, text: "" }]), null);
});

test("T-240: a tail window without its user row still uses the canonical admitted answer identity", () => {
  assert.deepEqual(pickZaicodeAutoRetryAction([oldAnswer]), {
    kind: "retry", target: { rowId: 2, entityId: "old-answer" },
  });
});

test("T-240: a model-only continuation cannot become the editable real-user request", () => {
  assert.deepEqual(pickZaicodeAutoRetryAction([latestUser, {
    ...latestUser, rowId: 4, entityId: "internal-continuation", origin: "goalContinuation",
  }]), { kind: "edit", target: { rowId: 3, entityId: "failed-user" }, text: "Same text" });
});
