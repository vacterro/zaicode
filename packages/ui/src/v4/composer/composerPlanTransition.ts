import type { V4ComposerDraft } from "@/v4/composer/composerDraftStore.js";
import type { SessionConfigState } from "@zcode/shared/zcode-protocol-v4";
import { isZaicodeProductMode } from "@zcode/shared";

/** 新工具结果直接设置标记；仅去重已处理结果，不保护期间的手动改选。 */
export function applyComposerPlanTransition(
  draft: V4ComposerDraft,
  transition: SessionConfigState["planTransition"],
): V4ComposerDraft {
  if (!transition || draft.lastPlanTransitionId === transition.toolCallId) return draft;
  return {
    ...draft,
    lastPlanTransitionId: transition.toolCallId,
    // 重放历史 tool 结果不能替用户勾选 Plan；显式选择仍由当前 composer draft 拥有。
    planEnabled:
      transition.planEnabled && (!isZaicodeProductMode() || draft.planChoice === "explicit"),
    ...(transition.planEnabled ? {} : { planChoice: undefined }),
  };
}
