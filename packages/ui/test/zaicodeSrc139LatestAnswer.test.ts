import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { AssistantTextRow } from "@zcode/shared/zcode-protocol-v4";
import {
  CONVERSATION_LATEST_ANSWER_PREVIEW_CHARS,
  answerRowVisible,
  assistantAnswerPreview,
  isMeaningfulAssistantAnswer,
  latestAssistantAnswer,
} from "../src/v4/conversationLatestAnswer.js";

// SRC-139 (FINDING 3): the latest assistant answer must be reachable as an affordance,
// by a STABLE row identity. Before this ticket the sessions-index reduced the answer to
// the boolean `hasAssistantOutput`, so the conversation view had no anchor to point at.

const source = (relative: string) => readFileSync(new URL("../src/" + relative, import.meta.url), "utf8");

function answer(
  rowId: number,
  text: string,
  state: AssistantTextRow["state"] = "complete",
  entityId?: string,
): AssistantTextRow {
  return {
    kind: "assistantText",
    rowId,
    turnId: "turn-" + rowId,
    ...(entityId ? { entityId } : {}),
    createdAt: "2026-10-06T00:00:00.000Z",
    createdAtSeq: rowId,
    text,
    state,
  };
}

test("SRC-139: the newest settled answer wins, with its own row id", () => {
  const units = [
    { assistantTextRows: [answer(4, "first answer", "complete", "m-4")] },
    { assistantTextRows: [answer(9, "second answer", "complete")] },
  ];
  const latest = latestAssistantAnswer(units);
  assert.equal(latest?.rowId, 9, "the jump anchor is the row's own id");
  assert.equal(latest?.identity, "9", "no entityId: the rowId is the identity");
  assert.equal(latest?.unitIndex, 1, "the unit that must be mounted first");
  assert.equal(latest?.preview, "second answer");
  // entityId is the canonical identity when the frame carries it.
  assert.equal(latestAssistantAnswer([{ assistantTextRows: [answer(3, "x", "complete", "m-3")] }])?.identity, "m-3");
});

test("SRC-139: only a settled, non-empty answer is offered", () => {
  assert.equal(isMeaningfulAssistantAnswer(answer(1, "done", "complete")), true);
  assert.equal(isMeaningfulAssistantAnswer(answer(1, "cut off", "interrupted")), true);
  assert.equal(isMeaningfulAssistantAnswer(answer(1, "half a sen", "streaming")), false, "streaming would grow on every chunk");
  assert.equal(isMeaningfulAssistantAnswer(answer(1, "boom", "failed")), false, "a failure is not an answer");
  assert.equal(isMeaningfulAssistantAnswer(answer(1, "   \n  ", "complete")), false, "whitespace is not an answer");
  // The newest row being unusable falls back to the previous settled one, never to nothing.
  const units = [
    { assistantTextRows: [answer(1, "the real answer", "complete")] },
    { assistantTextRows: [answer(2, "still typing", "streaming")] },
  ];
  assert.equal(latestAssistantAnswer(units)?.rowId, 1);
  // No units, no answer: the bar renders nothing.
  assert.equal(latestAssistantAnswer([]), null);
  assert.equal(latestAssistantAnswer([{ assistantTextRows: [] }]), null);
});

test("SRC-139: the preview is one flat short line, cut on a word", () => {
  assert.equal(assistantAnswerPreview("line one\n\nline two   indented"), "line one line two indented");
  const long = "word ".repeat(80).trim();
  const preview = assistantAnswerPreview(long, 40);
  assert.equal(preview.endsWith("…"), true);
  assert.equal(preview.length <= 41, true, "short preview: one line, hard ceiling");
  // A long unbroken token still gets cut (no silent overflow into the layout).
  assert.equal(assistantAnswerPreview("x".repeat(400), 40).length, 41);
  assert.equal(CONVERSATION_LATEST_ANSWER_PREVIEW_CHARS, 140, "the ceiling is the cheap path's declared constant");
  assert.equal(assistantAnswerPreview("short").length, 5);
});

test("SRC-139: clicking an already-visible answer moves nothing", () => {
  const viewport = { top: 100, bottom: 700 };
  // Fully on screen: the click is a no-op, so the transcript does not move underfoot.
  assert.equal(answerRowVisible({ top: 300, bottom: 400 }, viewport), true);
  // peeking out of the top (under the sticky bar) or the bottom counts as not visible.
  assert.equal(answerRowVisible({ top: 60, bottom: 300 }, viewport), false);
  assert.equal(answerRowVisible({ top: 400, bottom: 760 }, viewport), false);
  // A one-pixel sliver must not read as "visible", or the click would look broken.
  assert.equal(answerRowVisible({ top: 104, bottom: 200 }, viewport), false);
  assert.equal(answerRowVisible({ top: 108, bottom: 200 }, viewport), true);
});

test("SRC-139: the bar derives from the render units and jumps by row id, not by text", () => {
  const bar = source("v4/ConversationTurnNavStrip.tsx");
  // Stable identity, no text search: the DOM anchor is the rowId.
  assert.match(bar, /latestTurnAnchors\(units\)/);
  assert.match(bar, /querySelector<HTMLElement>\(`\[data-row-id="\$\{anchor\.rowId\}"\]`\)/);
  assert.match(bar, /onJumpToRow\(\{ unitIndex: anchor\.unitIndex, rowId: anchor\.rowId \}\)/);
  assert.match(bar, /data-v4-latest-answer-identity=\{assistant\.identity\}/);
  // The stable identity itself is the row's own id, declared where it is derived.
  assert.match(source("v4/conversationLatestAnswer.ts"), /identity: row\.entityId \?\? String\(row\.rowId\)/);
  assert.doesNotMatch(bar, /textContent/, "never navigate by matching preview text");
  assert.doesNotMatch(bar, /useState|useReducer|useRef/, "nothing is remembered: a switch cannot leave a stale anchor");
  // An already-visible answer is left alone.
  assert.match(bar, /answerRowVisible\(row\.getBoundingClientRect\(\), root\.getBoundingClientRect\(\)\)\) return;/);
  // No duplicate cards: one element, one testid, one mount.
  assert.equal(bar.match(/data-testid=\{CONVERSATION_LATEST_ANSWER_TESTID\}/g)?.length, 1);
  const timeline = source("v4/ConversationTimeline.tsx");
  assert.equal(timeline.match(/<ConversationTurnNavStrip/g)?.length, 1, "exactly one strip in the timeline");
  assert.equal(timeline.match(/from "@\/v4\/ConversationTurnNavStrip\.js"/g)?.length, 1, "one import");
});

test("SRC-161:REQ-009 + T-277: the chips live in the transcript row, a real layout lane, not an overlay", () => {
  const strip = source("v4/ConversationTurnNavStrip.tsx");
  // The superseded strategy was a zero-height sticky overlay; REQ-009 rejects it because
  // an overlay can only paint over its neighbours, never reserve room from them.
  assert.doesNotMatch(strip, /h-0/, "the strip owns its height");
  assert.doesNotMatch(strip, /sticky top-0 pointer-events-none/, "no zero-geometry overlay");
  // T-277: the strip lends its chips to the transcript row (display: contents), so they are
  // spread with the row's other controls; the row is the lane that owns the height.
  assert.match(strip, /className=\{cn\("contents", className\)\}/);
  assert.match(strip, /data-v4-turn-nav-strip="true"/);
  // Each chip is its own target and truncates instead of pushing the row's other controls.
  assert.match(strip, /pointer-events-auto flex min-w-0 max-w-\[24%\]/);

  const timeline = source("v4/ConversationTimeline.tsx");
  const rowIndex = timeline.indexOf('data-zaicode-transcript-row="true"');
  const stripIndex = timeline.indexOf("<ConversationTurnNavStrip");
  const rowEnd = timeline.indexOf("</div>", stripIndex);
  assert.equal(rowIndex > 0 && rowIndex < stripIndex && stripIndex < rowEnd, true, "the chips are items of the transcript row");
  assert.match(timeline.slice(rowIndex, rowEnd), /flex min-h-10 shrink-0 items-center justify-evenly/, "a constant lane that spreads its controls");
  const scrollIndex = timeline.indexOf('ref={scrollRef}');
  const dockIndex = timeline.indexOf('data-v4-composer-dock="true"');
  const layerIndex = timeline.indexOf('data-v4-timeline-message-layer="true"', scrollIndex);
  // In flow, ABOVE the scroller: the viewport starts where the lane ends, so the chips
  // cannot cover a transcript row, a status chip, a meter, the header or the composer.
  assert.equal(stripIndex < scrollIndex, true, "the lane sits above the scrolling viewport");
  assert.equal(stripIndex < dockIndex, true, "never inside the composer dock");
  assert.equal(stripIndex < layerIndex, true, "never over the message layer");
  // Exactly one lane, one mount, one import (no duplicate bars).
  assert.equal(timeline.match(/<ConversationTurnNavStrip/g)?.length, 1, "exactly one strip in the timeline");
  assert.equal(timeline.match(/from "@\/v4\/ConversationTurnNavStrip\.js"/g)?.length, 1, "one import");
  // Product mode only: the classic ZAICODE timeline is untouched.
  assert.match(timeline, /\{isZaicodeProductMode\(\) \? \(\s*<div\s+data-zaicode-transcript-row="true"/);
});
test("SRC-139 + REQ-009: the accessible name reuses the navigator's jump key (no locale sweep)", () => {
  const strip = source("v4/ConversationTurnNavStrip.tsx");
  assert.match(
    strip,
    /intl\.formatMessage\(\{ id: "chat\.turnNavigator\.jumpToQuery" \}, \{ index: anchor\.unitIndex \+ 1 \}\)/,
  );
  assert.equal(strip.match(/aria-label=\{label\(/g)?.length, 2, "both chips carry the accessible name");
  // The preview is the tooltip: the text is data, never a lookup key.
  assert.equal(
    strip.match(/title=\{(user|assistant)\.preview\}/g)?.length,
    2,
    "each chip names itself with its own preview",
  );
});
