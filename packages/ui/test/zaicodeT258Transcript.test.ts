import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import {
  normalizeTranscriptView,
  projectTranscriptRows,
  TranscriptViewContext,
} from "../src/lib/transcriptView.js";
import { normalizeZaicodeUiPrefs } from "../src/zaicode/zaicodeUiPrefs.js";
import { ConversationTranscriptControl } from "../src/v4/ConversationTranscriptControl.js";
import { ToolLayout } from "../src/ToolCallBlocks/ToolLayout.js";
import { Reasoning, useReasoning } from "../src/components/ai-elements/reasoning.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";

const base = { turnId: "turn", createdAt: 100, createdAtSeq: 1 };
const rows: ConversationRow[] = [
  { ...base, rowId: 1, kind: "userInput", text: "User narrative", origin: "realUser" },
  { ...base, rowId: 2, kind: "reasoning", text: "Thought detail", state: "complete" },
  { ...base, rowId: 3, kind: "assistantText", text: "Intermediate narrative", state: "complete" },
  { ...base, rowId: 4, kind: "reasoning", text: "Later thought", state: "streaming" },
  { ...base, rowId: 5, kind: "assistantText", text: "Live narrative", state: "streaming" },
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

test("the visible control names all choices and announces exactly the selected mode", () => {
  const html = renderToStaticMarkup(
    createElement(ConversationTranscriptControl, {
      view: "only-text",
      onChange: () => undefined,
    }),
  );
  assert.match(html, /Transcript/);
  for (const label of ["Compact", "Full", "Only text"]) assert.ok(html.includes(label));
  assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 1);
  assert.match(html, /aria-pressed="true"[^>]*>Only text/);
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
