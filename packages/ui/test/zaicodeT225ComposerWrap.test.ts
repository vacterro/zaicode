// T-225 / SRC-155 -- composer toolbar buttons must never clip.
//
// The report (screenshot 224259): toolbar buttons clearly do not fit -- an
// unacceptable UI. The fit ladder (useComposerToolbarFit) collapses rungs,
// squeezes the model trigger, and its own comment promises that past the last
// rung "the whole row wraps via CSS" -- but the toolbar root row is a nowrap
// flex row (`group/toolbar flex items-end gap-3`) and the trailing cluster is
// `shrink-0`, so on a narrow row the trailing buttons overflow the row and the
// composer shell (`overflow-hidden`) clips them. The promised last-resort wrap
// does not exist.
//
// These tests pin the last resort: the root row wraps, the trailing cluster
// stays right-aligned on its own line, and the inner clusters keep their wrap.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const src = (path: string) =>
  readFileSync(join(import.meta.dirname, "..", "src", path), "utf8");

const editor = src("prompt-editor/ChatPromptEditor.tsx");

function toolbarRootClass(): string {
  const match = /className=\{cn\("group\/toolbar ([^"]*)"/.exec(editor);
  assert.ok(match, "toolbar root row (group/toolbar) must exist");
  return match[1];
}

test("T-225: the toolbar root row wraps instead of clipping the trailing buttons", () => {
  const root = toolbarRootClass();
  assert.ok(
    /(^|\s)flex-wrap(\s|$)/.test(root),
    `root row must wrap past the last collapse rung, got: "group/toolbar ${root}"`,
  );
});

test("T-225: the wrapped trailing cluster stays right-aligned", () => {
  assert.match(editor, /ml-auto flex [^"]*justify-end/, "trailing keeps ml-auto + justify-end");
  assert.match(
    editor,
    /flex-wrap items-center justify-end gap-1\.5/,
    "the trailing cluster wraps internally too",
  );
});

test("T-225: the leading cluster keeps its own wrap", () => {
  assert.match(
    editor,
    /flex min-w-0 flex-wrap items-center gap-1" data-composer-leading-content/,
    "leading content wraps when the ladder is exhausted",
  );
});
