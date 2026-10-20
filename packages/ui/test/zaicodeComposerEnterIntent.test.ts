import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  describeComposerSendBlocker,
  resolveComposerEnterIntent,
} from "../src/shortcuts/composerShortcuts.js";

// SAIHANDOFF: Enter has two independent meanings. "Enter is newline" is a user
// binding; "Enter is send but submission is blocked" must not insert a newline
// and must not silently drop the draft either.

const SOURCE = (path: string) =>
  readFileSync(join(import.meta.dirname, "..", "src", path), "utf8").replace(/\r\n/g, "\n");

test("a user binding that makes Enter a newline keeps the newline", () => {
  assert.equal(
    resolveComposerEnterIntent({
      modified: false,
      submitDisabled: true,
      enterSubmits: true,
      bareEnterIsSend: false,
    }),
    "newline",
  );
});

test("the mobile viewport policy keeps Enter as a newline", () => {
  assert.equal(
    resolveComposerEnterIntent({
      modified: false,
      submitDisabled: false,
      enterSubmits: false,
      bareEnterIsSend: true,
    }),
    "newline",
  );
});

test("Enter that means send but is blocked never falls back to a newline", () => {
  assert.equal(
    resolveComposerEnterIntent({
      modified: false,
      submitDisabled: true,
      enterSubmits: true,
      bareEnterIsSend: true,
      readiness: "attachments_not_ready",
    }),
    "blocked",
  );
  assert.equal(
    resolveComposerEnterIntent({
      modified: false,
      submitDisabled: false,
      enterSubmits: true,
      bareEnterIsSend: true,
      readiness: "submitting",
    }),
    "blocked",
  );
  assert.equal(
    resolveComposerEnterIntent({
      modified: false,
      submitDisabled: false,
      enterSubmits: true,
      bareEnterIsSend: true,
      readiness: "routing_rejected",
    }),
    "blocked",
  );
  assert.equal(
    resolveComposerEnterIntent({
      modified: false,
      submitDisabled: false,
      enterSubmits: true,
      bareEnterIsSend: true,
      readiness: "not_submittable",
    }),
    "blocked",
  );
});

test("a modified Enter bound to send is blocked too, not turned into a newline", () => {
  assert.equal(
    resolveComposerEnterIntent({
      modified: true,
      submitDisabled: true,
      enterSubmits: true,
      bareEnterIsSend: true,
      readiness: "attachments_not_ready",
    }),
    "blocked",
  );
});

test("an empty composer still takes the newline path", () => {
  assert.equal(
    resolveComposerEnterIntent({
      modified: false,
      submitDisabled: true,
      enterSubmits: true,
      bareEnterIsSend: true,
      readiness: "empty",
    }),
    "newline",
  );
});

test("a ready composer sends", () => {
  assert.equal(
    resolveComposerEnterIntent({
      modified: false,
      submitDisabled: false,
      enterSubmits: true,
      bareEnterIsSend: true,
      readiness: "ready",
    }),
    "send",
  );
});

test("each blocker has its own exact explanation", () => {
  const reasons = [
    "disabled",
    "submitting",
    "attachments_not_ready",
    "routing_rejected",
    "not_submittable",
    "submit_blocked",
  ] as const;
  const texts = reasons.map((readiness) => describeComposerSendBlocker(readiness));
  assert.equal(new Set(texts).size, texts.length, "no two blockers share an explanation");
  for (const text of texts) assert.ok(text.length > 10, "the blocker explains itself");
  assert.match(describeComposerSendBlocker("attachments_not_ready"), /attachment/i);
});

test("the editor blocks Enter instead of inserting a newline when sending is blocked", () => {
  const source = SOURCE("LexicalChatInput.tsx");
  assert.match(source, /resolveComposerEnterIntent\(/);
  assert.match(source, /intent === "blocked"/);
  assert.match(source, /reportBlockedEnter\(\);/);
  // The old fall-through to Lexical newline is gone from the send chain.
  assert.doesNotMatch(source, /if \(submitDisabled \|\| !enterSubmits\) \{\s*return false;/);
});

test("the blocked path keeps IME composition, Shift+Enter and user newline bindings intact", () => {
  const source = SOURCE("LexicalChatInput.tsx");
  assert.match(source, /if \(event\.isComposing\) \{\s*return false;/);
  assert.match(source, /if \(event\.shiftKey \|\| event\.ctrlKey \|\| event\.metaKey\) \{\s*return false;/);
  assert.match(source, /if \(scopedAction === "newline"\) \{\s*return false;/);
  assert.match(source, /shouldBareEnterFallThroughToNewline\(composerEffective\)/);
});

test("the composer reports the blocker to the operator", () => {
  const composer = SOURCE("v4/ConversationComposer.tsx");
  assert.match(composer, /onSubmitBlocked=\{handleSubmitBlocked\}/);
  assert.match(composer, /const handleSubmitBlocked = useCallback\(\(reason: string\) => \{/);
  assert.match(composer, /toast\(reason, \{ variant: "warning" as const \}\);/);
  const editor = SOURCE("prompt-editor/ChatPromptEditor.tsx");
  assert.match(editor, /onSubmitBlocked=\{onSubmitBlocked\}/);
});
