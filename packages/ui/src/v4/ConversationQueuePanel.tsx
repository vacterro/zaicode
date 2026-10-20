/* oxlint-disable eslint(max-lines) -- queue 面板同时持有行内编辑草稿、拖拽排序和提升按钮的准入状态，拆分会把同一条队列行的状态机拆到两个文件。 */
import { closestCenter, DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  TID_V4_QUEUE,
  TID_V4_QUEUE_ITEM,
  TID_V4_QUEUE_ITEM_DELETE,
  TID_V4_QUEUE_ITEM_EDIT,
  TID_V4_QUEUE_ITEM_EDIT_CANCEL,
  TID_V4_QUEUE_ITEM_EDIT_INPUT,
  TID_V4_QUEUE_ITEM_EDIT_SAVE,
  TID_V4_QUEUE_ITEM_SEND_NOW,
  TID_V4_QUEUE_PAUSED_BANNER,
  TID_V4_QUEUE_RESUME,
  TID_V4_SESSION_PAUSED_NOTE,
  testId,
} from "@zcode/shared";
import type { AttachmentRef, QueueState } from "@zcode/shared/zcode-protocol-v4";
import { isZaicodeProductMode } from "@zcode/shared";
import { ArrowUpFromLine, GripVertical, PaperclipIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { splitZaicodeAutoGoal, withZaicodeAutoGoal } from "@/zaicode/zaicodeAutoGoal.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { runUserAction, runUserActionAsync } from "@/lib/userActionTelemetry.js";
import { resolveV4QueueReorderAnchor, restrictQueueDragToPanel } from "./queueDragOrder.js";

interface ConversationQueuePanelProps {
  queue: QueueState;
  /** 删除队列项（deleteQueueItem command）。 */
  onDeleteItem?: (queueItemId: string) => void;
  /** 打开该排队项的行内编辑器（就地改文本；composer 不动）。 */
  onEditItem?: (queueItemId: string) => void;
  /** 保存行内编辑（editQueueItem command）。 */
  onSaveEditItem?: (queueItemId: string, newText: string) => Promise<void> | void;
  /** 放弃行内编辑（排队内容原样保留）。 */
  onCancelEditItem?: (queueItemId: string) => void;
  /** 当前打开行内编辑器的项；null = 没有打开的编辑器。 */
  editingQueueItemId?: string | null;
  /** 正在等待 edit ACK / 投影核对的目标项；仅锁该 row。 */
  pendingEditQueueItemId?: string | null;
  /** 立即发送队列项（sendQueuedNow command，stop 当前 + 消费该项）。 */
  onSendNow?: (queueItemId: string) => void;
  /** 拖拽排序项（reorderQueueItem，移动到锚点前；null=队尾）。 */
  onMoveItem?: (queueItemId: string, beforeQueueItemId: string | null) => void;
  /** 暂停队列恢复：CLI setAutoDrain(true)，idle 立即消费、busy 仅武装。 */
  onResume?: () => Promise<void> | void;
  /**
   * sendQueuedNow 的 availability（snapshot.availability.sendQueuedNow）。会话未运行时
   * CLI promotion 只能拒绝；带上 reasonCode 让按钮显式解释为什么不能点，而不是点了
   * 无声无息（T-301）。
   */
  sendNowBlockedReason?: string | null;
  /** 会话自身被暂停（goalStatus=paused）：继续队列调度不等于恢复会话授权。 */
  sessionPaused?: boolean;
  /** 正在等待 sendQueuedNow ACK 的项；ACK 未回时不可重复派发。 */
  sendNowPendingQueueItemId?: string | null;
}

type QueueItem = QueueState["items"][number];



interface QueueRowProps {
  item: QueueItem;
  index: number;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  sortable: boolean;
  onDeleteItem?: (queueItemId: string) => void;
  onEditItem?: (queueItemId: string) => void;
  onSaveEdit?: (queueItemId: string, newText: string) => Promise<void> | void;
  onCancelEdit?: (queueItemId: string) => void;
  /** 该行正在显示行内编辑器。 */
  editing: boolean;
  editPending: boolean;
  onSendNow?: (queueItemId: string) => void;
  /** 非空 = availability 拒绝，直接发送此刻只会被 CLI 拒绝。 */
  sendNowBlockedReason?: string | null;
  /** 该项的 sendQueuedNow ACK 还在途中，重复点击只会撞 CLI reservation。 */
  sendNowPending?: boolean;
}

/**
 * SRC-151:R006: the queued row printed only `item.text`, so a send that carried a file
 * read exactly like one that did not -- "goal cc all" with a screenshot glued to it, and
 * nothing on the row to say so. The refs were never lost: the intent carries them
 * (queueItemSchema extends conversationInputIntentSchema), the projection keeps them, and
 * edit-restore already hands them back to the composer. Only this row dropped them.
 *
 * A count plus the file names in the title, not one chip per file: the row is a single
 * truncating line between a drag handle and three buttons, so inline names would fight the
 * text for the same pixels. "Attachments" is an existing message in all 32 locales, so this
 * adds no new copy to translate.
 */
export function QueueAttachmentBadge({
  attachments,
  label,
}: {
  attachments: readonly AttachmentRef[];
  label: string;
}) {
  if (attachments.length === 0) return null;
  return (
    <span
      data-v4-queue-item-attachments="true"
      data-attachment-count={attachments.length}
      title={attachments.map((attachment) => attachment.fileName).join(", ")}
      aria-label={label}
      className="flex shrink-0 items-center gap-1 text-ui-sm text-foreground-subtlest"
    >
      <PaperclipIcon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="tabular-nums">{attachments.length}</span>
    </span>
  );
}

const QueueRow = memo(function QueueRow({
  item,
  index,
  intl,
  sortable,
  onDeleteItem,
  onEditItem,
  onSendNow,
  onSaveEdit,
  onCancelEdit,
  editing,
  editPending,
  sendNowBlockedReason,
  sendNowPending = false,
}: QueueRowProps) {
  const dispatchLocked = item.dispatch.state !== "queued";
  const rowLocked = dispatchLocked || editPending || sendNowPending;
  const isCompact = item.kind === "compact";
  const sendNowLabel = intl.formatMessage({ id: isCompact ? "chat.queue.runNow" : "chat.queue.sendNow" });
  // SRC-163 (SRC-151:R006): the Auto-Goal suffix is not the queued prompt; show it as a mark.
  const queueGoal = splitZaicodeAutoGoal(item.text);
  // T-394: the inline editor keeps its own draft. The draft is seeded once per
  // editing session and survives a refused save, so the operator never loses
  // what they typed because the Host declined the mutation. The invisible
  // Auto-Goal suffix stays out of the editor and rides along again on save.
  const queueDraftBody = isZaicodeProductMode() ? queueGoal.body : item.text;
  const [draft, setDraft] = useState(queueDraftBody);
  const [saving, setSaving] = useState(false);
  const editingStartedRef = useRef(false);
  useEffect(() => {
    if (editing && !editingStartedRef.current) {
      editingStartedRef.current = true;
      setDraft(queueDraftBody);
    }
    if (!editing) editingStartedRef.current = false;
  }, [editing, queueDraftBody]);
  const handleSaveEdit = useCallback(() => {
    if (saving || !onSaveEdit) return;
    const nextText =
      isZaicodeProductMode() && queueGoal.goal ? withZaicodeAutoGoal(draft, true) : draft;
    if (nextText === item.text) {
      // Nothing changed: closing the editor is not a mutation.
      onCancelEdit?.(item.queueItemId);
      return;
    }
    setSaving(true);
    void Promise.resolve(onSaveEdit(item.queueItemId, nextText)).finally(() => {
      setSaving(false);
    });
  }, [draft, item.queueItemId, item.text, onCancelEdit, onSaveEdit, queueGoal.goal, saving]);
  const {
    attributes,
    isDragging,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
  } = useSortable({
    disabled: !sortable || rowLocked,
    id: item.queueItemId,
  });

  const style = useMemo<CSSProperties>(
    () => ({
      transform: CSS.Transform.toString(
        transform
          ? {
              ...transform,
              // dnd-kit 排序时会按 over 节点尺寸附带 scale；
              // 队列行是固定触控目标，缩放会让拖拽中的按钮和文本短暂变形。
              scaleX: 1,
              scaleY: 1,
            }
          : null,
      ),
      transition,
      zIndex: isDragging ? 10 : undefined,
    }),
    [isDragging, transition, transform],
  );
  // T-394: the editing row replaces its text with the editor. The composer is
  // a different surface entirely and is never touched by this flow.
  if (editing) {
    return (
      <li
        ref={setNodeRef}
        data-testid={testId(TID_V4_QUEUE_ITEM, item.queueItemId)}
        data-queue-item-id={item.queueItemId}
        data-index={index}
        data-kind={item.kind}
        data-dispatch-state={item.dispatch.state}
        data-edit-pending={editPending ? "true" : "false"}
        data-queue-item-editing="true"
        className={cn(
          "relative flex items-start gap-2 rounded-xl px-1.5 py-1 pr-1",
          editPending ? "opacity-60" : null,
        )}
        style={style}
      >
        <textarea
          data-testid={testId(TID_V4_QUEUE_ITEM_EDIT_INPUT, item.queueItemId)}
          data-queue-item-id={item.queueItemId}
          value={draft}
          rows={2}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          className="min-h-10 min-w-0 flex-1 resize-y rounded-lg border border-border bg-surface-raised px-2 py-1 text-ui-base text-foreground outline-none"
        />
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            size="sm"
            data-testid={testId(TID_V4_QUEUE_ITEM_EDIT_SAVE, item.queueItemId)}
            data-queue-item-id={item.queueItemId}
            disabled={saving || editPending || dispatchLocked}
            onClick={handleSaveEdit}
          >
            {intl.formatMessage({ id: "common.save" })}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid={testId(TID_V4_QUEUE_ITEM_EDIT_CANCEL, item.queueItemId)}
            data-queue-item-id={item.queueItemId}
            disabled={saving}
            onClick={() => onCancelEdit?.(item.queueItemId)}
          >
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
        </div>
      </li>
    );
  }
  return (
    <li
      ref={setNodeRef}
      data-testid={testId(TID_V4_QUEUE_ITEM, item.queueItemId)}
      data-queue-item-id={item.queueItemId}
      data-index={index}
      data-kind={item.kind}
      data-dispatch-state={item.dispatch.state}
      data-edit-pending={editPending ? "true" : "false"}
      className={cn(
        "relative flex items-center gap-2 rounded-xl px-1.5 py-1 pr-1 transition-colors hover:bg-hover/30",
        isDragging ? "bg-hover/40 shadow-sm" : null,
        editPending ? "opacity-60" : null,
      )}
      style={style}
    >
      <ControlHintTooltip title={intl.formatMessage({ id: "chat.queue.drag" })}>
        <Button
          ref={setActivatorNodeRef}
          type="button"
          variant="ghost"
          size="icon-md"
          data-v4-queue-drag-handle="true"
          data-queue-item-id={item.queueItemId}
          aria-label={intl.formatMessage({ id: "chat.queue.drag" })}
          className="shrink-0 cursor-grab touch-none text-foreground-subtlest active:cursor-grabbing"
          disabled={rowLocked}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-4" />
        </Button>
      </ControlHintTooltip>
      <QueueAttachmentBadge
        attachments={item.attachments}
        label={intl.formatMessage({ id: "chat.composer.attachment" })}
      />
      <span
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 truncate text-ui-base text-foreground",
          isCompact ? "font-mono" : null,
        )}
        title={item.text}
      >
        <span className="truncate">{isCompact ? "/compact" : queueGoal.body || (queueGoal.goal ? "" : item.text)}</span>
        {queueGoal.goal ? (
          <span data-zaicode-auto-goal-chip="true" className="shrink-0 text-ui-xs text-foreground-subtlest">
            goal cc all
          </span>
        ) : null}
      </span>
      {onSendNow ? (
        <ControlHintTooltip
          title={sendNowBlockedReason
            ? intl.formatMessage({ id: "chat.queue.actionBlocked" }, { action: sendNowLabel, reason: sendNowBlockedReason })
            : sendNowLabel}
        >
          <Button
            type="button"
            variant="secondary"
            size="default"
            data-icon="inline-start"
            data-testid={testId(TID_V4_QUEUE_ITEM_SEND_NOW, item.queueItemId)}
            data-queue-item-id={item.queueItemId}
            disabled={rowLocked || Boolean(sendNowBlockedReason)}
            onClick={() =>
              runUserAction({
                input: {
                  featureId: "conversation.queue.item",
                  action: "send_now",
                  trigger: "button",
                },
                operation: () => onSendNow(item.queueItemId),
                completed: { resultSource: "optimistic_projection" },
                failureStage: "queue_send_now",
              })
            }
          >
            <ArrowUpFromLine className="size-3.5" />
            {sendNowLabel}
          </Button>
        </ControlHintTooltip>
      ) : null}
      {onEditItem && !isCompact ? (
        <ControlHintTooltip title={intl.formatMessage({ id: "chat.queue.edit" })}>
          <Button
            type="button"
            variant="ghost"
            size="icon-md"
            data-testid={testId(TID_V4_QUEUE_ITEM_EDIT, item.queueItemId)}
            data-queue-item-id={item.queueItemId}
            aria-label={intl.formatMessage({ id: "chat.queue.edit" })}
            disabled={rowLocked}
            onClick={() => void onEditItem(item.queueItemId)}
          >
            <PencilIcon className="size-4" />
          </Button>
        </ControlHintTooltip>
      ) : null}
      {onDeleteItem ? (
        <ControlHintTooltip title={intl.formatMessage({ id: "chat.queue.remove" })}>
          <Button
            type="button"
            variant="ghost"
            size="icon-md"
            data-testid={testId(TID_V4_QUEUE_ITEM_DELETE, item.queueItemId)}
            data-queue-item-id={item.queueItemId}
            aria-label={intl.formatMessage({ id: "chat.queue.remove" })}
            disabled={rowLocked}
            onClick={() => onDeleteItem(item.queueItemId)}
          >
            <Trash2Icon className="size-4" />
          </Button>
        </ControlHintTooltip>
      ) : null}
    </li>
  );
});

/**
 * 竖切 queue 面板：渲染 projection.queue.items + 单项删除入口。
 * queue 在运行中的 turn 期间存在（sendText 排队），是 CLI 投影权威态（非 renderer-local）。
 */
function ConversationQueuePanelImpl({
  queue,
  onDeleteItem,
  onEditItem,
  onSaveEditItem,
  onCancelEditItem,
  editingQueueItemId = null,
  pendingEditQueueItemId = null,
  onSendNow,
  onMoveItem,
  onResume,
  sendNowBlockedReason = null,
  sessionPaused = false,
  sendNowPendingQueueItemId = null,
}: ConversationQueuePanelProps) {
  const { intl } = useZCodeIntl();
  const [resumePending, setResumePending] = useState(false);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );
  const itemIds = useMemo(() => queue.items.map((item) => item.queueItemId), [queue.items]);
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const overId = event.over?.id;
      if (!overId) return;
      const anchor = resolveV4QueueReorderAnchor(
        queue.items,
        String(event.active.id),
        String(overId),
      );
      if (!anchor) return;
      onMoveItem?.(anchor.queueItemId, anchor.beforeQueueItemId);
    },
    [onMoveItem, queue.items],
  );
  const handleResume = useCallback(async () => {
    if (!onResume || resumePending) return;
    setResumePending(true);
    try {
      await runUserActionAsync({
        input: { featureId: "conversation.queue.policy", action: "resume", trigger: "button" },
        operation: () => Promise.resolve(onResume()),
        completed: { resultSource: "authority_ack" },
        failureStage: "queue_resume",
      });
    } finally {
      setResumePending(false);
    }
  }, [onResume, resumePending]);

  if (queue.items.length === 0) return null;
  // 补回 v4 视觉迁移时漏掉的旧队列面板 blur 层，让列表保持贴合 composer 的磨砂背景。
  return (
    <div
      data-testid={TID_V4_QUEUE}
      data-queue-count={queue.items.length}
      data-queue-auto-drain={queue.autoDrain ? "true" : "false"}
      data-queue-session-paused={sessionPaused ? "true" : "false"}
      className={cn(
        "relative z-0 w-full border border-border bg-surface p-1",
        isZaicodeProductMode()
          ? "mb-1 max-h-[min(30vh,12rem)] overflow-y-auto"
          : "-mb-7 overflow-hidden rounded-t-2xl pb-7 backdrop-blur-md",
      )}
    >
      {!queue.autoDrain ? (
        <div
          data-testid={TID_V4_QUEUE_PAUSED_BANNER}
          data-pause-reason={queue.pauseReason}
          data-pause-origin={queue.pauseOrigin}
          data-pause-reason-code={queue.pauseReasonCode}
          className="mb-1 flex min-h-10 items-center gap-3 rounded-xl border border-border/70 bg-surface-raised px-3 py-2 text-ui-base text-foreground"
        >
          <span className="min-w-0 flex-1">
            {intl.formatMessage({
              id:
                queue.pauseReason === "stopped"
                  ? "chat.queue.paused.stopped"
                  : queue.pauseReason === "error" || queue.pauseReason === "system_error"
                    ? "chat.queue.paused.error"
                    : "chat.queue.paused.generic",
            })}
            {queue.pauseReasonCode ? ` (${queue.pauseReasonCode})` : ""}
          </span>
          {onResume ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid={TID_V4_QUEUE_RESUME}
              aria-label={intl.formatMessage({ id: "chat.queue.resume.description" })}
              disabled={resumePending}
              className="shrink-0 text-foreground-subtle hover:text-foreground"
              onClick={() => void handleResume()}
            >
              {intl.formatMessage({ id: "chat.queue.resume" })}
            </Button>
          ) : null}
        </div>
      ) : null}
      {sessionPaused ? (
        <div data-testid={TID_V4_SESSION_PAUSED_NOTE} className="mb-1 rounded-xl border border-border/70 bg-surface-raised px-3 py-2 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "chat.queue.sessionPausedNote" })}
        </div>
      ) : null}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictQueueDragToPanel]}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
          <ul className="space-y-0.5">
            {queue.items.map((item, index) => (
              <QueueRow
                key={item.queueItemId}
                item={item}
                index={index}
                intl={intl}
                sortable={Boolean(onMoveItem)}
                onDeleteItem={onDeleteItem}
                onEditItem={onEditItem}
                onSaveEdit={onSaveEditItem}
                onCancelEdit={onCancelEditItem}
                editing={editingQueueItemId === item.queueItemId}
                onSendNow={onSendNow}
                sendNowBlockedReason={sendNowBlockedReason}
                sendNowPending={sendNowPendingQueueItemId === item.queueItemId}
                editPending={pendingEditQueueItemId === item.queueItemId}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
    </div>
  );
}

export const ConversationQueuePanel = memo(ConversationQueuePanelImpl);
