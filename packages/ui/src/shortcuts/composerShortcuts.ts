/**
 * composer 作用域快捷键解析——独立模块，唯一消费方是
 * LexicalChatInput 的键盘行为插件；useAppKeyboard / 菜单 / Web 回退监听对
 * composer 命令零感知。只依赖内核匹配器，不依赖 DOM / React，可独立单测。
 */
import type { ShortcutBindingEvent } from "./bindings.js";
import { matchesShortcutBinding } from "./bindings.js";

/** composer 作用域命令在生效表中的切片（只关心这两条，避免拉全量表的类型依赖）。 */
interface ComposerEffectiveBindings {
  readonly composerSend: readonly string[];
  readonly composerInsertNewline: readonly string[];
}

/** Enter 族事件在 composer 内的最终动作。 */
type ComposerKeyAction = "send" | "newline";

/**
 * 按生效表解析 composer 动作（改绑层，统一开放策略）。
 *
 * 对 `composerInsertNewline` / `composerSend` 的全部生效绑定做匹配（newline 先判：
 * 编辑操作误发送代价更高）——**不限定 Enter 族**：用户可把发送绑成 F9 等任意键，
 * 与其他命令的开放策略一致；命中返回动作，全部未命中返回 null（调用方走既有主链）。
 *
 * 发送动作的运行时门禁（submitDisabled / 手机视口 enterSubmits / 空输入 /
 * 反转投递让位）由调用方执行，本函数只回答"键位表说了算"的部分。
 */
export function resolveComposerKeyAction(
  event: Pick<ShortcutBindingEvent, "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
  effective: ComposerEffectiveBindings,
  platformInfo?: { platform?: string; userAgent?: string },
): ComposerKeyAction | null {
  for (const binding of effective.composerInsertNewline ?? []) {
    if (matchesShortcutBinding(event, binding, platformInfo)) {
      return "newline";
    }
  }
  for (const binding of effective.composerSend ?? []) {
    if (matchesShortcutBinding(event, binding, platformInfo)) {
      return "send";
    }
  }
  return null;
}

/**
 * 裸 Enter 是否应回退为换行（主链前置检查）：
 * 用户已把 `composerSend` 改绑走（生效绑定不再包含裸 Enter，含显式空数组 = 未设置）时，
 * 裸 Enter 不再代表发送，放行 Lexical 换行——"Ctrl+Enter 党"改绑后的预期行为。
 */
export function shouldBareEnterFallThroughToNewline(effective: ComposerEffectiveBindings): boolean {
  return !effective.composerSend.includes("Enter");
}

/** Why the send button/Enter submission is unavailable right now. */
export type ComposerSendReadiness =
  | "ready"
  | "disabled"
  | "submit_blocked"
  | "submitting"
  | "attachments_not_ready"
  | "routing_rejected"
  | "empty"
  | "not_submittable";

/**
 * Enter has two independent meanings that must not be conflated:
 *
 * - ENTER_IS_NEWLINE_BY_USER_BINDING: the user bound Enter to newline (or the
 *   mobile viewport policy says so). Lexical inserts a newline.
 * - ENTER_IS_SEND_BUT_SUBMISSION_BLOCKED: Enter still means Send, but sending
 *   is temporarily impossible. Inserting a newline here is a lie: the draft
 *   grows and the message is not queued either. The caller must prevent the
 *   newline and report the exact blocker instead.
 */
export type ComposerEnterIntent = "newline" | "send" | "blocked";

export function resolveComposerEnterIntent(input: {
  modified: boolean;
  submitDisabled: boolean;
  enterSubmits: boolean;
  bareEnterIsSend: boolean;
  readiness?: ComposerSendReadiness;
}): ComposerEnterIntent {
  if (!input.modified && !input.bareEnterIsSend) return "newline";
  if (!input.modified && !input.enterSubmits) return "newline";
  if (input.readiness === "empty" && !input.modified) return "newline";
  if (input.submitDisabled || (input.readiness !== undefined && input.readiness !== "ready"))
    return "blocked";
  return "send";
}

export function describeComposerSendBlocker(readiness?: ComposerSendReadiness): string {
  switch (readiness) {
    case "disabled":
      return "The composer is disabled for this session.";
    case "submitting":
      return "A message is already being submitted.";
    case "attachments_not_ready":
      return "Attachments are still being prepared.";
    case "routing_rejected":
      return "This session's routing does not accept messages right now.";
    case "not_submittable":
      return "The current message cannot be submitted yet.";
    case "submit_blocked":
      return "Sending is blocked for this session right now.";
    default:
      return "Sending is blocked right now. The draft was kept.";
  }
}
