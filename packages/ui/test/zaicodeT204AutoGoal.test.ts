import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  withZaicodeAutoGoal,
  zaicodeAutoGoalEnabled,
  ZAICODE_AUTO_GOAL_SUFFIX,
} from "../src/zaicode/zaicodeAutoGoal.js";

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), "utf8");
const composer = read("v4/ConversationComposer.tsx");
const button = read("zaicode/ZaicodeAutoGoalButton.tsx");

test("an enabled project gets the goal on its own line and nothing else changes", () => {
  assert.equal(
    withZaicodeAutoGoal("Take the handoff and finish the board", true),
    `Take the handoff and finish the board\n${ZAICODE_AUTO_GOAL_SUFFIX}`,
  );
  assert.equal(ZAICODE_AUTO_GOAL_SUFFIX, "/goal cc all");
  // Off, or an unattached draft scope with no project: the text is the operator's alone.
  assert.equal(withZaicodeAutoGoal("Take the handoff", false), "Take the handoff");
  assert.equal(withZaicodeAutoGoal("  Take the handoff  ", false), "  Take the handoff  ");
  // A goal the operator wrote by hand is not doubled.
  assert.equal(withZaicodeAutoGoal("/goal cc all", true), "/goal cc all");
  assert.equal(withZaicodeAutoGoal("do it\n/goal cc all", true), "do it\n/goal cc all");
  assert.equal(withZaicodeAutoGoal("do it /goal T-9", true), "do it /goal T-9");
  // An empty handoff is the "hit & go" the queue placeholder advertises: it still needs the goal.
  assert.equal(withZaicodeAutoGoal("", true), ZAICODE_AUTO_GOAL_SUFFIX);
});

test("the mode is per project, off only where the operator turned it off", () => {
  assert.equal(zaicodeAutoGoalEnabled({ off: {} }, "V:/work/one"), true);
  assert.equal(zaicodeAutoGoalEnabled({ off: { "V:/work/two": true } }, "V:/work/two"), false);
  assert.equal(zaicodeAutoGoalEnabled({ off: { "V:/work/two": true } }, "V:/work/one"), true);
  // No project key at all is not a goal for some other project to inherit.
  assert.equal(zaicodeAutoGoalEnabled({ off: {} }, "   "), false);
});

test("the composer appends the goal to the outgoing text, never to the editor or the history", () => {
  assert.match(
    composer,
    /serializeComposerPromptContexts\(withZaicodeAutoGoal\(trimmed, autoGoalOn\)/,
  );
  // History and the editor keep the operator's own words: the goal is added after both.
  assert.match(composer, /appendPromptHistoryEntry\(promptHistoryBeforeSend, trimmed\)/);
  assert.doesNotMatch(composer, /updateComposerContent\(\{ text: promptText \}\)/);
  assert.ok(
    composer.indexOf("withZaicodeAutoGoal(trimmed") <
      composer.indexOf("appendPromptHistoryEntry(promptHistoryBeforeSend, trimmed)"),
    "the goal is appended before the history is written but from trimmed, not from promptText",
  );
});

test("the composer carries the switch and keys it to the project", () => {
  assert.match(composer, /<ZaicodeAutoGoalButton workspaceKey=\{workspaceKey\} \/>/);
  assert.match(composer, /useZaicodeAutoGoal\(\(state\) => zaicodeAutoGoalEnabled\(state, workspaceKey\)\)/);
  // On is highlighted and announced pressed; off is neither.
  assert.match(button, /enabled \? "on" : "off"/);
  assert.match(button, /aria-pressed=\{enabled\}/);
  assert.match(button, /enabled && "bg-selected text-foreground"/);
  assert.match(button, /onClick=\{\(\) => toggle\(workspaceKey\)\}/);
});