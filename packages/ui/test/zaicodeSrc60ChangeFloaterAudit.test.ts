import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// SRC-060 audit finding: the counter flash used a `key` on the very span that
// hosted the portalled floaters. Changing a key remounts the element, so every
// burst tore the in-flight floaters out of document.body and recreated them,
// restarting `zf-rise` from opacity 0 -- the operator saw the numbers blink and
// jump back rather than float away.
//
// SRC-062 moved every number into one layer of plain DOM nodes outside React
// (zaicodeFloaterLayer), shared by the Changes counter and the chat's Edit
// rows. The property the audit protects is now structural: no React render of
// the counter owns a number in flight. These checks keep it that way.

const counter = readFileSync(join(import.meta.dirname, "..", "src", "zaicode", "ZaicodeChangeCounter.tsx"), "utf8");
const layer = readFileSync(join(import.meta.dirname, "..", "src", "zaicode", "zaicodeFloaterLayer.ts"), "utf8");

test("the counter subtree carries no key, and it renders no number itself", () => {
  assert.doesNotMatch(counter, /key=\{/, "no key on the counter subtree at all");
  assert.doesNotMatch(counter, /createPortal|zaicode-floater"/, "numbers are not React children of the counter");
  assert.ok(counter.includes("launchZaicodeFloaters"), "the counter hands its numbers to the layer");
  assert.ok(counter.includes("data-zaicode-change-counter"), "the anchor is identifiable");
});

test("numbers are plain nodes in one fixed layer on <body>, removed on their own timer", () => {
  assert.ok(layer.includes('document.createElement("span")'));
  assert.ok(layer.includes("document.body.appendChild(host)"));
  assert.ok(layer.includes("element.remove()"));
});

test("the flash still retriggers on the same element, without a remount", () => {
  assert.ok(layer.includes('classList.remove("zaicode-change-flash")'));
  assert.ok(layer.includes("void element.offsetWidth"), "the removal is committed before restoring");
  assert.ok(layer.includes('classList.add("zaicode-change-flash")'));
  assert.ok(counter.includes("flashZaicodeChange(anchor.current"), "the counter flashes its own anchor");
});

test("the flash animation is still declared and still named", () => {
  assert.ok(layer.includes("@keyframes zf-flash"), "the keyframes survive");
  assert.ok(layer.includes(".zaicode-change-flash{animation:zf-flash"), "the class carries it");
});
