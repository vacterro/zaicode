import assert from "node:assert/strict";
import test from "node:test";
import { detectZaicodeTrustInput, detectZaicodeVendorLimit, stripZaicodeAnsi } from "../src/zaicode/zaicodeWorkerSignals.js";

test("actual hook review selects Trust all, including a nonselected choice", () => {
  assert.equal(detectZaicodeTrustInput("Hooks need review\n> 1. Review hooks\n  2. Trust all and continue\n  3. Continue without trusting (hooks won't run)\nenter confirm · esc skip"), "\x1b[B\r");
  assert.equal(detectZaicodeTrustInput("Hooks need review\n  1. Review hooks\n> 2. Trust all and continue\n  3. Continue without trusting (hooks won't run)"), "\r");
  assert.equal(detectZaicodeTrustInput("Hooks need review\n  1. Review hooks\n  2. Trust all and continue\n> 3. Continue without trusting (hooks won't run)"), "\x1b[A\r");
});

test("folder menus select the affirmative choice; explanatory prose cannot approve", () => {
  assert.equal(detectZaicodeTrustInput("Do you trust the files in this folder?\n> 1. No, exit\n  2. Yes, proceed"), "\x1b[B\r");
  assert.equal(detectZaicodeTrustInput("The agent says: Hooks need review, choose Trust all and continue"), null);
  assert.equal(detectZaicodeTrustInput("Hooks need review\n1. Review hooks\n2. Trust all and continue"), null, "no observed selection");
});

test("vendor limits retain their reset but do not classify auth, network, or prose", () => {
  assert.equal(detectZaicodeVendorLimit("claude", "You've hit your session limit · resets 7:40pm (Europe/Tallinn)")?.resetText, "7:40pm (Europe/Tallinn)");
  assert.equal(detectZaicodeVendorLimit("codex", "You've hit your usage limit. Try again in 2 days")?.window, "five_hour");
  assert.equal(detectZaicodeVendorLimit("claude", "Weekly limit reached · resets Mon 9:00")?.window, "weekly");
  assert.equal(detectZaicodeVendorLimit("claude", "You've hit your limit · resets 5pm")?.resetText, "5pm");
  assert.ok(detectZaicodeVendorLimit("antigravity", "Model quota limit exceeded. You have reached the quota limit for Claude."));
  assert.ok(detectZaicodeVendorLimit("zcode", "You have reached your usage limit. Try again in 2 hours"));
  for (const vendor of ["claude", "codex", "antigravity", "zcode"]) {
    for (const text of ["RESOURCE_EXHAUSTED", "429 Too many requests", "Quota exceeded for disk storage", "You need to log in", "The agent reports: you've hit your session limit", "Network timeout"]) assert.equal(detectZaicodeVendorLimit(vendor, text), null, `${vendor}: ${text}`);
  }
  assert.equal(detectZaicodeVendorLimit("codex", "Weekly limit reached · resets Mon 9:00"), null, "another vendor's wording");
});

test("terminal redraw controls and split ANSI still expose the real hook menu", () => {
  const text = stripZaicodeAnsi("\x1b[2J\x1b[1;1HHooks need review\r\n  1. Review hooks\r\n\x1b[33m> 2. Trust all and continue\x1b[0m");
  assert.equal(detectZaicodeTrustInput(text), "\r");
});
