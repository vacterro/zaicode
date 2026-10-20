import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import {
  isUnboundedTranscriptView,
  normalizeTranscriptView,
  projectTranscriptRows,
  TranscriptViewContext,
} from "../src/lib/transcriptView.js";
import { normalizeZaicodeUiPrefs } from "../src/zaicode/zaicodeUiPrefs.js";
import { ConversationTranscriptControl } from "../src/v4/ConversationTranscriptControl.js";
import { ToolLayout } from "../src/ToolCallBlocks/ToolLayout.js";
import { Reasoning, useReasoning } from "../src/components/ai-elements/reasoning.js";
import { ExecuteOutput } from "../src/ToolCallBlocks/renderers/ExecuteOutput.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";

const base = { turnId: "turn", createdAt: 100, createdAtSeq: 1 };
const rows: ConversationRow[] = [
  { ...base, rowId: 1, kind: "userInput", text: "User narrative", origin: "realUser" },
  { ...base, rowId: 2, kind: "reasoning", text: "Thought detail", state: "complete" },
  { ...base, rowId: 3, kind: "assistantText", text: "Intermediate narrative", state: "complete" },
  { ...base, rowId: 4, kind: "reasoning", text: "Later thought", state: "streaming" },
  { ...base, rowId: 5, kind: "assistantText", text: "Live narrative", state: "streaming" },
];
const toolRows: ConversationRow[] = [
  {
    ...base,
    rowId: 1,
    kind: "turnHeader",
    origin: "userInput",
    state: "completedSuccess",
    startedAt: 100,
  } as ConversationRow,
  { ...base, rowId: 2, kind: "userInput", text: "User narrative", origin: "realUser" },
  { ...base, rowId: 3, kind: "reasoning", text: "Thought detail", state: "complete" },
  {
    ...base,
    rowId: 4,
    kind: "toolCall",
    toolCallId: "c1",
    toolName: "Read",
    inputText: "{}",
    status: "success",
  } as ConversationRow,
  {
    ...base,
    rowId: 5,
    kind: "toolCall",
    toolCallId: "c2",
    toolName: "Write",
    inputText: "{}",
    status: "error",
    error: { code: "EACCES", message: "permission denied" },
  } as ConversationRow,
  { ...base, rowId: 6, kind: "assistantText", text: "Narrative", state: "complete" },
];

test("stored Transcript modes accept only the three choices and preserve unrelated prefs", () => {
  for (const mode of ["compact", "full", "only-text"] as const) {
    assert.equal(normalizeTranscriptView(mode), mode);
    const prefs = normalizeZaicodeUiPrefs({ transcriptView: mode, autoRetry: false });
    assert.equal(prefs.transcriptView, mode);
    assert.equal(prefs.autoRetry, false);
  }
  for (const value of [null, undefined, "text", {}, 1, "FULL"]) {
    assert.equal(normalizeTranscriptView(value), "compact");
    assert.equal(normalizeZaicodeUiPrefs({ transcriptView: value }).transcriptView, "compact");
  }
});

test("Only text keeps intermediate and live narrative in order without changing source rows", () => {
  const before = JSON.stringify(rows);
  const visible = projectTranscriptRows(rows, "only-text");
  assert.deepEqual(
    visible.map((row) => row.rowId),
    [1, 3, 5],
  );
  assert.equal(visible[1], rows[2]);
  assert.equal(JSON.stringify(rows), before);
  assert.equal(projectTranscriptRows(rows, "compact"), rows);
  assert.equal(projectTranscriptRows(rows, "full"), rows);
});

test("newly streamed thoughts are filtered by the selected view without losing text", () => {
  const next = [
    ...rows,
    { ...base, rowId: 6, kind: "reasoning", text: "New thought", state: "streaming" } as const,
  ];
  assert.deepEqual(
    projectTranscriptRows(next, "only-text").map((row) => row.rowId),
    [1, 3, 5],
  );
  assert.equal(projectTranscriptRows(next, "full").length, 6);
});

// T-298: two persistent single-purpose transcript views.

test("T-298: both new modes persist through the UI preference roundtrip", () => {
  for (const mode of ["only-thoughts", "only-tools"] as const) {
    assert.equal(normalizeTranscriptView(mode), mode);
    const prefs = normalizeZaicodeUiPrefs({ transcriptView: mode, noMotion: true });
    assert.equal(prefs.transcriptView, mode);
    assert.equal(prefs.noMotion, true);
  }
  for (const value of ["thoughts", "tools", "ONLY-THOUGHTS", 2, []]) {
    assert.equal(normalizeTranscriptView(value), "compact");
    assert.equal(normalizeZaicodeUiPrefs({ transcriptView: value }).transcriptView, "compact");
  }
});

test("T-298: Only thoughts keeps reasoning in order with turn boundaries and nothing else", () => {
  const visible = projectTranscriptRows(toolRows, "only-thoughts");
  assert.deepEqual(
    visible.map((row) => row.rowId),
    [1, 3],
  );
  assert.equal(visible[0].kind, "turnHeader");
  assert.equal(visible[1].kind, "reasoning");
  // Negative control: no user words, no prose, no tool output.
  for (const row of visible) {
    assert.notEqual(row.kind, "userInput");
    assert.notEqual(row.kind, "assistantText");
    assert.notEqual(row.kind, "toolCall");
  }
  // Source rows are never mutated by a view.
  assert.equal(projectTranscriptRows(toolRows, "compact"), toolRows);
  assert.equal(projectTranscriptRows(toolRows, "full"), toolRows);
});

test("T-298: Only tool calling keeps tool rows in order with turn boundaries and nothing else", () => {
  const visible = projectTranscriptRows(toolRows, "only-tools");
  assert.deepEqual(
    visible.map((row) => row.rowId),
    [1, 4, 5],
  );
  assert.equal(visible[1].kind, "toolCall");
  assert.equal(visible[1].kind === "toolCall" && visible[1].toolName, "Read");
  assert.equal(visible[2].kind === "toolCall" && visible[2].status, "error");
  assert.equal(visible[2].kind === "toolCall" && visible[2].error?.message, "permission denied");
  for (const row of visible) {
    assert.notEqual(row.kind, "userInput");
    assert.notEqual(row.kind, "assistantText");
    assert.notEqual(row.kind, "reasoning");
  }
});

test("T-298: both new modes expand detail and never cap output with an inner max-height", () => {
  const text = Array.from({ length: 600 }, (_, at) => `line-${at}`).join("\n");
  for (const view of ["only-thoughts", "only-tools"] as const) {
    assert.equal(isUnboundedTranscriptView(view), true);
    const html = renderToStaticMarkup(
      createElement(ZCodeIntlProvider, {
        initialLocale: "en-US",
        children: createElement(
          TranscriptViewContext.Provider,
          { value: view },
          createElement(ToolLayout, {
            toolId: "t298-detail",
            icon: null,
            kindLabel: "Tool",
            primaryText: "Summary",
            content: createElement(ExecuteOutput, { text, running: false }),
          }),
        ),
      }),
    );
    assert.ok(html.includes("line-0"), `${view} expands loaded output`);
    assert.ok(html.includes("line-599"), `${view} does not truncate loaded output`);
    assert.ok(!html.includes("max-h-["), `${view} has no inner max-height`);
  }
  // Compact and Full keep their bounded behaviour unchanged.
  assert.equal(isUnboundedTranscriptView("compact"), false);
  assert.equal(isUnboundedTranscriptView("full"), false);
});

test("T-298: reasoning auto-opens in both new modes and stays closed in Compact", () => {
  function Content() {
    return createElement("span", null, String(useReasoning().isOpen));
  }
  const render = (view: "compact" | "only-thoughts" | "only-tools") =>
    renderToStaticMarkup(
      createElement(
        TranscriptViewContext.Provider,
        { value: view },
        createElement(Reasoning, null, createElement(Content)),
      ),
    );
  assert.match(render("compact"), />false</);
  assert.match(render("only-thoughts"), />true</);
  assert.match(render("only-tools"), />true</);
});

function controlCheckbox(html: string, section: string, kind = "visible") {
  const tag =
    html.match(
      new RegExp("<button[^>]*data-transcript-" + kind + '="' + section + '"[^>]*>'),
    )?.[0] ?? "";
  assert.match(tag, /role="checkbox"/);
  return tag.includes('aria-checked="true"');
}

test("T-336: legacy single-purpose views map to independent section checkboxes", () => {
  for (const view of ["only-thoughts", "only-tools"] as const) {
    const html = renderToStaticMarkup(
      createElement(ConversationTranscriptControl, { view, onChange() {} }),
    );
    assert.equal(controlCheckbox(html, "user"), false);
    assert.equal(controlCheckbox(html, "assistant"), false);
    assert.equal(controlCheckbox(html, "thoughts"), view === "only-thoughts");
    assert.equal(controlCheckbox(html, "tools"), view === "only-tools");
    assert.equal((html.match(/role="checkbox"/g) ?? []).length, 9);
    assert.doesNotMatch(html, /<select/);
  }
});

test("T-336: text-only presentation preserves both message roles and separate scroll controls", () => {
  const html = renderToStaticMarkup(
    createElement(ConversationTranscriptControl, { view: "only-text", onChange() {} }),
  );
  assert.equal(controlCheckbox(html, "user"), true);
  assert.equal(controlCheckbox(html, "assistant"), true);
  assert.equal(controlCheckbox(html, "thoughts"), false);
  assert.equal(controlCheckbox(html, "tools"), false);
  for (const section of ["user", "assistant", "thoughts", "tools"])
    controlCheckbox(html, section, "scroll");
  assert.match(html, /Transcript/);
});

test("Full renders actual tool detail while Compact retains its closed default", () => {
  const render = (view: "compact" | "full") =>
    renderToStaticMarkup(
      createElement(ZCodeIntlProvider, {
        initialLocale: "en-US",
        children: createElement(
          TranscriptViewContext.Provider,
          { value: view },
          createElement(ToolLayout, {
            toolId: "t258-detail",
            icon: null,
            kindLabel: "Tool",
            primaryText: "Summary",
            content: createElement("div", null, "Actual tool detail"),
          }),
        ),
      }),
    );
  assert.doesNotMatch(render("compact"), /Actual tool detail/);
  assert.match(render("full"), /Actual tool detail/);
  assert.doesNotMatch(render("compact"), /Actual tool detail/);
});

test("Full expands reasoning without changing the Compact disclosure owner", () => {
  function Content() {
    return createElement("span", null, String(useReasoning().isOpen));
  }
  const render = (view: "compact" | "full") =>
    renderToStaticMarkup(
      createElement(
        TranscriptViewContext.Provider,
        { value: view },
        createElement(Reasoning, null, createElement(Content)),
      ),
    );
  assert.match(render("compact"), />false</);
  assert.match(render("full"), />true</);
  assert.match(render("compact"), />false</);
});
