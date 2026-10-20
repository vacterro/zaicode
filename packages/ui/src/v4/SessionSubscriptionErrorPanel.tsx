import { useCallback } from "react";
import { TID_V4_RETRY_SUBSCRIBE } from "@zcode/shared";
import type { FeedbackTicketSeverity } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { buildErrorFeedbackDescription } from "@/lib/errorFeedbackDraft.js";
import type { ConversationStoreStatus } from "@/v4/conversationProjectionStore.js";
import type {
  SubscriptionDiagnosticsSnapshot,
  SubscriptionFaultCategory,
} from "@/v4/subscriptionDiagnostics.js";

/**
 * 可复制的诊断文本：只有标识、类别、首个底层原因与计数，没有载荷内容。
 * 面板与剪贴板共用同一份，保证用户看到的就是上报的。
 */
export function diagnosticSummaryText(diagnostics: SubscriptionDiagnosticsSnapshot): string {
  const lines = [
    `diagnosticId: ${diagnostics.diagnosticId}`,
    `topic: ${diagnostics.topic}`,
    `faultCategory: ${diagnostics.faultCategory ?? "unknown"}`,
    `firstCause: ${diagnostics.firstCause ?? "unknown"}`,
  ];
  const first = diagnostics.firstFailure;
  if (first) {
    lines.push(
      `firstFault: ${first.reasonCode}`,
      `firstFault.deliveryKind: ${first.deliveryKind ?? "unknown"}`,
      `firstFault.logicalFrameOrdinal: ${first.logicalFrameOrdinal ?? "unknown"}`,
      `firstFault.at: ${first.at}`,
    );
    if (first.schemaIssue) lines.push(`firstFault.schemaIssue: ${first.schemaIssue}`);
  }
  lines.push(
    `framesSeen: ${diagnostics.framesSeen}`,
    `initialFrameSeen: ${diagnostics.initialFrameSeen}`,
    `recoveryAttempts: ${diagnostics.recoveryAttempts}`,
    `terminal: ${diagnostics.terminal}`,
  );
  return lines.join("\n");
}

/**
 * 权威投影是否仍然可用作「历史」展示。
 *
 * 判据是「曾经落地过一份权威投影」——store 的 projectionVerified 事实，
 * 不是 rows 非空。按行数判断同时错两边：真实空会话的合法空投影被当作不可信，
 * 未经水位验证的非空投影被当作可信。
 *
 * 兼容旧调用方：未提供 projectionVerified 时才退回行数启发式。
 */
export function hasTrustworthyConversationProjection(
  snapshot: { rows: { window: readonly unknown[] } } | null,
  projectionVerified?: boolean,
): boolean {
  if (projectionVerified !== undefined) return projectionVerified;
  return snapshot !== null && snapshot.rows.window.length > 0;
}

/**
 * 会话正文区该画什么。
 *
 * - "live"：正常时间线。
 * - "fault-banner"：订阅失效但有可信的 last-good 投影——保留历史正文，只加断开横幅。
 * - "fault-panel"：订阅失效且从未落地过权威投影——保留原来的整屏错误态。
 *
 * 旧实现在 status === "error" 时整块换成错误面板，于是一次订阅故障会把用户已经看到的
 * 全部对话历史藏起来，只留一个空屏幕和一行错误码。
 */
export type ConversationSubscriptionSurface = "live" | "fault-banner" | "fault-panel";

export function resolveConversationSubscriptionSurface(input: {
  status: ConversationStoreStatus;
  snapshot: { rows: { window: readonly unknown[] } } | null;
  projectionVerified?: boolean;
}): ConversationSubscriptionSurface {
  if (input.status !== "error") return "live";
  return hasTrustworthyConversationProjection(input.snapshot, input.projectionVerified)
    ? "fault-banner"
    : "fault-panel";
}

interface SessionSubscriptionErrorPanelProps {
  error: string;
  sessionId: string;
  workspacePath: string;
  onReconnect: () => void;
  /**
   * "banner"：last-good 历史仍在屏幕上，只在其上方压一条断开提示，不再占据正文区。
   */
  variant?: "panel" | "banner";
  /**
   * 订阅诊断（类别、首个底层原因、可复制诊断 id）。缺失时面板退回只显示错误码，
   * 绝不假装知道原因。
   */
  diagnostics?: SubscriptionDiagnosticsSnapshot | null;
}

/**
 * 反馈严重度按故障类别给出，而不是写死的 P2：physical 解码/schema 失败与传输
 * 批次残缺是确定性缺陷，按 P1 上报；恢复类失败依赖上游，先按 P2。
 */
export function severityForFaultCategory(
  category: SubscriptionFaultCategory | null | undefined,
): FeedbackTicketSeverity {
  switch (category) {
    case "transport":
    case "decoder":
    case "schema":
      return "P1-高";
    default:
      return "P2-中";
  }
}

export function SessionSubscriptionErrorPanel({
  error,
  sessionId,
  workspacePath,
  onReconnect,
  variant = "panel",
  diagnostics = null,
}: SessionSubscriptionErrorPanelProps) {
  const { intl } = useZCodeIntl();
  const openFeedbackSubmit = useFeedbackStore((state) => state.openSubmit);
  const openFeedback = useCallback(
    (includeLogs: boolean) => {
      openFeedbackSubmit({
        title: error.slice(0, 80),
        type: "bug",
        module: "Agent任务执行失败",
        severity: severityForFaultCategory(diagnostics?.faultCategory),
        // 日志附件必须由用户显式点「含日志」开启：诊断事实默认只有白名单字段（无提示词、
        // 无工具输出、无凭据），但本地日志里可能含用户的私有内容，不经选择不上传。
        includeLogs,
        description: buildErrorFeedbackDescription({
          message: error,
          contextLines: [
            intl.formatMessage({ id: "feedback.submit.template.section.taskInfo" }),
            intl.formatMessage({ id: "feedback.submit.template.section.taskId" }, { id: sessionId }),
            intl.formatMessage(
              { id: "feedback.submit.template.section.taskWorkspace" },
              { path: workspacePath },
            ),
            ...(diagnostics ? [diagnosticSummaryText(diagnostics)] : []),
          ],
          formatMessage: (id: string, values?: Record<string, string>) =>
            intl.formatMessage({ id }, values),
        }),
        screenshots: [],
      });
      toast(intl.formatMessage({ id: "chat.error.feedbackOpened" }));
    },
    [diagnostics, error, intl, openFeedbackSubmit, sessionId, workspacePath],
  );
  const handleOpenFeedback = useCallback(() => openFeedback(false), [openFeedback]);
  const handleOpenFeedbackWithLogs = useCallback(() => openFeedback(true), [openFeedback]);
  const handleCopyDiagnostics = useCallback(() => {
    if (!diagnostics || typeof navigator === "undefined" || !navigator.clipboard) return;
    void navigator.clipboard.writeText(diagnosticSummaryText(diagnostics)).then(() => {
      toast(intl.formatMessage({ id: "chat.error.feedbackOpened" }));
    });
  }, [diagnostics, intl]);

  if (variant === "banner") {
    // 措辞只讲订阅状态，绝不把这批行说成「当前正在执行」的真相。
    return (
      <div
        role="alert"
        data-testid="v4-subscription-fault-banner"
        className="mx-4 mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-hover)] px-3 py-2 text-ui-base"
      >
        <span className="text-[var(--color-danger)]">
          {intl.formatMessage({ id: "chat.error.connectionLost" })}
        </span>
        <span className="break-all font-mono text-[var(--color-danger)]">{error}</span>
        {diagnostics ? (
          <span
            data-testid="v4-subscription-diagnostic-reference"
            className="break-all font-mono text-[var(--color-foreground-subtle)]"
          >
            {diagnostics.diagnosticId}
            {diagnostics.firstCause ? ` · ${diagnostics.firstCause}` : ""}
          </span>
        ) : null}
        <span className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[var(--color-foreground-subtle)]">
          {intl.formatMessage({ id: "git.readonly" })}
        </span>
        <span className="flex-1" />
        {diagnostics ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="v4-subscription-copy-diagnostics"
            onClick={handleCopyDiagnostics}
          >
            {intl.formatMessage({ id: "chat.error.feedback" })}
          </Button>
        ) : null}
        <Button type="button" variant="outline" size="sm" onClick={handleOpenFeedback}>
          {intl.formatMessage({ id: "chat.error.feedback" })}
        </Button>
        <Button
          type="button"
          size="sm"
          data-testid={TID_V4_RETRY_SUBSCRIBE}
          onClick={onReconnect}
        >
          {intl.formatMessage({ id: "workspaceSidebar.reconnect" })}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-ui-base">
      <p className="max-w-full break-words text-center font-mono text-destructive">{error}</p>
      {diagnostics ? (
        <div
          data-testid="v4-subscription-diagnostic-reference"
          className="max-w-full space-y-0.5 text-center font-mono text-[var(--color-foreground-subtle)]"
        >
          <p>{diagnostics.diagnosticId}</p>
          {diagnostics.firstCause ? <p>{diagnostics.firstCause}</p> : null}
          {diagnostics.firstFailure ? (
            <p>
              {diagnostics.firstFailure.reasonCode} · {diagnostics.firstFailure.deliveryKind ?? "unknown"}
              {diagnostics.firstFailure.logicalFrameOrdinal === null
                ? ""
                : ` · ordinal ${diagnostics.firstFailure.logicalFrameOrdinal}`}
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-center gap-2">
        {diagnostics ? (
          <Button
            type="button"
            variant="outline"
            data-testid="v4-subscription-copy-diagnostics"
            onClick={handleCopyDiagnostics}
          >
            {intl.formatMessage({ id: "chat.error.feedback" })}
          </Button>
        ) : null}
        <Button type="button" variant="outline" onClick={handleOpenFeedback}>
          {intl.formatMessage({ id: "chat.error.feedback" })}
        </Button>
        {diagnostics ? (
          <Button
            type="button"
            variant="outline"
            data-testid="v4-subscription-feedback-with-logs"
            onClick={handleOpenFeedbackWithLogs}
          >
            {intl.formatMessage({ id: "chat.error.feedback" })}
          </Button>
        ) : null}
        <Button type="button" data-testid={TID_V4_RETRY_SUBSCRIBE} onClick={onReconnect}>
          {intl.formatMessage({ id: "workspaceSidebar.reconnect" })}
        </Button>
      </div>
    </div>
  );
}
