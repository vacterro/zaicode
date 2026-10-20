// T-284 (SAIHANDOFF F-04): recognized mechanical continuation admission.
//
// Fourteen admitted `cc` inputs were answered by the model from remembered
// blocker text with no router invocation: free-text `sendText` (and its retry,
// edit and queue-promotion re-entries) carried the bare continuation token
// straight into a model turn. This module is the one host-owned place that
// knows a bare `cc` is a COMMAND, not prose: admitted here it either executes
// its mechanical route (the real goal machinery below) or is refused with an
// explicit authoritative receipt. Project work starts only from a fresh routed
// action, never from model memory about the bare token.
//
// Three rules this module exists to keep:
//
// 1. Recognition is exact-token only. Ordinary prose that merely CONTAINS `cc`
//    is never privileged, and a `cc` stapled to attachments is model work.
// 2. Authority is exercised, never created (T-283 monotone rule). The admitted
//    intent's CLASSIFIED provenance decides: the operator ingress may continue,
//    an automatic continuation must still carry its original human intent id.
//    A model turn can never mint human authority through this path.
// 3. Fresh state only. Goal terminal states come from a live `readTarget`, not
//    from transcript/model memory, so refusal receipts state durable facts.
//
// T-295 (SRC-208) adds the missing half of rule 1's claim: "recognized" was
// being read as "belongs to this session's goal", so a bare `cc` in a SAIPEN
// project answered with `guard.recognizedContinueWithoutGoal` /
// `guard.recognizedContinueGoalComplete` whenever the unrelated local goal was
// absent or done. Recognition now names the OWNER first (continue-owner.ts):
// a continuable session goal keeps the T-284 route untouched, an operator `cc`
// in a SAIPEN project goes to the project's canonical continuation boundary
// (that launcher's own answer is the authority -- `.saipen/` alone grants
// nothing), and neither owner refuses explicitly. No branch here reaches a
// model turn on a refused command; actionable project work uses Core admission.
import type { TurnInputIntentMetadata } from "@zcode/contracts";
import {
  RECOGNIZED_CONTINUE_COMMAND_TEXT,
  isRecognizedContinueCommand,
  type CommandEnvelope,
  type CommandPayloadMap,
  type CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import { inputIntentMetadata } from "./input-intent.js";
import { startPromptTurn } from "./prompt-turn.js";
import {
  hasSaipenProjectMemory,
  isSessionGoalContinuable,
  resolveContinueOwner,
  type SaipenContinueAnswer,
} from "./continue-owner.js";
import type { SteerTurnOptions, SubmitPromptOptions } from "../../app/types.js";
import { runWithSessionResidencyFinalization } from "../../zcode-protocol/session-residency.js";
import type { V4CommandCoreHost, V4SessionRecordView } from "./types.js";
import {
  V4RecognizedContinueRejectedError,
  isSessionBusyForContinue,
  describeSaipenRefusal,
  saipenRefusalCode,
} from "./continue-diagnostics.js";

export { V4RecognizedContinueRejectedError, isSessionBusyForContinue } from "./continue-diagnostics.js";

export {
  RECOGNIZED_CONTINUE_COMMAND_TEXT,
  isRecognizedContinueCommand,
};

/**
 * Admit one recognized continuation: mechanical route or authoritative refusal.
 *
 * The intent MUST already carry admission-classified provenance (T-283's
 * boundary); this function only READS it. A refused command throws; a routed
 * one starts the real goal continuation in the background and returns.
 */
export async function admitRecognizedContinue(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  params: {
    inputId: string;
    intent?: TurnInputIntentMetadata;
    /** The operator's verbatim submitted token; only the real-user branch uses it. */
    operatorText?: string;
  },
): Promise<void> {
  const provenance = params.intent?.provenance;
  const origin = provenance?.origin;
  const carrier =
    provenance && typeof provenance.originalUserIntentId === "string"
      ? provenance.originalUserIntentId.trim()
      : "";
  // The goal's existing authorization, exercised — never a new human decision.
  // Unknown/legacy/forged origins and carrier-less automatic sends are expired.
  // An automatic carrier is bound to its own session (`project::session::objective`):
  // a carrier minted for another session/project grants nothing here, and the
  // objective binding is re-checked against the live target below so a stale
  // carrier cannot continue a replaced goal.
  const isOperator = origin === "real_user";
  const hasCarrier = origin === "agent_runtime" && carrier.length > 0;
  if (!isOperator && !hasCarrier) {
    throw new V4RecognizedContinueRejectedError(
      "guard.recognizedContinueAuthorizationExpired",
      "this continuation carries no valid authorization: resend it or continue the goal explicitly",
    );
  }
  if (hasCarrier) {
    const sessionMarker = `::${record.app.sessionId}::`;
    if (!carrier.includes(sessionMarker)) {
      throw new V4RecognizedContinueRejectedError(
        "guard.recognizedContinueAuthorizationExpired",
        "this continuation authorization belongs to another session: resend it or continue the goal explicitly",
      );
    }
  }
  // Fail-closed backstop: every caller routes busy sessions to the queue path,
  // but a race between that check and this admission must refuse, never overlap.
  if (isSessionBusyForContinue(record)) {
    throw new V4RecognizedContinueRejectedError(
      "guard.recognizedContinueSessionBusy",
      "the session is busy: the continuation was not started",
    );
  }
  const isPlanMode = record.app.runtime?.getPlanEnabled?.() ?? record.app.getMode?.() === "plan";
  if (isPlanMode) {
    throw new V4RecognizedContinueRejectedError(
      "guard.recognizedContinuePlanMode",
      "goal continuation is unavailable in plan mode",
    );
  }
  // Durable goal state, read live: transcript/model memory is never consulted.
  const target = await record.app.readTarget();
  // T-295: which domain owns this command, decided once and deterministically.
  // Only a real operator command may be handed to the project boundary: an
  // automatic goal-continuation carrier keeps the goal-domain semantics below,
  // so a continuation the model machinery minted can never acquire SAIPEN
  // authority of its own.
  const owner = resolveContinueOwner({
    sessionGoalContinuable: isSessionGoalContinuable(target),
    saipenProject: hasSaipenProjectMemory(record.workspace?.workspacePath ?? ""),
  });
  if (owner === "saipen-project" && isOperator) {
    // Only this branch declares the operator carrier: it is the one place that
    // has BOTH the operator's real words and a proven `real_user` provenance.
    await admitSaipenProjectContinue(host, record, params);
    return;
  }
  if (!target) {
    throw new V4RecognizedContinueRejectedError(
      "guard.recognizedContinueWithoutGoal",
      "this session has no goal to continue",
    );
  }
  if (target.status === "complete") {
    throw new V4RecognizedContinueRejectedError(
      "guard.recognizedContinueGoalComplete",
      "the goal is complete: nothing to continue",
    );
  }
  if (target.status === "budget_limited") {
    throw new V4RecognizedContinueRejectedError(
      "guard.recognizedContinueBudgetExhausted",
      "the goal continuation budget is exhausted",
    );
  }
  if (target.status !== "active") {
    if (!isOperator) {
      throw new V4RecognizedContinueRejectedError(
        "guard.recognizedContinueAuthorizationExpired",
        "this continuation authorization is expired: a paused goal requires operator authorization to resume",
      );
    }
    // Paused: the same mechanical resume `resumeGoal` performs, then continue.
    const resumed = await record.app.updateTargetStatus("active");
    if (!resumed) {
      throw new V4RecognizedContinueRejectedError(
        "guard.recognizedContinueResumeFailed",
        "the paused goal could not be resumed",
      );
    }
  }
  if (hasCarrier) {
    // Stale authorization: the carrier names the human goal it was minted for.
    // A replaced objective means the old automatic send is spent, never rebound.
    const sessionMarker = `::${record.app.sessionId}::`;
    const carriedObjective = carrier.slice(carrier.indexOf(sessionMarker) + sessionMarker.length).trim();
    if (!carriedObjective || carriedObjective !== target.objective.trim()) {
      throw new V4RecognizedContinueRejectedError(
        "guard.recognizedContinueAuthorizationExpired",
        "this continuation authorization is stale: the goal changed since it was granted",
      );
    }
  }
  // No silent success: without the real goal machinery the command has no route.
  if (typeof record.app.continueActiveTarget !== "function") {
    throw new V4RecognizedContinueRejectedError(
      "guard.recognizedContinueRouterUnavailable",
      "goal continuation is unavailable: the router is not registered",
    );
  }
  await continueGoalAfterChange(host, record, {
    inputId: params.inputId,
    intent: params.intent,
    reason: "recognized_continue",
  });
}

/**
 * T-295: the SAIPEN project owns this recognized command. The project's
 * canonical continuation boundary answers with its own disposition -- there is
 * no goal row to read here. `.saipen/` selected this domain; the launcher's
 * answer is what GRANTS the route, and its refusal is
 * what the operator is told (never `goalComplete` / `withoutGoal`, which
 * describe a session goal this project command never had).
 */
async function admitSaipenProjectContinue(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  params: { inputId: string; intent?: TurnInputIntentMetadata; operatorText?: string },
): Promise<void> {
  if (typeof host.continueSaipenProject !== "function") {
    throw new V4RecognizedContinueRejectedError(
      "guard.recognizedContinueNoOwner",
      "this project has SAIPEN memory but this host exposes no trusted SAIPEN continuation boundary: run `saipen continue` in the project root",
    );
  }
  let answer: SaipenContinueAnswer;
  try {
    answer = await host.continueSaipenProject(record, params.operatorText);
  } catch (error) {
    throw new V4RecognizedContinueRejectedError(
      "guard.recognizedContinueSaipenUnavailable",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!answer.ok || !answer.action || answer.operatorActionDue || answer.safetyValveTripped || /^WAIT\b/i.test(answer.action)) {
    throw new V4RecognizedContinueRejectedError(
      saipenRefusalCode(answer),
      describeSaipenRefusal(answer),
    );
  }
  // 路由成功只说明选中了工作；旧路径在这里返回 ACK，实际没有启动任何执行。
  // 复用 Core admission，保持原命令身份并用 requireIdle 拒绝路由期间出现的并发执行。
  const started = await startPromptTurn(host, record, {
    content: [
      "saipen continue",
      "",
      "The canonical router already selected this work for the current project:",
      `Action: ${answer.action}`,
      ...(answer.ticket ? [`Ticket: ${answer.ticket}`] : []),
      ...(answer.loadPath ? [`Load path: ${answer.loadPath}`] : []),
      "Read the current project memory and the returned load path, then execute the action in this turn. Routing alone is not completion. Respect canonical WAIT and actual refusals.",
    ].join("\n"),
    inputId: params.inputId,
    intent: params.intent,
    requireIdle: true,
  });
  if (started.admission.kind !== "started_turn") {
    throw new V4RecognizedContinueRejectedError(
      "guard.recognizedContinueSessionBusy",
      "the routed SAIPEN work could not start in this session",
    );
  }
  host.logger?.info?.("recognized continue routed to the SAIPEN project boundary", {
    sessionId: record.app.sessionId,
    action: answer.action,
    ...(answer.ticket ? { ticket: answer.ticket } : {}),
  });
  // Core 已接受 turn；后续广播/队列钩子失败不能撤销 durable input 或把 ACK 变成未执行。
  try {
    await host.afterLegacyStateMutation?.(record, "saipen_project_continue");
  } catch (error) {
    try {
      host.logger?.warn?.("v4 SAIPEN continuation hook failed after admission", {
        error: error instanceof Error ? error.message : String(error),
        inputId: params.inputId,
        sessionId: record.app.sessionId,
      });
    } catch {
      // 诊断观察器也可能失败；它不能反向改变 Core 已提交的 admission。
    }
  }
}

/**
 * The `sendText` entry point for a recognized continuation (T-284): an idle
 * session admits the bare token through the real goal machinery here -- or
 * receives the authoritative refusal -- instead of a model turn. Returns the
 * admission receipt, or null when the input is not a recognized idle command
 * (a busy session keeps the existing queue path; the promotion boundary
 * recognizes it on the way out).
 */
export async function admitRecognizedContinueFromSendText(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  envelope: CommandEnvelope,
  payload: CommandPayloadMap["sendText"],
  routingMode: string | null,
): Promise<CommandResult | null> {
  if (
    !isRecognizedContinueCommand(payload.text, payload.attachments) ||
    isSessionBusyForContinue(record)
  ) {
    return null;
  }
  const intent = inputIntentMetadata(envelope, {
    text: payload.text,
    requestedDelivery:
      payload.requestedDelivery ??
      (routingMode === "guide" ? "guide" : routingMode === "enqueue" ? "queue" : "startNow"),
    // T-283: a producer may DECLARE its provenance; admission classifies it.
    ...(payload.inputProvenance ? { inputProvenance: payload.inputProvenance } : {}),
  });
  await admitRecognizedContinue(host, record, {
    inputId: envelope.commandId,
    intent,
    // The operator's own submitted token, bound to this command: the project
    // boundary declares it as the SAIPEN_TASK_FILE carrier (T-295 TASK 3).
    operatorText: payload.text,
  });
  return {
    type: "inputAccepted",
    delivery: "startNow",
    inputId: envelope.commandId,
  };
}

/**（旧 continueGoalAfterChange 搬运，set/resume/continue-command 共用）：
 * plan 模式或已有 active turn 时不续跑（只落库目标，用户后续显式推进）；
 * 否则模型就绪检查 → 上锁 → 后台 continueActiveTarget。
 *
 * Lives here (not in a command group) so every entry point — sendText,
 * queue promotion, retry/edit — shares one continuation starter and no import
 * cycle points back into a handler group.
 */
export async function continueGoalAfterChange(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  params: {
    foregroundPromotionLeaseId?: string;
    inputId: string;
    intent?: SteerTurnOptions["intent"];
    reason: string;
  },
): Promise<void> {
  const isPlanMode = record.app.runtime?.getPlanEnabled?.() ?? record.app.getMode?.() === "plan";
  // continueActiveTarget 是 App 的必选能力；能否继续只取决于当前模式和是否已有活跃 turn。
  const canContinue = !isPlanMode && !record.activeAbortController;
  if (canContinue) {
    await host.ensureModelReady?.(record);
    const abortController = new AbortController();
    record.activeAbortController = abortController;
    void runWithSessionResidencyFinalization(record, () =>
      runGoalContinuationInBackground(host, record, {
        abortController,
        foregroundPromotionLeaseId: params.foregroundPromotionLeaseId,
        inputId: params.inputId,
        intent: params.intent,
      }),
    ).catch(() => {
      // 后台 goal continuation 的失败经事件流降级上报；兜底防 unhandled rejection。
    });
  }
  // 旧协议路径在续跑起跑后立即 afterStateMutation(goal_set/goal_replaced/goal_resumed)
  // → 钩子等价替代；v4 投影经 TargetChanged 事件自然收口。
  await host.afterLegacyStateMutation?.(record, params.reason);
}

async function runGoalContinuationInBackground(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  params: {
    abortController: AbortController;
    foregroundPromotionLeaseId?: string;
    inputId: string;
    intent?: SteerTurnOptions["intent"];
  },
): Promise<void> {
  let mutationReason = "goal_continuation_completed";
  try {
    await record.app.continueActiveTarget?.({
      abortSignal: params.abortController.signal,
      inputId: params.inputId,
      intent: params.intent,
      queryId: params.inputId as SubmitPromptOptions["queryId"],
    });
  } catch {
    mutationReason = "goal_continuation_failed";
  } finally {
    if (params.foregroundPromotionLeaseId) {
      record.app.runtime.releaseForegroundPromotionLease(params.foregroundPromotionLeaseId);
    }
    if (record.activeAbortController === params.abortController) {
      // 续跑结束后应立刻释放活跃锁；广播只是后续动作，
      // 如果继续占锁，连续 /goal 会被误判为已有活跃 turn。
      record.activeAbortController = undefined;
    }
  }
  await host.afterLegacyStateMutation?.(record, mutationReason);
}
