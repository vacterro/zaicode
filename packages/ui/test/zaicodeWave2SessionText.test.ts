import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ZAICODE_SESSION_TEXT_DOCUMENT_KIND,
  describeZaicodeSessionTextDocument,
  exportZaicodeSessionTextDocument,
  parseZaicodeSessionTextDocument,
  sameZaicodeSessionText,
} from "@/zaicode/zaicodeSessionTextDocument.js";
import {
  ZAICODE_USER_TEXT_ROOT,
  zaicodeAllSessionTextCss,
  zaicodeSessionTextCss,
  zaicodeUserTextCss,
} from "@/zaicode/zaicodeSessionTextCss.js";
import { zaicodeSessionTextDefaults } from "@/zaicode/zaicodeSessionTextModel.js";
import { normalizeZaicodeSessionText } from "@/zaicode/zaicodeSessionTextNormalize.js";
import { applyZaicodeSessionTextPatch } from "@/zaicode/zaicodeSessionTextPresets.js";

/**
 * Wave 2, part A and B: Session text Save / Export / Import, and the
 * user-message style domain that shares the same schema.
 */

/** Every supported field set to something non-default, including the user domain. */
function fullPrefs() {
  return normalizeZaicodeSessionText(
    applyZaicodeSessionTextPatch(zaicodeSessionTextDefaults(), {
      enabled: true,
      numberHeadings: true,
      body: { font: "georgia", customFont: "", sizePx: 17, weight: 400, lineHeight: 1.65, align: "justify", maxWidthCh: 88, indentPx: 12, hyphens: true, selection: "#123456", color: "#222222", letterSpacing: 4, marginTop: 4, marginBottom: 9 },
      headings: { h1: { font: "cambria", sizePx: 26, weight: 700, rule: "under", ruleColor: "#4f81bd" }, h4: { sizePx: 15, color: "#010203" } },
      strong: { weight: 800, textCase: "uppercase" },
      em: { italic: "on", decoration: "wavy" },
      del: { decoration: "solid", decorationColor: "#ff0000", decorationThickness: 2, underlineOffset: 3 },
      link: { color: "#0563c1", underline: "hover", hoverColor: "#ff8800" },
      inlineCode: { font: "consolas", border: "#00ff00", paddingPx: 3, background: "#eeeeee" },
      quote: { barColor: "#4f81bd", barWidthPx: 4, indentPx: 16, italic: "on" },
      list: { bullet: "▸", numbers: "upper-roman", markerColor: "#7fc35a", indentPx: 20, gapPx: 5 },
      table: { borderColor: "#8eaadb", headerBackground: "#d9e2f3", zebra: true, cellPaddingPx: 6 },
      rule: { style: "dashed", color: "#333333", thicknessPx: 3, marginPx: 12 },
      userMessage: {
        mode: "separate",
        style: { font: "tahoma", sizePx: 15, weight: 600, lineHeight: 1.4, align: "center", color: "#101010", background: "#202020", borderColor: "#303030", borderWidthPx: 2, borderRadiusPx: 6, paddingPx: 10, letterSpacing: 2 },
      },
    }),
  );
}

test("Wave 2 A: export -> reset -> import is a round-trip for every supported field", () => {
  const prefs = fullPrefs();
  const file = exportZaicodeSessionTextDocument(prefs, [], new Date("2026-09-28T12:00:00Z"));

  const parsed = JSON.parse(file) as Record<string, unknown>;
  assert.equal(parsed.kind, ZAICODE_SESSION_TEXT_DOCUMENT_KIND);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.exportedAt, "2026-09-28T12:00:00.000Z");

  // The artifact is the whole settings object, not a projection of it.
  const exported = parsed.prefs as Record<string, unknown>;
  for (const key of Object.keys(zaicodeSessionTextDefaults())) {
    assert.ok(key in exported, `the export is missing ${key}`);
  }

  // reset -> the app default; import -> the exported value, field for field.
  const defaults = zaicodeSessionTextDefaults();
  assert.equal(sameZaicodeSessionText(defaults, prefs), false);
  const restored = parseZaicodeSessionTextDocument(file);
  assert.equal(sameZaicodeSessionText(restored.prefs, prefs), true);
  assert.deepEqual(restored.prefs.userMessage, prefs.userMessage);

  // A second export of the restored value is byte-identical apart from the timestamp.
  const again = JSON.parse(exportZaicodeSessionTextDocument(restored.prefs, [], new Date("2026-09-28T12:00:00Z")));
  assert.equal(JSON.stringify(again), JSON.stringify(parsed));
});

test("Wave 2 A: a foreign file, a wrong version and a broken file all fail without a document", () => {
  const prefs = fullPrefs();
  const file = exportZaicodeSessionTextDocument(prefs, []);

  assert.throws(() => parseZaicodeSessionTextDocument("{not json"), /nothing was changed/i);
  assert.throws(() => parseZaicodeSessionTextDocument("[]"), /not a ZAICODE session-text file/i);
  assert.throws(
    () => parseZaicodeSessionTextDocument(JSON.stringify({ kind: "zaicode.session-text", version: 99, prefs: {} })),
    /Version 99/,
  );
  assert.throws(
    () => parseZaicodeSessionTextDocument(JSON.stringify({ kind: "zaicode.session-text", version: 1 })),
    /no settings/i,
  );
  assert.throws(
    () => parseZaicodeSessionTextDocument(JSON.stringify({ kind: "zaicode.session-text", version: 1, prefs: {}, presets: {} })),
    /not a list/i,
  );

  // The preset file is a different kind on purpose: one model, no half of it.
  assert.throws(
    () => parseZaicodeSessionTextDocument(JSON.stringify({ kind: "zaicode-session-text-presets", version: 1, presets: [] })),
    /not a ZAICODE session-text file/i,
  );
});

test("Wave 2 A: the import description says what it replaces, before it replaces it", () => {
  const description = describeZaicodeSessionTextDocument(
    parseZaicodeSessionTextDocument(exportZaicodeSessionTextDocument(fullPrefs(), [], new Date("2026-09-28T12:00:00Z"))),
  );
  assert.match(description, /2026-09-28 12:00 UTC/);
  assert.match(description, /their own style/);
  assert.match(description, /REPLACES your current Session text settings/i);
  assert.match(description, /cannot be undone/i);
});

test("Wave 2 A: an export of the defaults carries every field, and re-imports to the defaults", () => {
  const defaults = zaicodeSessionTextDefaults();
  const restored = parseZaicodeSessionTextDocument(exportZaicodeSessionTextDocument(defaults, []));
  assert.equal(sameZaicodeSessionText(restored.prefs, defaults), true);
  assert.equal(restored.prefs.userMessage.mode, "default");
});

test("Wave 2 B: a stored file from before the user domain still loads, and reads as Default", () => {
  const legacy = JSON.parse(exportZaicodeSessionTextDocument(fullPrefs(), [])) as { prefs: Record<string, unknown> };
  delete legacy.prefs.userMessage;
  const restored = parseZaicodeSessionTextDocument(JSON.stringify(legacy));
  assert.equal(restored.prefs.userMessage.mode, "default");
  assert.deepEqual(restored.prefs.userMessage.style, zaicodeSessionTextDefaults().userMessage.style);
  // ... and the rest of the file still round-trips.
  assert.equal(restored.prefs.body.font, "georgia");
  assert.equal(restored.prefs.userMessage.style.borderWidthPx, -1);
});

test("Wave 2 B: Default makes the user's own text follow the shared body theme", () => {
  const defaults = zaicodeSessionTextDefaults();
  assert.equal(zaicodeUserTextCss(defaults), "", "an untouched Default writes no rule at all");

  const bodyOnly = applyZaicodeSessionTextPatch(defaults, { body: { font: "georgia", sizePx: 19, lineHeight: 1.7 } });
  const css = zaicodeUserTextCss(bodyOnly);
  assert.match(css, new RegExp(`^\\${ZAICODE_USER_TEXT_ROOT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\{`));
  assert.match(css, /font-family:Georgia/);
  assert.match(css, /font-size:19px/);
  assert.match(css, /line-height:1\.7/);
  // The bubble keeps the app's own frame in Default; only typography is shared.
  assert.doesNotMatch(css, /border-radius/);
  assert.doesNotMatch(css, /padding:/);
});

test("Wave 2 B: Separate styles the user's own text, frame included, and nothing of the agent's", () => {
  const separate = applyZaicodeSessionTextPatch(zaicodeSessionTextDefaults(), {
    body: { font: "georgia", sizePx: 19 },
    userMessage: {
      mode: "separate",
      style: { font: "tahoma", sizePx: 15, weight: 600, lineHeight: 1.4, align: "center", color: "#101010", borderColor: "#303030", borderWidthPx: 2, borderRadiusPx: 6, paddingPx: 10 },
    },
  });
  const css = zaicodeUserTextCss(separate);
  assert.match(css, /font-family:Tahoma/);
  assert.match(css, /font-weight:600/);
  assert.match(css, /color:#101010/);
  assert.match(css, /text-align:center/);
  assert.match(css, /border:2px solid #303030/);
  assert.match(css, /border-radius:6px/);
  assert.match(css, /padding:10px/);
  assert.doesNotMatch(css, /Georgia/, "Separate does not leak the agent's body font into the user scope");

  // Every user rule sits under the user root, never under the agent root.
  for (const line of css.split("\n")) {
    assert.ok(line.startsWith(ZAICODE_USER_TEXT_ROOT), line);
  }
});

test("Wave 2 B: the agent stylesheet is unchanged by a user domain (no duplicated rendering)", () => {
  const withUser = fullPrefs();
  const withoutUser = normalizeZaicodeSessionText({ ...withUser, userMessage: zaicodeSessionTextDefaults().userMessage });
  assert.equal(zaicodeSessionTextCss(withUser), zaicodeSessionTextCss(withoutUser));
  assert.ok(zaicodeAllSessionTextCss(withUser).length > zaicodeSessionTextCss(withUser).length);
});

test("Wave 2 B: switching the master switch off removes both scopes", () => {
  const off = applyZaicodeSessionTextPatch(fullPrefs(), { enabled: false });
  assert.equal(zaicodeAllSessionTextCss(off), "");
});

test("Wave 2 B: a hostile stored user style is clamped, never painted as CSS", () => {
  const hostile = normalizeZaicodeSessionText({
    userMessage: { mode: "separate", style: { borderWidthPx: 900, borderRadiusPx: -4, paddingPx: 9999, lineHeight: 42, align: "sideways", borderColor: "red", color: "expression(alert(1))", customFont: 'Evil"; }' } },
  });
  assert.equal(hostile.userMessage.style.borderWidthPx, 12);
  assert.equal(hostile.userMessage.style.borderRadiusPx, -1);
  assert.equal(hostile.userMessage.style.paddingPx, 48);
  assert.equal(hostile.userMessage.style.lineHeight, 3);
  assert.equal(hostile.userMessage.style.align, "inherit");
  assert.equal(hostile.userMessage.style.borderColor, "");
  assert.equal(hostile.userMessage.style.color, "");
  assert.equal(hostile.userMessage.style.customFont, "Evil");
});
