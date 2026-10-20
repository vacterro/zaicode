import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import {
  normalizeTranscriptView,
  projectTranscriptRows,
  isUnboundedTranscriptView,
} from "../src/lib/transcriptView.js";
import { normalizeZaicodeUiPrefs } from "../src/zaicode/zaicodeUiPrefs.js";
import { ConversationTranscriptControl } from "../src/v4/ConversationTranscriptControl.js";

const sections = (shown: readonly string[], scroll: readonly string[] = []) => ({
  kind: "sections" as const,
  expanded: true,
  sections: Object.fromEntries(
    ["user", "assistant", "thoughts", "tools"].map((key) => [
      key,
      { visible: shown.includes(key), scroll: scroll.includes(key) },
    ]),
  ),
});
const rows = [
  { rowId: 1, kind: "turnHeader" },
  { rowId: 2, kind: "userInput", text: "USER" },
  { rowId: 3, kind: "reasoning", text: "THOUGHT" },
  { rowId: 4, kind: "toolCall", toolName: "Bash", status: "success" },
  { rowId: 5, kind: "assistantText", text: "AGENT" },
  { rowId: 6, kind: "timelineMarker", marker: { type: "goalVerify", outcome: "failed" } },
] as unknown as ConversationRow[];

test("T-336: independent mixed sections project before grouping without changing source rows", () => {
  const view = normalizeTranscriptView(sections(["thoughts", "tools"]));
  const before = JSON.stringify(rows);
  assert.deepEqual(
    projectTranscriptRows(rows, view).map((row) => row.rowId),
    [1, 3, 4, 6],
  );
  assert.equal(JSON.stringify(rows), before);
  assert.equal(projectTranscriptRows(rows, view)[1], rows[2]);
});

test("T-336: hiding every section retains essential failure evidence and recoverable controls", () => {
  const view = normalizeTranscriptView(sections([]));
  assert.deepEqual(
    projectTranscriptRows(rows, view).map((row) => row.rowId),
    [6],
  );
});

test("T-336: each section scroll policy is independent", () => {
  const view = normalizeTranscriptView(
    sections(["user", "assistant", "thoughts", "tools"], ["user", "tools"]),
  );
  const unbounded = isUnboundedTranscriptView;
  assert.equal(unbounded(view, "user"), false);
  assert.equal(unbounded(view, "assistant"), true);
  assert.equal(unbounded(view, "thoughts"), true);
  assert.equal(unbounded(view, "tools"), false);
});

test("T-336: section choices survive preference roundtrip without resetting unrelated settings", () => {
  const chosen = sections(["assistant", "tools"], ["tools"]);
  const prefs = normalizeZaicodeUiPrefs(
    JSON.parse(JSON.stringify({ transcriptView: chosen, autoRetry: false, noMotion: true })),
  );
  assert.deepEqual(prefs.transcriptView, chosen);
  assert.equal(prefs.autoRetry, false);
  assert.equal(prefs.noMotion, true);
});

test("T-336: the control exposes independent checkboxes instead of a preset select", () => {
  const html = renderToStaticMarkup(
    createElement(ConversationTranscriptControl, { view: "full", onChange() {} }),
  );
  assert.equal((html.match(/role="checkbox"/g) ?? []).length, 9);
  assert.doesNotMatch(html, /<select/);
  for (const key of ["user", "assistant", "thoughts", "tools"]) {
    assert.match(html, new RegExp(`data-transcript-visible="${key}"`));
    assert.match(html, new RegExp(`data-transcript-scroll="${key}"`));
  }
});
