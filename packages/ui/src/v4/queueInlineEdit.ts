import type { QueueState } from "@zcode/shared/zcode-protocol-v4";

/**
 * T-394: editing a queued message in place.
 *
 * The queue row owns a small editor. The main composer is never touched by it:
 * the operator's own draft (text, attachments, caret, model, effort) belongs to
 * the operator, and editing a queued message must not cost them that draft.
 *
 * These helpers carry the rules both the renderer and the tests need: who may be
 * edited, what an authoritative acknowledgement means, and when the queue
 * projection proves the new text actually landed.
 */

export type QueueEditItem = QueueState["items"][number];

export type QueueEditAckStatus =
  | "accepted"
  | "rejected"
  | "stale"
  | "duplicate"
  | "noop"
  | "failed";

export interface QueueEditAckLike {
  status: QueueEditAckStatus;
  reasonCode?: string | null;
}

/**
 * `saved` — the Host took the edit and the queue changed.
 * `stale` — the base revision was behind; the caller may reconcile and retry.
 * `refused` — the queue kept its old text; nothing may claim success.
 */
export type QueueEditOutcome = "saved" | "stale" | "refused";

/**
 * A queued message is editable while no dispatch owns it. A reserved or
 * promoting item is already being sent, and a steering item is already
 * submitted: both would race the edit.
 */
export function isQueueItemEditable(item: QueueEditItem | null | undefined): boolean {
  if (!item) return false;
  // compact is a typed maintenance intent, not operator text.
  if (item.kind === "compact") return false;
  if (item.dispatch.state !== "queued") return false;
  if (item.steer.state === "submitting" || item.steer.state === "steering") return false;
  return true;
}

/** The item the editor may open, or null when it may not be edited (anymore). */
export function resolveEditableQueueItem(
  items: readonly QueueEditItem[],
  queueItemId: string,
): QueueEditItem | null {
  const item = items.find((candidate) => candidate.queueItemId === queueItemId);
  if (!item) return null;
  return isQueueItemEditable(item) ? item : null;
}

/**
 * What the authoritative acknowledgement means for the queue.
 *
 * `accepted` and `duplicate` mean the edit landed (a duplicate is the same
 * command already applied, so the projection already carries the new text).
 * `stale` means the command was refused because the base revision was behind:
 * the caller may re-read the snapshot and retry without losing the draft.
 * Everything else — rejected, failed, and noop such as a missing queue item —
 * left the queue exactly as it was.
 */
export function queueEditOutcome(ack: QueueEditAckLike): QueueEditOutcome {
  if (ack.status === "accepted" || ack.status === "duplicate") return "saved";
  if (ack.status === "stale") return "stale";
  return "refused";
}

/**
 * The edit is real only once the queue projection carries the new text on that
 * very item. The acknowledgement alone is admission, not execution.
 */
export function queueEditAppliedInProjection(
  items: readonly QueueEditItem[],
  queueItemId: string,
  newText: string,
): boolean {
  const item = items.find((candidate) => candidate.queueItemId === queueItemId);
  return item !== undefined && item.text === newText;
}
