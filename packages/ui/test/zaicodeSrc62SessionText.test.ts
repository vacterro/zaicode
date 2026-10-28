import assert from "node:assert/strict";
import test from "node:test";
import { zaicodeSessionTextCss, zaicodeTextStyleDeclarations } from "../src/zaicode/zaicodeSessionTextCss.js";
import { ZAICODE_TEXT_STYLE_DEFAULT, zaicodeSessionTextDefaults } from "../src/zaicode/zaicodeSessionTextModel.js";
import { normalizeZaicodeSessionText } from "../src/zaicode/zaicodeSessionTextNormalize.js";
import {
  ZAICODE_SESSION_TEXT_BUILT_INS,
  applyZaicodeSessionTextPatch,
  exportZaicodeSessionTextPresets,
  parseZaicodeSessionTextPresets,
} from "../src/zaicode/zaicodeSessionTextPresets.js";

// SRC-062: "full control over the main text in sessions, like in Word: the
// font, what happens when the agent underlines something, the headers --
// everything rich and nicely configurable, with presets".

test("untouched settings write no CSS at all: the app's look stays", () => {
  assert.equal(zaicodeSessionTextCss(zaicodeSessionTextDefaults()), "");
  assert.deepEqual(zaicodeTextStyleDeclarations(ZAICODE_TEXT_STYLE_DEFAULT), []);
  assert.equal(zaicodeSessionTextCss({ ...zaicodeSessionTextDefaults(), enabled: false, body: { ...zaicodeSessionTextDefaults().body, sizePx: 20 } }), "");
});

test("every rule is scoped to an answer's markdown and beats pixel mode's !important font", () => {
  const prefs = applyZaicodeSessionTextPatch(zaicodeSessionTextDefaults(), {
    body: { font: "georgia", sizePx: 17, lineHeight: 1.6, align: "justify", indentPx: 24 },
    headings: { h1: { font: "cambria", color: "#365f91", rule: "under", ruleColor: "#4f81bd" } },
  });
  const css = zaicodeSessionTextCss(prefs);
  for (const line of css.split("\n")) assert.match(line, /^html\.zaicode-session-text \.zaicode-md/, line);
  assert.match(css, /html\.zaicode-session-text \.zaicode-md\{font-family:Georgia, "Times New Roman", serif !important;font-size:17px !important;line-height:1\.6 !important;text-align:justify !important\}/);
  assert.match(css, /\.zaicode-md p\{text-indent:24px !important\}/);
  assert.match(css, /\.zaicode-md h1\{[^}]*color:#365f91 !important;border-bottom:1px solid #4f81bd !important/);
});

test("underline is real: style, colour, thickness and distance; 'no line' removes one", () => {
  const style = { ...ZAICODE_TEXT_STYLE_DEFAULT, decoration: "wavy" as const, decorationColor: "#ff0000", decorationThickness: 2, underlineOffset: 4 };
  assert.deepEqual(zaicodeTextStyleDeclarations(style), [
    "text-decoration-line:underline",
    "text-decoration-style:wavy",
    "text-decoration-color:#ff0000",
    "text-decoration-thickness:2px",
    "text-underline-offset:4px",
  ]);
  assert.deepEqual(zaicodeTextStyleDeclarations({ ...ZAICODE_TEXT_STYLE_DEFAULT, decoration: "none" }), ["text-decoration-line:none"]);
  const links = zaicodeSessionTextCss(applyZaicodeSessionTextPatch(zaicodeSessionTextDefaults(), { link: { underline: "hover", hoverColor: "#00ff00" } }));
  assert.match(links, /\.zaicode-md a,html\.zaicode-session-text \.zaicode-md \.zaicode-md-link\{text-decoration-line:none !important\}/);
  assert.match(links, /a:hover,[^{]*\.zaicode-md-link:hover\{text-decoration-line:underline !important;color:#00ff00 !important\}/);
});

test("Word-like heading numbers, bullets and list numbers", () => {
  const css = zaicodeSessionTextCss(
    applyZaicodeSessionTextPatch(zaicodeSessionTextDefaults(), { numberHeadings: true, list: { bullet: "▸", numbers: "upper-roman", markerColor: "#7fc35a" } }),
  );
  assert.match(css, /h2::before\{content:counter\(zmd-h1\) "\." counter\(zmd-h2\) " "\}/);
  assert.match(css, /\.zaicode-md ul\{list-style-type:"▸ " !important\}/);
  assert.match(css, /\.zaicode-md ol\{list-style-type:upper-roman !important\}/);
  assert.match(css, /li::marker\{color:#7fc35a !important\}/);
});

test("stored settings normalize: bad colours, CSS in font names and out-of-range numbers never reach the page", () => {
  const prefs = normalizeZaicodeSessionText({
    body: { sizePx: 500, lineHeight: 9, color: "red", font: "comic" },
    headings: { h2: { customFont: 'Evil"; } body { display:none', font: "custom", weight: 1234 } },
    list: { bullet: "💥" },
    rule: { style: "groovy", thicknessPx: 99 },
  });
  assert.equal(prefs.body.sizePx, 72);
  assert.equal(prefs.body.lineHeight, 3);
  assert.equal(prefs.body.color, "");
  assert.equal(prefs.body.font, "inherit");
  assert.equal(prefs.headings.h2.customFont.includes('"'), false);
  assert.equal(prefs.headings.h2.customFont.includes(";"), false);
  assert.equal(prefs.headings.h2.customFont.includes("{"), false);
  assert.equal(prefs.headings.h2.weight, 900);
  assert.equal(prefs.list.bullet, "default");
  assert.equal(prefs.rule.style, "solid");
  assert.equal(prefs.rule.thicknessPx, 8);
  assert.deepEqual(normalizeZaicodeSessionText(null), zaicodeSessionTextDefaults());
});

test("presets: every built-in is a complete, different look; own presets round-trip through a file", () => {
  const ids = ZAICODE_SESSION_TEXT_BUILT_INS.map((preset) => preset.id);
  assert.deepEqual(ids.slice(0, 3), ["app", "word", "book"]);
  const looks = new Set(ZAICODE_SESSION_TEXT_BUILT_INS.map((preset) => zaicodeSessionTextCss(preset.prefs)));
  assert.equal(looks.size, ZAICODE_SESSION_TEXT_BUILT_INS.length, "no two presets look the same");
  assert.equal(zaicodeSessionTextCss(ZAICODE_SESSION_TEXT_BUILT_INS[0]!.prefs), "", "'As the app' changes nothing");
  const own = [{ id: "own-1", name: "Mine", hint: "", builtIn: false, prefs: ZAICODE_SESSION_TEXT_BUILT_INS[1]!.prefs }];
  const file = exportZaicodeSessionTextPresets([...ZAICODE_SESSION_TEXT_BUILT_INS, ...own]);
  const back = parseZaicodeSessionTextPresets(file, ["Mine"]);
  assert.equal(back.length, 1, "built-ins are not exported");
  assert.equal(back[0]!.name, "Mine (2)", "an imported name never overwrites one of ours");
  assert.deepEqual(back[0]!.prefs, own[0]!.prefs);
  assert.throws(() => parseZaicodeSessionTextPresets('{"kind":"other"}', []), /not a ZAICODE session-text preset file/);
});
