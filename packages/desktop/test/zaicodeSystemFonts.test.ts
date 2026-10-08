import assert from "node:assert/strict";
import test from "node:test";
import { listZaicodeSystemFonts, parseZaicodeFontFamilies } from "../src/main/zaicodeSystemFonts.js";

test("installed families are unique, sorted and without vertical @ variants", () => {
  assert.deepEqual(parseZaicodeFontFamilies("Verdana\r\n@MS Gothic\r\nArial\r\nverdana_m1\r\n\r\nArial\r\nTerminus (TTF) for Windows\r\n"), [
    "Arial",
    "Terminus (TTF) for Windows",
    "Verdana",
    "verdana_m1",
  ]);
  assert.deepEqual(parseZaicodeFontFamilies(""), []);
});

test("the Windows list names the installed system and per-user families", { skip: process.platform !== "win32" }, async () => {
  const fonts = await listZaicodeSystemFonts();
  assert.ok(fonts.length > 20, `listed ${fonts.length} families`);
  assert.ok(fonts.includes("Arial") && fonts.includes("Verdana"), "core Windows families are present");
  assert.strictEqual(await listZaicodeSystemFonts(), fonts, "one probe per session");
});
