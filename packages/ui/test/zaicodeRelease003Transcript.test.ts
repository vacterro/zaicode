import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { normalizeTranscriptView, TranscriptViewContext } from "../src/lib/transcriptView.js";
import { normalizeZaicodeUiPrefs } from "../src/zaicode/zaicodeUiPrefs.js";
import { ConversationTranscriptControl } from "../src/v4/ConversationTranscriptControl.js";
import { ExecuteOutput } from "../src/ToolCallBlocks/renderers/ExecuteOutput.js";
import { ToolLayout } from "../src/ToolCallBlocks/ToolLayout.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";

test("unbounded Full survives preference roundtrip without remapping existing Full", () => {
  assert.equal(normalizeTranscriptView("full-unbounded"), "full-unbounded");
  assert.equal(normalizeZaicodeUiPrefs({ transcriptView: "full-unbounded", autoRetry: false }).transcriptView, "full-unbounded");
  assert.equal(normalizeTranscriptView("full"), "full");
});

test("unbounded Full opens actual tool details and keeps every output line", () => {
  const view = normalizeTranscriptView("full-unbounded");
  const text = Array.from({ length: 600 }, (_, at) => `line-${at}`).join("\n");
  const html = renderToStaticMarkup(createElement(ZCodeIntlProvider, {
    initialLocale: "en-US",
    children: createElement(TranscriptViewContext.Provider, { value: view }, createElement(ToolLayout, {
      toolId: "release003-tool", icon: null, kindLabel: "Tool", primaryText: "Summary",
      content: createElement(ExecuteOutput, { text, running: false }),
    })),
  }));
  assert.ok(html.includes("line-0"));
  assert.ok(html.includes("line-599"));
  assert.ok(!html.includes("max-h-[5lh]"));
});

test("Full keeps its bounded output viewport; the fourth mode is reachable", () => {
  const html = renderToStaticMarkup(createElement(TranscriptViewContext.Provider, { value: "full" },
    createElement(ExecuteOutput, { text: "output", running: false })));
  assert.ok(html.includes("max-h-[5lh]"));
  const control = renderToStaticMarkup(createElement(ConversationTranscriptControl, { view: "full", onChange: () => {} }));
  assert.ok(control.includes('data-transcript-choice="full-unbounded"'));
  assert.equal((control.match(/aria-pressed="true"/g) ?? []).length, 1);
});
