import assert from "node:assert/strict";
import test from "node:test";
import { ZAICODE_APP_INTERACTIVE_EVENT } from "@zcode/shared";
import {
  announceZaicodeAppInteractive,
  zaicodeStartupNeedsOperator,
} from "../src/zaicode/zaicodeStartupReady.js";

// SRC-060: the start-up picture gives way when the interface is usable, not at
// React's first frame (the grey database start-up screen). Only a start-up
// screen the operator must read (an error or a migration) counts as ready early.

test("only a failed start-up or a running migration is shown to the operator early", () => {
  assert.equal(zaicodeStartupNeedsOperator(null), false);
  assert.equal(zaicodeStartupNeedsOperator({ phase: "checking" }), false);
  assert.equal(zaicodeStartupNeedsOperator({ phase: "ready", migration: { kind: "none" } }), false);
  assert.equal(zaicodeStartupNeedsOperator({ phase: "migrating", migration: { kind: "schema" } }), true);
  assert.equal(zaicodeStartupNeedsOperator({ phase: "failed" }), true);
});

test("the interactive event fires once per window, after the next frames", async () => {
  const events: string[] = [];
  const target = new EventTarget();
  target.addEventListener(ZAICODE_APP_INTERACTIVE_EVENT, (event) => events.push(event.type));
  const frames: (() => void)[] = [];
  (globalThis as { window?: unknown }).window = Object.assign(target, {
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
  });
  try {
    announceZaicodeAppInteractive();
    announceZaicodeAppInteractive();
    assert.deepEqual(events, [], "not before the first real frame paints");
    frames.shift()!();
    frames.shift()!();
    assert.deepEqual(events, [ZAICODE_APP_INTERACTIVE_EVENT]);
    assert.equal(frames.length, 0, "the second call did not schedule another announcement");
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
});
