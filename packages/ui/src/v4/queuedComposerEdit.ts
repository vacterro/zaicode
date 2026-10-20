import type { QueueState } from "@zcode/shared/zcode-protocol-v4";

export type EditableQueueItem = QueueState["items"][number];

/**
 * Arrow Up in an empty composer edits the newest eligible queued user input.
 * Submission chronology is `order.admissionSeq`, never the editable queue position.
 */
export function selectNewestEditableQueuedItem(
  queue: QueueState,
  excludedQueueItemId?: string | null,
): EditableQueueItem | null {
  let newest: EditableQueueItem | null = null;
  for (const item of queue.items) {
    if (item.kind === "compact") continue;
    // reserved/promoting already belong to a dispatch; editing them would race it.
    if (item.dispatch.state !== "queued") continue;
    if (excludedQueueItemId && item.queueItemId === excludedQueueItemId) continue;
    if (item.steer.state === "submitting" || item.steer.state === "steering") continue;
    if (!isOperatorSubmitted(item)) continue;
    if (
      newest === null ||
      item.order.admissionSeq > newest.order.admissionSeq ||
      (item.order.admissionSeq === newest.order.admissionSeq &&
        item.admittedAt > newest.admittedAt)
    ) {
      newest = item;
    }
  }
  return newest;
}

function isOperatorSubmitted(item: EditableQueueItem): boolean {
  const provenance = item.provenance;
  // Legacy snapshots predate provenance; their queue admitted operator input.
  if (!provenance) return true;
  if (provenance.humanAuthored === true) return true;
  if (provenance.origin === "real_user") return true;
  if (provenance.source === "operator_ingress") return true;
  return false;
}
