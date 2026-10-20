import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// REQ-002: composer toolbar collision repair. No packaged Electron here, so
// the source pins the anti-overlap invariants instead: every multi-control
// row in the composer path wraps or truncates, the fit ladder owns the
// toolbar root, and every collapsible control carries a collapse priority.
// Genuine packaged-visual replay stays deferred to the operator (SRC-186).
const source = (relative: string) => readFileSync(join(import.meta.dirname, "..", "src", relative), "utf8");

test("REQ-002: the toolbar root fits and both clusters wrap instead of overlapping", () => {
  const editor = source("prompt-editor/ChatPromptEditor.tsx");
  assert.match(editor, /const toolbarRef = useComposerToolbarFit\(\);/, "the fit ladder owns the toolbar");
  assert.match(editor, /data-zaicode-composer-toolbar/, "the fit root is marked");
  assert.match(editor, /data-composer-leading-content/, "leading cluster exists");
  assert.match(editor, /data-composer-trailing-actions/, "trailing cluster exists");
  const leadingAt = editor.indexOf("data-composer-leading-content");
  assert.ok(leadingAt > 0, "leading cluster exists");
  assert.ok(
    editor.slice(Math.max(0, leadingAt - 300), leadingAt).includes("flex min-w-0 flex-wrap items-center gap-1"),
    "leading content wraps",
  );
  const trailing = editor.slice(editor.indexOf("data-composer-trailing-actions") - 200, editor.indexOf("data-composer-trailing-actions"));
  assert.match(trailing, /flex-wrap/, "trailing cluster wraps its buttons");
});

test("REQ-002: SAIPEN strip rows wrap or truncate, full and compact", () => {
  const strip = source("prompt-editor/ZaicodeSaipenControls.tsx");
  for (const row of [
    "flex min-w-0 flex-wrap items-center gap-1",
    "flex min-w-0 flex-col gap-1 border-t border-border pt-2 text-ui-xs",
    "flex min-w-0 flex-col gap-1.5 border-t border-border pt-2 text-ui-xs",
  ]) {
    assert.ok(strip.includes(row), `strip keeps ${row}`);
  }
  const compact = source("prompt-editor/ZaicodeSaipenCompact.tsx");
  assert.match(compact, /flex min-w-0 flex-wrap items-center gap-1/, "compact row wraps");
  assert.match(compact, /min-w-0 flex-1 truncate/, "compact lines truncate instead of pushing");
  assert.match(compact, /data-zaicode-saipen-modes/, "modes row is marked");
});

test("REQ-002: every collapsible toolbar control has a collapse priority", () => {
  const controls = source("v4/composer/V4ComposerModeControls.tsx");
  assert.match(controls, /data-composer-collapse-priority="0"/);
  assert.match(controls, /data-composer-collapse-priority="2"/);
  assert.match(source("v4/composer/V4ComposerCuaEntry.tsx"), /data-composer-collapse-priority="1"/);
  assert.match(source("zaicode/ZaicodeComposerWorkingFor.tsx"), /data-composer-collapse-priority="3"/);
  assert.match(source("zaicode/ZaicodeAutoRetryButton.tsx"), /data-composer-collapse-priority="4"/);
  const fit = source("prompt-editor/useComposerToolbarFit.ts");
  assert.match(fit, /data-composer-collapse-priority/, "the ladder reads priorities");
  assert.match(fit, /composer-model-trigger/, "exhausted ladder falls back to the model name, never to overlap");
});

test("REQ-002: TODO todometer keeps its badge clear of the bar", () => {
  const gauge = source("v4/ZaicodeTodoGauge.tsx");
  assert.match(gauge, /data-zaicode-queue-todometer/, "todometer row is marked");
  assert.match(gauge, /flex min-w-0 flex-1 items-center gap-2/, "the bar gives way");
  assert.match(gauge, /shrink-0 whitespace-nowrap/, "the count badge never wraps under the bar");
});

test("REQ-002: transcript controls stay inside the transcript row (read-only contract)", () => {
  const timeline = source("v4/ConversationTimeline.tsx");
  assert.match(timeline, /data-zaicode-transcript-row="true"/, "one transcript row owns the controls");
  assert.match(source("v4/ConversationTranscriptControl.tsx"), /ConversationTranscriptControl/, "control module intact");
});

test("REQ-002: STOP and SEND occupy a stable right-edge primary action slot", () => {
  const composer = source("v4/ConversationComposer.tsx");
  assert.match(
    composer,
    /data-zaicode-primary-action-slot="true"/,
    "primary action slot is explicitly marked and stable",
  );
  const slotIdx = composer.indexOf('data-zaicode-primary-action-slot="true"');
  assert.ok(slotIdx > 0, "slot exists");
  const slotContent = composer.slice(slotIdx, slotIdx + 1500);
  assert.match(slotContent, /TID_V4_STOP/, "STOP button sits inside primary action slot");
  assert.match(slotContent, /TID_V4_COMPOSER_SEND/, "SEND button sits inside primary action slot");
  assert.match(slotContent, /size-8 shrink-0/, "both actions share fixed non-drifting dimension");
});

test("T-298: the primary action is a sibling of the shrinking controls, pinned right by the toolbar", () => {
  const editor = source("prompt-editor/ChatPromptEditor.tsx");
  assert.match(editor, /primaryAction\?: ReactNode;/, "the editor takes the primary action");
  assert.match(editor, /\{primaryAction \? \(/, "the editor renders it explicitly");
  const trailing = editor.slice(editor.indexOf("data-composer-trailing-actions"));
  assert.match(trailing, /ml-auto flex shrink-0 items-center/, "the primary wrapper claims the right edge");
  assert.ok(
    trailing.indexOf("{submitControl") < trailing.indexOf("primaryAction ?"),
    "every other control renders before the primary action",
  );
  assert.match(editor, /className="ml-auto flex min-w-0 flex-1 flex-wrap items-center justify-end gap-1\.5"/, "the trailing cluster still wraps before displacing the primary action");

  const composer = source("v4/ConversationComposer.tsx");
  assert.match(composer, /primaryAction=\{primaryActionNode\}/, "the composer passes its primary action");
  assert.match(composer, /submitControl=\{submitControlsNode\}/, "model cluster and primary action are separate nodes");
  assert.ok(
    composer.indexOf("const primaryActionNode") > composer.indexOf("const submitControlsNode"),
    "the primary action is not built inside the model-controls cluster",
  );
  // The primary slot must sit after the submit-controls cluster closes.
  const clusterIdx = composer.indexOf("data-zaicode-submit-controls");
  const slotIdx = composer.indexOf('data-zaicode-primary-action-slot="true"');
  assert.ok(clusterIdx > 0 && slotIdx > clusterIdx, "slot follows the cluster");
  assert.match(composer.slice(clusterIdx, slotIdx), /<\/div>\s*\n\s*\),/, "the cluster closes before the slot");
});

test("T-298: the fit ladder never collapses or clips the primary action", () => {
  const composer = source("v4/ConversationComposer.tsx");
  const slotIdx = composer.indexOf('data-zaicode-primary-action-slot="true"');
  const around = composer.slice(slotIdx - 200, slotIdx + 2200);
  assert.doesNotMatch(around, /data-composer-collapse-priority/, "the primary action has no collapse rung");
  const fit = source("prompt-editor/useComposerToolbarFit.ts");
  assert.doesNotMatch(fit, /primary-action-slot/, "the ladder never targets the primary action");
  // Send and Stop share one footprint, so switching never moves the centre.
  assert.match(around, /className="flex size-8 shrink-0 items-center justify-center"/);
});

