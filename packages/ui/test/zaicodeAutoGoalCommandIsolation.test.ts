import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  ZAICODE_AUTO_GOAL_SUFFIX,
  classifyOutgoingInput,
  isEligibleForAutoGoal,
  isStopCommand,
  splitZaicodeAutoGoal,
  withZaicodeAutoGoal,
} from "../src/zaicode/zaicodeAutoGoal.js";
import {
  mayContinueZaicodeGoal,
  registerZaicodeGoalIntent,
  resetZaicodeGoalIntentsForTest,
  stopZaicodeGoalIntents,
  zaicodeGoalIntentById,
} from "../src/zaicode/zaicodeGoalSupervisor.js";

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), "utf8");
const composer = read("v4/ConversationComposer.tsx");
const rowView = read("v4/ConversationRowView.tsx");

test("P0 AUTO-GOAL: classifier categorizes control commands, lifecycle controls, continuations, and work", () => {
  // SAIPEN control commands
  assert.equal(classifyOutgoingInput("saipen status").category, "saipen_control");
  assert.equal(classifyOutgoingInput("saipen status").eligibleForAutoGoal, false);
  assert.equal(classifyOutgoingInput("saipen validate").category, "saipen_control");
  assert.equal(classifyOutgoingInput("saipen recover").category, "saipen_control");
  assert.equal(classifyOutgoingInput("saipen push").category, "saipen_control");
  assert.equal(classifyOutgoingInput("saipen start T-999").category, "saipen_control");
  assert.equal(classifyOutgoingInput("saipen").category, "saipen_control");

  // SAIPEN shortcuts (whole token)
  for (const shortcut of ["gg", "hh", "ff", "xx", "vv", "zz", "sss", "dd", "aa", "qq", "qqq", "ee", "eee", "pp", "tt", "sc", "аа", "ее", "еее", "рр", "хх"]) {
    const c = classifyOutgoingInput(shortcut);
    assert.equal(c.category, "saipen_control", `shortcut ${shortcut} should be saipen_control`);
    assert.equal(c.eligibleForAutoGoal, false, `shortcut ${shortcut} should not be eligible`);
  }

  // Lifecycle stop commands
  const stopInputs = [
    "saipen stop",
    "saipen stop all",
    "st",
    "st all",
    "stop",
    "stop all",
    "/stop",
    "cancel",
    "cancel all",
    "/cancel",
    "abort",
    "abort all",
    "/abort",
    "interrupt",
  ];
  for (const stopInput of stopInputs) {
    const c = classifyOutgoingInput(stopInput);
    assert.equal(c.category, "lifecycle_control", `${stopInput} must be lifecycle_control`);
    assert.equal(c.isStop, true, `${stopInput} must be recognized as stop`);
    assert.equal(c.eligibleForAutoGoal, false, `${stopInput} must never be eligible for auto-goal`);
    assert.equal(isStopCommand(stopInput), true);
    assert.equal(isEligibleForAutoGoal(stopInput), false);
  }

  // Lifecycle pause commands
  const pauseInputs = ["pause", "/pause"];
  for (const pauseInput of pauseInputs) {
    const c = classifyOutgoingInput(pauseInput);
    assert.equal(c.category, "lifecycle_control");
    assert.equal(c.isStop, false);
    assert.equal(c.isLifecycle, true);
    assert.equal(c.eligibleForAutoGoal, false);
  }

  // ZAICODE continuation commands
  const contInputs = [
    "cc",
    "сс",
    "cc all",
    "сс all",
    "cc-all",
    "ccc",
    "ссс",
    "step",
    "saipen continue",
    "saipen continue --json",
    "/continue",
    "/resume",
  ];
  for (const contInput of contInputs) {
    const c = classifyOutgoingInput(contInput);
    assert.equal(c.category, "zaicode_continuation", `${contInput} must be zaicode_continuation`);
    assert.equal(c.isContinuation, true);
    assert.equal(c.eligibleForAutoGoal, false, `${contInput} must not be eligible for auto-goal`);
  }

  // Explicit goal declarations
  const goalInputs = [
    "/goal cc all",
    "/goal T-310",
    "/target finish the board",
    "first line\n/goal cc all",
    "do it /goal T-9",
  ];
  for (const goalInput of goalInputs) {
    const c = classifyOutgoingInput(goalInput);
    assert.equal(c.category, "explicit_goal", `${goalInput} must be explicit_goal`);
    assert.equal(c.isGoal, true);
    assert.equal(c.eligibleForAutoGoal, false);
  }

  // Unknown command-like inputs
  const unknownInputs = ["/unknown-cmd", "/custom-action with args", "!shell-command", "$run-script"];
  for (const unknownInput of unknownInputs) {
    const c = classifyOutgoingInput(unknownInput);
    assert.equal(c.category, "unknown_command", `${unknownInput} must be unknown_command`);
    assert.equal(c.eligibleForAutoGoal, false, `${unknownInput} must not be eligible for auto-goal`);
  }

  // Ordinary work prompts
  const workInputs = [
    "Take the handoff and finish the board",
    "Fix bug in authentication token expiry check",
    "Please run tests",
    "Refactor styles in CSS",
  ];
  for (const workInput of workInputs) {
    const c = classifyOutgoingInput(workInput);
    assert.equal(c.category, "work", `${workInput} must be work`);
    assert.equal(c.eligibleForAutoGoal, true, `${workInput} must be eligible for auto-goal`);
  }

  // Ordinary tasks containing quoted commands
  const quotedWorkInputs = [
    'Fix "saipen stop" bug in production',
    'Verify "cc" command behavior under load',
    '"saipen status" is failing in CI',
    'Test `saipen stop` command isolation',
    "'cc all' should not be triggered",
  ];
  for (const quotedInput of quotedWorkInputs) {
    const c = classifyOutgoingInput(quotedInput);
    assert.equal(c.category, "work", `${quotedInput} must remain work`);
    assert.equal(c.eligibleForAutoGoal, true, `${quotedInput} must be eligible for auto-goal`);
  }

  // Ordinary prose containing command words in sentence structure
  const proseInputs = [
    "Stop the container if port 8080 is in use",
    "Please stop after completing the first test file",
    "Cancel when timeout exceeds 30 seconds",
  ];
  for (const proseInput of proseInputs) {
    const c = classifyOutgoingInput(proseInput);
    assert.equal(c.category, "work", `${proseInput} must be classified as work`);
    assert.equal(c.eligibleForAutoGoal, true, `${proseInput} must be eligible for auto-goal`);
  }

  // Empty handoff ("hit & go")
  const emptyClassification = classifyOutgoingInput("");
  assert.equal(emptyClassification.category, "work");
  assert.equal(emptyClassification.eligibleForAutoGoal, true);
});

test("REQUIRED REGRESSION MATRIX: Auto-Goal ON isolates control commands from automatic continuation", () => {
  // - "saipen stop" -> unchanged
  assert.equal(withZaicodeAutoGoal("saipen stop", true), "saipen stop");

  // - "saipen status" -> unchanged
  assert.equal(withZaicodeAutoGoal("saipen status", true), "saipen status");

  // - "cc" -> unchanged
  assert.equal(withZaicodeAutoGoal("cc", true), "cc");

  // - "cc all" -> unchanged
  assert.equal(withZaicodeAutoGoal("cc all", true), "cc all");

  // - "/goal cc all" -> unchanged
  assert.equal(withZaicodeAutoGoal("/goal cc all", true), "/goal cc all");

  // - An ordinary task prompt -> exactly one Auto-Goal suffix
  const taskPrompt = "Take the handoff and finish the board";
  assert.equal(
    withZaicodeAutoGoal(taskPrompt, true),
    `${taskPrompt}\n${ZAICODE_AUTO_GOAL_SUFFIX}`,
  );

  // - An ordinary task containing a quoted command -> remains ordinary work with suffix
  const quotedTask = 'Fix "saipen stop" command failure';
  assert.equal(
    withZaicodeAutoGoal(quotedTask, true),
    `${quotedTask}\n${ZAICODE_AUTO_GOAL_SUFFIX}`,
  );

  const quoteStartTask = '"saipen status" is failing';
  assert.equal(
    withZaicodeAutoGoal(quoteStartTask, true),
    `${quoteStartTask}\n${ZAICODE_AUTO_GOAL_SUFFIX}`,
  );

  // - Unknown command-like input -> no automatic continuation
  assert.equal(withZaicodeAutoGoal("/unknown-command", true), "/unknown-command");
  assert.equal(withZaicodeAutoGoal("/help", true), "/help");
  assert.equal(withZaicodeAutoGoal("!run-script", true), "!run-script");

  // Additional control commands
  assert.equal(withZaicodeAutoGoal("stop", true), "stop");
  assert.equal(withZaicodeAutoGoal("stop all", true), "stop all");
  assert.equal(withZaicodeAutoGoal("st", true), "st");
  assert.equal(withZaicodeAutoGoal("cancel", true), "cancel");
  assert.equal(withZaicodeAutoGoal("/cancel", true), "/cancel");
  assert.equal(withZaicodeAutoGoal("pause", true), "pause");
  assert.equal(withZaicodeAutoGoal("abort", true), "abort");
  assert.equal(withZaicodeAutoGoal("sc", true), "sc");
  assert.equal(withZaicodeAutoGoal("sss", true), "sss");
});

test("REQUIRED REGRESSION MATRIX: Auto-Goal OFF preserves explicitly authored input", () => {
  assert.equal(withZaicodeAutoGoal("saipen stop", false), "saipen stop");
  assert.equal(withZaicodeAutoGoal("saipen status", false), "saipen status");
  assert.equal(withZaicodeAutoGoal("cc", false), "cc");
  assert.equal(withZaicodeAutoGoal("cc all", false), "cc all");
  assert.equal(withZaicodeAutoGoal("/goal cc all", false), "/goal cc all");
  assert.equal(withZaicodeAutoGoal("Take the handoff", false), "Take the handoff");
  assert.equal(withZaicodeAutoGoal("  Take the handoff  ", false), "  Take the handoff  ");
  assert.equal(withZaicodeAutoGoal('Fix "saipen stop"', false), 'Fix "saipen stop"');
  assert.equal(withZaicodeAutoGoal("/unknown-cmd", false), "/unknown-cmd");
});

test("REQUIRED REGRESSION MATRIX: manual stop during active goal prevents automatic restart", () => {
  resetZaicodeGoalIntentsForTest();
  const projectKey = "V:/project/test-isolation";
  const sessionId = "session-iso-1";

  // Register an active goal intent
  const reg = registerZaicodeGoalIntent({
    projectKey,
    sessionId,
    objective: "Implement feature X",
    fresh: true,
  });
  assert.ok(reg.intent);
  assert.equal(reg.intent.stopped, false);

  // Manual stop command arrives ("saipen stop")
  const stopClass = classifyOutgoingInput("saipen stop");
  assert.equal(stopClass.isStop, true);
  if (stopClass.isStop) {
    stopZaicodeGoalIntents(projectKey, sessionId);
  }

  // Active intent is now stopped
  const intent = zaicodeGoalIntentById(reg.intent.intentId);
  assert.ok(intent);
  assert.equal(intent.stopped, true);
  assert.equal(intent.outcome, "stopped");

  // Continuation supervisor must refuse continuation with "operator stopped"
  const decision = mayContinueZaicodeGoal(intent.intentId);
  assert.equal(decision.send, false);
  assert.equal(decision.reason, "the operator stopped this goal");
});

test("QUEUE / EDIT / RETRY isolation invariants", () => {
  // Split correctly handles text with or without goal suffix
  assert.deepEqual(splitZaicodeAutoGoal("saipen stop"), { body: "saipen stop", goal: false });
  assert.deepEqual(splitZaicodeAutoGoal("cc"), { body: "cc", goal: false });
  assert.deepEqual(splitZaicodeAutoGoal("saipen status"), { body: "saipen status", goal: false });

  // If a row was previously sent with a goal, editing it into a control command strips the goal
  const editedToStop = withZaicodeAutoGoal("saipen stop", true);
  assert.equal(editedToStop, "saipen stop", "editing to saipen stop does not append goal");

  const editedToCc = withZaicodeAutoGoal("cc", true);
  assert.equal(editedToCc, "cc", "editing to cc does not append goal");

  // ConversationComposer source wires classification before goal intent registration and send
  assert.match(
    composer,
    /const classification = classifyOutgoingInput\(trimmed\);/,
    "composer classifies outgoing input before transformation",
  );
  assert.match(
    composer,
    /if \(classification\.isStop\) \{\s*stopZaicodeGoalIntents\(workspaceKey, sessionId \?\? null\);\s*\}/,
    "composer stops active goals on typed stop commands",
  );
  assert.match(
    composer,
    /if \(autoGoalOn && classification\.eligibleForAutoGoal\)/,
    "composer registers goal intents only for eligible inputs",
  );

  // ConversationRowView wires classification and stop intent on edit
  assert.match(
    rowView,
    /const editClassification = classifyOutgoingInput\(nextText\);/,
    "row view classifies edited text before submission",
  );
  assert.match(
    rowView,
    /if \(editClassification\.isStop && context\.workspacePath\) \{\s*stopZaicodeGoalIntents\(context\.workspacePath, context\.sessionId \?\? null\);\s*\}/,
    "row view stops active goals when user edits a row to a stop command",
  );
});
