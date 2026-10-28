import assert from "node:assert/strict";
import test from "node:test";
import { controlHintContentClassName } from "../src/ControlHintTooltip.js";

// SRC-058: a hint card that lands under the pointer took the hover from its
// trigger, closed, and reopened in a loop. The card must never take pointer
// events, whatever the caller passes.

function classes(value: string): Set<string> {
  return new Set(value.split(/\s+/).filter(Boolean));
}

test("a hint card never takes pointer events, with or without a description", () => {
  for (const hasDescription of [false, true]) {
    const set = classes(controlHintContentClassName(hasDescription));
    assert.ok(set.has("pointer-events-none"), `pointer-events-none missing (description: ${hasDescription})`);
  }
});

test("a caller's className cannot turn pointer events back on", () => {
  const set = classes(controlHintContentClassName(false, "pointer-events-auto max-w-40"));
  assert.ok(set.has("pointer-events-none"));
  assert.ok(!set.has("pointer-events-auto"));
  assert.ok(set.has("max-w-40"), "the caller's other classes are kept");
});
