import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// SRC-060 audit finding: the counter flash used a `key` on the very span that
// hosts the portalled floaters. Changing a key remounts the element, so every
// burst tore the in-flight floaters out of document.body and recreated them,
// restarting `zf-rise` from opacity 0 -- the operator saw the numbers blink and
// jump back rather than float away. The key existed only to re-run the flash
// animation, so the flash is retriggered imperatively instead.

const source = readFileSync(
  join(import.meta.dirname, "..", "src", "zaicode", "ZaicodeChangeCounter.tsx"),
  "utf8",
);

test("the element that hosts the portalled floaters is not remounted", () => {
  // No key anywhere on the anchor span, and none anywhere in the file: a key on
  // any ancestor of the portal is the same defect.
  assert.doesNotMatch(source, /key=\{flash\}/, "the flash key is gone");
  assert.doesNotMatch(source, /key=\{/, "no key on the counter subtree at all");
});

test("the floaters are portalled out of the counter, so a remount would lose them", () => {
  // This is the property the key broke, asserted so the shape stays intentional.
  assert.ok(source.includes("createPortal"), "floaters are portalled to document.body");
  assert.ok(source.includes("data-zaicode-change-counter"), "the anchor is identifiable");
});

test("the flash still retriggers, without a remount", () => {
  assert.ok(source.includes("setFlash((count) => count + 1)"), "a burst still bumps the sequence");
  // The standard retrigger idiom: remove the class, commit, add it back.
  assert.ok(source.includes('classList.remove("zaicode-change-flash")'));
  assert.ok(source.includes("void element.offsetWidth"), "the removal is committed before restoring");
  assert.ok(source.includes('classList.add("zaicode-change-flash")'));
  assert.ok(source.includes("flashRef.current = node"), "the ref points at the same element");
});

test("the flash animation is still declared and still named", () => {
  assert.ok(source.includes("@keyframes zf-flash"), "the keyframes survive");
  assert.ok(source.includes(".zaicode-change-flash{animation:zf-flash"), "the class carries it");
});
