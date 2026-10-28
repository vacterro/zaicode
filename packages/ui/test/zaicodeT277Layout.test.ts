import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { measureZaicodeStatusLane } from "../src/v4/zaicodeStatusLane.js";
import { zaicodeFontChoice, zaicodeFontNeedsTypedName, zaicodeFontSelectValue } from "../src/zaicode/ZaicodeFontSelect.js";

const source = (relative: string) => readFileSync(join(import.meta.dirname, "../src", relative), "utf8");

test("T-277: the status dock reserves the room its visible chips take from the right edge", () => {
  // Dock overlay spans the whole width; the gauge and the changes chip sit at its right end.
  assert.equal(measureZaicodeStatusLane(1600, [{ left: 1240, width: 60 }, { left: 1310, width: 274 }]), 360);
  assert.equal(measureZaicodeStatusLane(1600, [{ left: 900, width: 0 }, { left: 1500, width: 84 }]), 100, "hidden children take no room");
  assert.equal(measureZaicodeStatusLane(1600, []), 0, "no dock, no reservation");
});

test("T-277: one transcript row carries the view choice, older messages and both jump chips", () => {
  const timeline = source("v4/ConversationTimeline.tsx");
  const row = timeline.indexOf('data-zaicode-transcript-row="true"');
  const end = timeline.indexOf("</div>", timeline.indexOf("<ConversationTurnNavStrip", row));
  const body = timeline.slice(row, end);
  for (const part of ["<ConversationTranscriptControl", "Load earlier messages", "<ConversationTurnNavStrip"]) {
    assert.ok(body.includes(part), `${part} lives in the transcript row`);
  }
  assert.equal(timeline.match(/Load earlier messages"/g)?.length, 1, "no second row for older messages");
  assert.match(body, /justify-evenly/);
  assert.match(body, /paddingRight: "calc\(var\(--zaicode-status-lane, 0px\) \+ 0\.75rem\)"/, "the dock's room stays free");
  const control = source("v4/ConversationTranscriptControl.tsx");
  assert.doesNotMatch(control, /border-b/, "the control is a group inside the row, not a row of its own");
  const panel = source("v4/ConversationStatusPanel.tsx");
  assert.equal(panel.match(/ref=\{statusLaneRef\}/g)?.length, 2, "both dock shapes publish their lane");
  assert.match(panel, /const dockTop = isZaicodeProductMode\(\) \? "pt-1" : "pt-4";/, "the dock sits at the row's height");
});

test("T-277: a worker row never paints its label past its frame", () => {
  const row = source("zaicode/ZaicodeSidebarWorkers.tsx");
  assert.match(row, /"group relative flex min-w-0 items-center gap-1 overflow-hidden border px-1"/);
  // Hover buttons cover the row's right end instead of reserving a strip beside the label.
  assert.match(row, /invisible absolute inset-y-0 right-0 flex items-center/);
  const label = source("zaicode/ZaicodeWorkerParts.tsx");
  assert.match(label, /"flex min-w-0 items-center gap-1\.5 overflow-hidden"/);
  assert.match(label, /min-w-0 shrink truncate text-foreground-subtlest/, "the age gives way before anything overflows");
});

test("T-277: every installed family is a choice and is stored as the custom face", () => {
  const installed = ["Arial", "Terminus (TTF) for Windows", "Verdana_m1"];
  assert.deepEqual(zaicodeFontChoice("installed:Terminus (TTF) for Windows"), { id: "custom", custom: "Terminus (TTF) for Windows" });
  assert.deepEqual(zaicodeFontChoice("verdana"), { id: "verdana" });
  assert.deepEqual(zaicodeFontChoice("custom"), { id: "custom", custom: "" }, "typing starts from an empty field");
  assert.equal(zaicodeFontSelectValue("custom", "Verdana_m1", installed), "installed:Verdana_m1");
  assert.equal(zaicodeFontSelectValue("custom", "Not Installed", installed), "custom", "a typed name keeps the typed choice");
  assert.equal(zaicodeFontSelectValue("tahoma", "", installed), "tahoma");
  assert.equal(zaicodeFontNeedsTypedName("custom", "Arial", installed), false);
  assert.equal(zaicodeFontNeedsTypedName("custom", "", installed), true);
  for (const file of ["settings/ZaicodeTypographySettings.tsx", "zaicode/ZaicodeHeaderProjectTitle.tsx"]) {
    assert.match(source(file), /<ZaicodeFontSelect/, `${file} offers the installed list`);
  }
  assert.match(source("zaicode/ZaicodeHeaderProjectTitle.tsx"), /JSON\.stringify\(prefs\.customFont\.trim\(\)\)/, "a family with brackets stays valid CSS");
});
