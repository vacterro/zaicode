import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ZAICODE_AUTO_GOAL_SUFFIX, splitZaicodeAutoGoal, withZaicodeAutoGoal } from "../src/zaicode/zaicodeAutoGoal.js";

// SRC-163: SAIHUNT over the SRC-151 bundle. Each test pins one defect the hunt found in an
// item an earlier wave had marked as done.

const src = (relative: string) => readFileSync(new URL(`../src/${relative}`, import.meta.url), "utf8");

test("R006: the Auto-Goal suffix never shows as the queued or sent prompt", () => {
  assert.deepEqual(splitZaicodeAutoGoal(withZaicodeAutoGoal("finish the board", true)), { body: "finish the board", goal: true });
  // A screenshot with no text used to queue as a bare "/goal cc all".
  assert.deepEqual(splitZaicodeAutoGoal(withZaicodeAutoGoal("", true)), { body: "", goal: true });
  assert.deepEqual(splitZaicodeAutoGoal("plain prompt"), { body: "plain prompt", goal: false });
  // A goal the operator wrote mid-text is theirs, not the appended suffix.
  assert.equal(splitZaicodeAutoGoal(`${ZAICODE_AUTO_GOAL_SUFFIX} first`).goal, false);
  const queue = src("v4/ConversationQueuePanel.tsx");
  assert.match(queue, /const queueGoal = splitZaicodeAutoGoal\(item\.text\)/);
  assert.match(queue, /data-zaicode-auto-goal-chip/);
  const row = src("v4/ConversationRowView.tsx");
  assert.match(row, /const visibleText = zaicodeGoal\.body;/);
  assert.match(row, /zaicodeGoal\.goal \? withZaicodeAutoGoal\(nextText, true\) : nextText/, "an edit keeps the goal it was sent with");
  const pane = src("v4/SessionPane.tsx");
  assert.match(pane, /splitZaicodeAutoGoal\(restoreTarget\.text\)\.body/, "a queue edit does not put the suffix in the editor");
});
