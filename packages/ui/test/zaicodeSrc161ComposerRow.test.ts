// SRC-161:REQ-008 (T-240) -- the composer attachment `+` must never occupy its own
// otherwise empty row.
//
// Reported live: the packaged composer showed the attachment `+` alone on a strip of
// blank space, with the rest of the toolbar on the next line -- a visibly oversized
// composer. Two contracts keep that state out:
//
//  1. The fit ladder must treat an ALREADY WRAPPED row as an overflow. It used to sum
//     `extent(leading) + extent(trailing) + gap - width` as if both clusters shared a
//     line; once the browser wrapped them, that sum could read "fits" on a two-row
//     layout, so every rung was satisfied by the broken row (the false fit below is
//     the red control for this).
//  2. The leading cluster must hug its content. It used to be `flex-1`, so a leading
//     cluster whose controls had all collapsed (leaving only the `+`) stretched its
//     row to the full composer width -- the blank strip itself.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  COMPOSER_WRAPPED_ROW_OVERFLOW_PX,
  composerRowOverflowPx,
  quantizeFitPx,
} from "../src/prompt-editor/composerFitDecision.js";

const src = (path: string) =>
  readFileSync(join(import.meta.dirname, "..", "src", path), "utf8");

test("SRC-161:REQ-008 a row that still shares one line reports its real overflow", () => {
  assert.equal(
    composerRowOverflowPx({ leadingExtent: 28, trailingExtent: 240, width: 400, gap: 12, sameRow: true }),
    0,
    "one row with room to spare does not overflow",
  );
  assert.equal(
    composerRowOverflowPx({ leadingExtent: 200, trailingExtent: 300, width: 400, gap: 12, sameRow: true }),
    112,
    "one row that does not fit reports the shortfall in whole pixels",
  );
});

test("SRC-161:REQ-008 an already wrapped row is an overflow even when the widths would fit side by side", () => {
  const args = { leadingExtent: 28, trailingExtent: 240, width: 400, gap: 12, sameRow: false };
  // The red control: the pre-fix measurement -- exactly the expression the ladder used
  // to compute -- reads "fits" (0) on this row, which is why the broken row survived.
  const oldMeasure = quantizeFitPx(Math.max(0, args.leadingExtent + args.trailingExtent + args.gap - args.width));
  assert.equal(oldMeasure, 0, "the old sum genuinely reads 'fits' for this wrapped row");
  assert.ok(
    composerRowOverflowPx(args) >= COMPOSER_WRAPPED_ROW_OVERFLOW_PX,
    "a wrapped row must never be reported as fitting",
  );
});

test("SRC-161:REQ-008 a wrapped row that is also too wide keeps the larger shortfall", () => {
  assert.equal(
    composerRowOverflowPx({ leadingExtent: 300, trailingExtent: 300, width: 400, gap: 12, sameRow: false }),
    212,
    "the real shortfall wins over the wrapped-row floor",
  );
});

test("SRC-161:REQ-008 the fit ladder measures wrap, not just widths", () => {
  const hook = src("prompt-editor/useComposerToolbarFit.ts");
  assert.ok(
    hook.includes("composerRowOverflowPx("),
    "the ladder must decide through the wrap-aware measurement",
  );
  assert.ok(
    hook.includes("sameRow: sameRow()"),
    "the wrap check must be live geometry, not a constant",
  );
  assert.ok(
    /const sameRow = \(\) => \{[\s\S]*?getBoundingClientRect\(\)/.test(hook),
    "the wrap check reads the live cluster boxes",
  );
});

test("SRC-161:REQ-008 a leading cluster holding only the attachment + cannot stretch a blank row", () => {
  const editor = src("prompt-editor/ChatPromptEditor.tsx");
  const leading = /className="([^"]*)" data-composer-leading-actions/.exec(editor);
  assert.ok(leading, "the leading cluster must exist");
  const classes = leading![1];
  assert.ok(
    !/(^|\s)flex-1(\s|$)/.test(classes),
    `the leading cluster must hug its content, got: "${classes}"`,
  );
  assert.ok(
    /(^|\s)min-w-0(\s|$)/.test(classes),
    `the leading cluster still shrinks so the model label can truncate, got: "${classes}"`,
  );
  // T-225 keeps the inner cluster's own wrap: past the last rung the row may wrap, it
  // just may not wrap into a full-width strip.
  assert.match(
    editor,
    /flex min-w-0 flex-wrap items-center gap-1" data-composer-leading-content/,
    "the leading content keeps its own wrap (T-225)",
  );
});
