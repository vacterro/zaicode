import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { QueueState } from "@zcode/shared/zcode-protocol-v4";
import {
  selectNewestEditableQueuedItem,
  type EditableQueueItem,
} from "../src/v4/queuedComposerEdit.js";
import {
  isQueueItemEditable,
  queueEditAppliedInProjection,
  queueEditOutcome,
  resolveEditableQueueItem,
} from "../src/v4/queueInlineEdit.js";

// T-394 (SRC-297): a queued message is edited in place, from the queue row itself.
// The composer is never touched, nothing is deleted, and success is only claimed
// after the authoritative projection shows the new text.

const SOURCE = (path: string) =>
  readFileSync(join(import.meta.dirname, "..", "src", path), "utf8").replace(/\r\n/g, "\n");

type ItemOptions = {
  id: string;
  admissionSeq: number;
  admittedAt?: number;
  text?: string;
  kind?: EditableQueueItem["kind"];
  dispatch?: EditableQueueItem["dispatch"]["state"];
  steer?: EditableQueueItem["steer"]["state"];
  provenance?: EditableQueueItem["provenance"];
};

function item({
  id,
  admissionSeq,
  admittedAt = admissionSeq,
  text = `text-${id}`,
  kind = "sendText",
  dispatch = "queued",
  steer = "notRequested",
  provenance = { sourceCommandId: `cmd-${id}`, origin: "real_user", source: "operator_ingress", humanAuthored: true },
}: ItemOptions): EditableQueueItem {
  return {
    sourceCommandId: `cmd-${id}`,
    queueItemId: id,
    clientId: "client",
    kind,
    text,
    attachments: [{ id: `att-${id}`, kind: "file", name: `${id}.txt` }],
    delivery: { requested: "queue", admitted: "queue" },
    order: { admissionSeq },
    steer: { state: steer },
    dispatch: { state: dispatch },
    admittedAt,
    modelSelection: { provider: "provider-a", model: "model-a", effort: "high" },
    provenance,
  } as EditableQueueItem;
}

function queue(...items: EditableQueueItem[]): QueueState {
  return { items, autoDrain: false };
}

test("newest eligible item wins by admission sequence, not array order", () => {
  const selected = selectNewestEditableQueuedItem(
    queue(item({ id: "newest", admissionSeq: 9 }), item({ id: "oldest", admissionSeq: 2 })),
  );
  assert.equal(selected?.queueItemId, "newest");
});

test("equal admission sequences fall back to admission time", () => {
  const selected = selectNewestEditableQueuedItem(
    queue(
      item({ id: "later", admissionSeq: 3, admittedAt: 20 }),
      item({ id: "earlier", admissionSeq: 3, admittedAt: 10 }),
    ),
  );
  assert.equal(selected?.queueItemId, "later");
});

test("compact maintenance intents are never editable as user text", () => {
  assert.equal(
    selectNewestEditableQueuedItem(queue(item({ id: "compact", admissionSeq: 9, kind: "compact" }))),
    null,
  );
});

test("reserved items already belong to a dispatch and are skipped", () => {
  assert.equal(
    selectNewestEditableQueuedItem(queue(item({ id: "reserved", admissionSeq: 9, dispatch: "reserved" }))),
    null,
  );
});

test("promoting items are skipped so a start cannot be raced", () => {
  assert.equal(
    selectNewestEditableQueuedItem(queue(item({ id: "promoting", admissionSeq: 9, dispatch: "promoting" }))),
    null,
  );
});

test("an item whose steer is submitting is skipped", () => {
  assert.equal(
    selectNewestEditableQueuedItem(queue(item({ id: "submitting", admissionSeq: 9, steer: "submitting" })))?.queueItemId,
    undefined,
  );
});

test("an item whose steer is already steering is skipped", () => {
  assert.equal(
    selectNewestEditableQueuedItem(queue(item({ id: "steering", admissionSeq: 9, steer: "steering" })))?.queueItemId,
    undefined,
  );
});

test("agent-runtime admissions are not operator messages", () => {
  const selected = selectNewestEditableQueuedItem(
    queue(
      item({
        id: "agent",
        admissionSeq: 9,
        provenance: { sourceCommandId: "cmd-agent", origin: "agent_runtime", source: "background_automation" },
      }),
      item({ id: "human", admissionSeq: 1 }),
    ),
  );
  assert.equal(selected?.queueItemId, "human");
});

test("unknown provenance is not treated as human input", () => {
  assert.equal(
    selectNewestEditableQueuedItem(
      queue(
        item({
          id: "unknown",
          admissionSeq: 9,
          provenance: { sourceCommandId: "cmd-unknown", origin: "unknown", source: "unknown", humanAuthored: false },
        }),
      ),
    ),
    null,
  );
});

test("humanAuthored alone is sufficient", () => {
  const selected = selectNewestEditableQueuedItem(
    queue(
      item({
        id: "human-authored",
        admissionSeq: 2,
        provenance: { sourceCommandId: "cmd-human", humanAuthored: true },
      }),
    ),
  );
  assert.equal(selected?.queueItemId, "human-authored");
});

test("real_user origin alone is sufficient", () => {
  const selected = selectNewestEditableQueuedItem(
    queue(item({ id: "real-user", admissionSeq: 2, provenance: { sourceCommandId: "cmd", origin: "real_user" } })),
  );
  assert.equal(selected?.queueItemId, "real-user");
});

test("operator_ingress source alone is sufficient", () => {
  const selected = selectNewestEditableQueuedItem(
    queue(item({ id: "operator", admissionSeq: 2, provenance: { sourceCommandId: "cmd", source: "operator_ingress" } })),
  );
  assert.equal(selected?.queueItemId, "operator");
});

test("legacy items without provenance remain editable", () => {
  const selected = selectNewestEditableQueuedItem(queue(item({ id: "legacy", admissionSeq: 2, provenance: undefined })));
  assert.equal(selected?.queueItemId, "legacy");
});

test("the item already being moved is excluded", () => {
  const selected = selectNewestEditableQueuedItem(
    queue(item({ id: "in-flight", admissionSeq: 9 }), item({ id: "next", admissionSeq: 4 })),
    "in-flight",
  );
  assert.equal(selected?.queueItemId, "next");
});

test("an empty queue yields no candidate", () => {
  assert.equal(selectNewestEditableQueuedItem(queue()), null);
});

test("a queue with no eligible item yields no candidate", () => {
  assert.equal(
    selectNewestEditableQueuedItem(
      queue(
        item({ id: "reserved", admissionSeq: 8, dispatch: "reserved" }),
        item({ id: "compact", admissionSeq: 9, kind: "compact" }),
      ),
    ),
    null,
  );
});

// --- in-place eligibility (mirrors the Core and CLI gates) -------------------

test("only queued non-compact items are editable in place", () => {
  assert.equal(isQueueItemEditable(item({ id: "queued", admissionSeq: 1 })), true);
  assert.equal(isQueueItemEditable(item({ id: "compact", admissionSeq: 1, kind: "compact" })), false);
  assert.equal(isQueueItemEditable(item({ id: "reserved", admissionSeq: 1, dispatch: "reserved" })), false);
  assert.equal(isQueueItemEditable(item({ id: "promoting", admissionSeq: 1, dispatch: "promoting" })), false);
  assert.equal(isQueueItemEditable(item({ id: "submitting", admissionSeq: 1, steer: "submitting" })), false);
  assert.equal(isQueueItemEditable(item({ id: "steering", admissionSeq: 1, steer: "steering" })), false);
  assert.equal(isQueueItemEditable(null), false);
  assert.equal(isQueueItemEditable(undefined), false);
});

test("the editor targets that exact item, never a neighbour", () => {
  const items = queue(item({ id: "a", admissionSeq: 1 }), item({ id: "b", admissionSeq: 2 })).items;
  assert.equal(resolveEditableQueueItem(items, "b")?.queueItemId, "b");
  assert.equal(resolveEditableQueueItem(items, "missing"), null);
  assert.equal(
    resolveEditableQueueItem(
      queue(item({ id: "a", admissionSeq: 1 }), item({ id: "reserved", admissionSeq: 2, dispatch: "reserved" })).items,
      "reserved",
    ),
    null,
  );
});

test("only an accepted (or duplicate) ACK counts as saved; stale asks for a retry", () => {
  assert.equal(queueEditOutcome({ status: "accepted" }), "saved");
  assert.equal(queueEditOutcome({ status: "duplicate" }), "saved");
  assert.equal(queueEditOutcome({ status: "stale" }), "stale");
  assert.equal(queueEditOutcome({ status: "rejected", reasonCode: "guard.queueItemReserved" }), "refused");
  assert.equal(queueEditOutcome({ status: "noop", reasonCode: "queue.itemMissing" }), "refused");
  assert.equal(queueEditOutcome({ status: "failed", reasonCode: "guard.queueItemNotEditable" }), "refused");
});

test("the save is confirmed by the projection, not by the ACK", () => {
  const items = queue(item({ id: "a", admissionSeq: 1 }), item({ id: "b", admissionSeq: 2 })).items;
  assert.equal(queueEditAppliedInProjection(items, "b", "text-b"), true, "unchanged text is already applied");
  assert.equal(queueEditAppliedInProjection(items, "b", "edited"), false, "ACK alone never confirms");
  const edited = items.map((entry) =>
    entry.queueItemId === "b" ? ({ ...entry, text: "edited" } as EditableQueueItem) : entry,
  );
  assert.equal(queueEditAppliedInProjection(edited, "b", "edited"), true);
  assert.deepEqual(edited.map((entry) => entry.queueItemId), ["a", "b"], "FIFO order is untouched");
  assert.deepEqual(edited[1]?.attachments, items[1]?.attachments, "attachments survive an in-place edit");
  assert.deepEqual(edited[1]?.modelSelection, items[1]?.modelSelection, "model selection survives");
  assert.equal(queueEditAppliedInProjection(edited, "missing", "edited"), false);
});

// --- ArrowUp wiring ---------------------------------------------------------

test("empty-composer ArrowUp consults the queue before prompt history", () => {
  const source = SOURCE("LexicalChatInput.tsx");
  const callback = source.indexOf("direction === \"up\" &&");
  const candidate = source.indexOf("text.length === 0 &&");
  const history = source.indexOf("navigatePromptHistory(entries, currentIndex, direction)");
  assert.ok(callback > 0 && candidate > callback && history > candidate, "queue candidate must run first");
  assert.match(source, /onEmptyArrowUp\?\.\(\)/);
  assert.match(source, /event\.preventDefault\(\);/);
});

test("ArrowUp queue edit stays limited to up, empty, non-browsing, and unmodified keys", () => {
  const source = SOURCE("LexicalChatInput.tsx");
  assert.match(source, /event\.shiftKey \|\|/);
  assert.match(source, /event\.ctrlKey \|\|/);
  assert.match(source, /event\.metaKey \|\|/);
  assert.match(source, /event\.altKey \|\|/);
  assert.match(source, /event\.isComposing/);
  assert.match(source, /currentIndex === null && text\.length > 0/);
  assert.match(source, /currentIndex === null &&\s+text\.length === 0 &&/);
});

test("PromptHistoryPlugin ignores ArrowDown for queue edits and keeps HIGH priority", () => {
  const source = SOURCE("LexicalChatInput.tsx");
  assert.match(source, /KEY_ARROW_UP_COMMAND,[\s\S]*?COMMAND_PRIORITY_HIGH/);
  assert.match(source, /KEY_ARROW_DOWN_COMMAND,[\s\S]*?COMMAND_PRIORITY_HIGH/);
  assert.doesNotMatch(source, /direction === "down" &&[\s\S]{0,120}onEmptyArrowUp/);
});

test("the callback is threaded from LexicalChatInput through ChatPromptEditor", () => {
  const lexical = SOURCE("LexicalChatInput.tsx");
  const editor = SOURCE("prompt-editor/ChatPromptEditor.tsx");
  assert.match(lexical, /onEmptyArrowUp=\{onEmptyArrowUp\}/);
  assert.match(lexical, /onEmptyArrowUp\?: \(\) => boolean;/);
  assert.match(editor, /onEmptyArrowUp=\{onEmptyArrowUp\}/);
  assert.match(editor, /onEmptyArrowUp\?: \(\) => boolean;/);
});

test("ConversationComposer forwards the host callback to the editor", () => {
  const composer = SOURCE("v4/ConversationComposer.tsx");
  assert.match(composer, /onEmptyArrowUp\?: \(\) => boolean;/);
  assert.match(composer, /onEmptyArrowUp=\{onEmptyArrowUp\}/);
});

test("SessionPane ArrowUp opens the same inline editor, still only on an empty composer", () => {
  const pane = SOURCE("v4/SessionPane.tsx");
  assert.match(pane, /const candidate = selectNewestEditableQueuedItem\(current\.queue\);/);
  assert.match(pane, /handleOpenQueueEdit\(candidate\.queueItemId\);/);
  assert.match(pane, /if \(composerDraftStateRef\.current\.hasContent \|\| composerDraftStateRef\.current\.busy\) \{/);
  assert.match(pane, /onEmptyArrowUp=\{handleEmptyComposerArrowUp\}/);
  assert.doesNotMatch(pane, /handleEditQueueItem/);
});

// --- the queue row owns the editor -----------------------------------------

test("the queue row renders an inline textarea prepopulated with that item's text", () => {
  const panel = SOURCE("v4/ConversationQueuePanel.tsx");
  assert.match(panel, /data-testid=\{testId\(TID_V4_QUEUE_ITEM_EDIT_INPUT, item\.queueItemId\)\}/);
  assert.match(panel, /value=\{draft\}/);
  assert.match(panel, /setDraft\(queueDraftBody\)/);
  assert.match(panel, /withZaicodeAutoGoal\(draft, true\)/, "the hidden Auto-Goal suffix is restored on save");
  assert.match(panel, /data-queue-item-editing="true"/);
  assert.match(panel, /TID_V4_QUEUE_ITEM_EDIT_SAVE/);
  assert.match(panel, /TID_V4_QUEUE_ITEM_EDIT_CANCEL/);
});

test("Save edits exactly that item's text and Cancel restores nothing", () => {
  const panel = SOURCE("v4/ConversationQueuePanel.tsx");
  assert.match(panel, /onSaveEdit\(item\.queueItemId, nextText\)/);
  assert.match(panel, /onClick=\{\(\) => onCancelEdit\?\.\(item\.queueItemId\)\}/);
  assert.match(panel, /onSaveEdit=\{onSaveEditItem\}/);
  assert.match(panel, /onCancelEdit=\{onCancelEditItem\}/);
  assert.match(panel, /editing=\{editingQueueItemId === item\.queueItemId\}/);
});

test("SessionPane saves through editQueueItem and retries once on a stale revision", () => {
  const pane = SOURCE("v4/SessionPane.tsx");
  const save = pane.slice(pane.indexOf("const handleSaveQueueEdit"), pane.indexOf("// ArrowUp on an empty composer"));
  assert.match(save, /dispatchCommand\(\s*"editQueueItem",\s*\{ queueItemId, newText \},\s*sessionId,\s*current\.revision,/);
  assert.match(save, /if \(queueEditOutcome\(ack\) === "stale"\) \{/);
  assert.match(save, /sessionId,\s*fresh\.revision,/);
  assert.match(save, /if \(queueEditOutcome\(ack\) !== "saved"\) \{[\s\S]*?reportQueueEditRefusal\(ack\.reasonCode \?\? ack\.status\);[\s\S]*?return;/);
  assert.doesNotMatch(save, /deleteQueueItem/, "editing never deletes the queued message");
  assert.doesNotMatch(save, /persistQueuedComposerRecovery/);
});

test("a refused or unconfirmed edit keeps the draft and the original message", () => {
  const pane = SOURCE("v4/SessionPane.tsx");
  const save = pane.slice(pane.indexOf("const handleSaveQueueEdit"), pane.indexOf("// ArrowUp on an empty composer"));
  assert.match(save, /setPendingQueueEdit\(\{ sessionId, queueItemId, newText \}\);/);
  const refusal = pane.slice(pane.indexOf("const reportQueueEditRefusal"), pane.indexOf("const handleOpenQueueEdit"));
  assert.match(refusal, /chat\.queue\.actionBlocked/);
  assert.match(refusal, /logger\.warn/);
  assert.doesNotMatch(refusal, /setQueueEditTarget\(null\)/, "the editor stays open on a refusal");
});

test("the editor closes only when the projection shows the new text", () => {
  const pane = SOURCE("v4/SessionPane.tsx");
  const effect = pane.slice(
    pane.indexOf("// 保存完成的判据是权威投影"),
    pane.indexOf("// Host 收下了但投影一直没变"),
  );
  assert.match(effect, /queueEditAppliedInProjection\(/);
  assert.match(effect, /setPendingQueueEdit\(null\);/);
  assert.match(effect, /setQueueEditTarget\(\(target\) =>/);
  const timeout = pane.slice(
    pane.indexOf("// Host 收下了但投影一直没变"),
    pane.indexOf("// 切会话时丢弃未完成的编辑目标"),
  );
  assert.match(timeout, /proto\.projectionNotUpdated/);
  assert.match(timeout, /QUEUE_EDIT_VERIFY_TIMEOUT_MS/);
});

test("the composer is not disabled and not rewritten by a queue edit", () => {
  const pane = SOURCE("v4/SessionPane.tsx");
  assert.doesNotMatch(pane, /queueEditActiveForCurrentComposer/);
  assert.doesNotMatch(pane, /composerRestoreRequest/);
  assert.doesNotMatch(pane, /queuedComposerRecovery/);
  const disabled = pane.slice(pane.indexOf("      disabled={"), pane.indexOf("      workspacePath={"));
  assert.doesNotMatch(disabled, /queueEdit/);
  const composer = SOURCE("v4/ConversationComposer.tsx");
  assert.doesNotMatch(composer, /ComposerRestoreRequest/);
});

test("the core refuses in place once the item is reserved for a dispatch", () => {
  const core = readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "apps",
      "zcode-cli",
      "packages",
      "core",
      "src",
      "runtime",
      "methods",
      "steering.ts",
    ),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const start = core.indexOf("editPendingInputById(");
  const body = core.slice(start, core.indexOf("const activeTurn = this.activeTurn", start));
  assert.match(body, /if \(this\.pendingInputReservations\.has\(options\.pendingInputId\)\) return false;/);
});

test("the CLI handler reports a missed or reserved item instead of success", () => {
  const handler = readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "apps",
      "zcode-cli",
      "packages",
      "bootstrap",
      "src",
      "zcode-protocol-v4",
      "commands",
      "handlers",
      "queue.ts",
    ),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const body = handler.slice(handler.indexOf("async function editQueueItem("));
  assert.match(body, /if \(queueItem === null\) \{[\s\S]*?V4CommandNoopError\("queue\.itemMissing"\)/);
  assert.match(body, /if \(queueItem\.dispatch\.state !== "queued"\) \{[\s\S]*?V4QueueItemEditReservedError/);
  assert.match(handler, /class V4QueueItemEditReservedError[\s\S]*?reasonCode = "guard\.queueItemReserved"/);
  assert.match(body, /if \(!edited\) \{[\s\S]*?V4QueueItemNotEditableError/);
});
