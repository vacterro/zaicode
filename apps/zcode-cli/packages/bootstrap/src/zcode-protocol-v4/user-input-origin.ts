// T-283: user 行的 canonical origin 解析器。
//
// 这是"这一行输入是谁产的"判定点：admitted provenance 优先，缺失或未知时退回
// 历史 inputSource 映射。provenance 认不出来时绝不臆造人类授权 —— 授权分类在
// `inputProvenanceSemanticsOrigin`，这里只管显示分类。
import type { SyntheticUserMessageSource, TurnInputIntentMetadata } from "@zcode/contracts";
import {
  inputProvenanceRowOrigin,
  inputProvenanceTurnHeaderOrigin,
} from "@zcode/shared/zcode-protocol-v4";

/** 与 `CanonicalUserIntentFact["origin"]` 同词汇。 */
export type UserIntentRowOrigin =
  | "realUser"
  | "backgroundResult"
  | "goalContinuation"
  | "mailbox"
  | "synthetic"
  | "workflowLaunch";

/** 与 `CanonicalUserIntentFact["turnHeaderOrigin"]` 同词汇。 */
export type UserIntentTurnHeaderOrigin =
  | "userInput"
  | "backgroundResult"
  | "goalContinuation"
  | "editRerun"
  | "workflowLaunch";

export function turnHeaderOrigin(
  source: SyntheticUserMessageSource | undefined,
  provenance: TurnInputIntentMetadata["provenance"],
): UserIntentTurnHeaderOrigin {
  const admitted = inputProvenanceTurnHeaderOrigin(provenance);
  if (admitted !== undefined) return admitted;
  switch (source) {
    case "background_task":
      return "backgroundResult";
    case "goal-continuation":
      return "goalContinuation";
    case "rewind":
      return "editRerun";
    // 中枢直接启动：turnHeader 与 userInput 同用 workflowLaunch origin，UI 据此画启动卡而非用户气泡。
    case "workflow_launch":
      return "workflowLaunch";
    default:
      return "userInput";
  }
}

export function userInputOrigin(
  source: SyntheticUserMessageSource | undefined,
  provenance: TurnInputIntentMetadata["provenance"],
): UserIntentRowOrigin {
  const admitted = inputProvenanceRowOrigin(provenance);
  if (admitted !== undefined) return admitted;
  switch (source) {
    case "background_task":
      return "backgroundResult";
    case "goal-continuation":
      return "goalContinuation";
    case "subagent":
    case "subagent_message":
      // child 回复是 mailbox runtime carrier，不是真实用户输入；
      // live/cold 即使都隐藏它，也必须保留相同 canonical origin。
      return "mailbox";
    case "fork":
    case "plugin_reference":
    case "rewind":
    case "todo_reminder":
      return "synthetic";
    // 中枢直接启动：用户在中枢里的真实动作，可见 user row 但以启动卡呈现（origin 区分它与普通气泡）。
    case "workflow_launch":
      return "workflowLaunch";
    default:
      return "realUser";
  }
}
