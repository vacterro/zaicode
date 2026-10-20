import type { TurnInputIntentMetadata, TurnInputProvenance } from "@zcode/contracts";
import { INPUT_PROVENANCE_ORIGINS, INPUT_PROVENANCE_SOURCES } from "@zcode/contracts";
import type { ModelSelection } from "@zcode/shared";
import type {
  AttachmentRef,
  CommandEnvelope,
  InputProvenanceClaim,
  QueueItem,
} from "@zcode/shared/zcode-protocol-v4";
import type { SubmissionMode } from "@zcode/shared/zcode-protocol-v4";
import { commandAdmissionOf } from "./executor.js";
import { resolveSessionResponseContract } from "../response-contract-admission.js";

interface CanonicalCommandIntent {
  kind: "sendText" | "sendGoalCommand";
  text: string;
  modelSelection?: ModelSelection;
  mode?: SubmissionMode;
  planEnabled?: boolean;
  sourceCommandId?: string;
  clientId?: string;
  queueItemId?: string;
  requestedDelivery?: TurnInputIntentMetadata["requestedDelivery"];
  admittedDelivery?: TurnInputIntentMetadata["admittedDelivery"];
  fallbackReasonCode?: string;
  attachmentRefs?: readonly AttachmentRef[];
  sharedContextRefs?: TurnInputIntentMetadata["sharedContextRefs"];
  provenance?: TurnInputIntentMetadata["provenance"];
  /** T-286: the contract the rebuilt input inherits, when the caller has it. */
  responseContract?: TurnInputIntentMetadata["responseContract"];
}

// ── T-283 (SAIHANDOFF F-03): admission-owned input provenance ──────────────
//
// The product's own Auto Goal owner sends its continuation through the SAME
// model-compatible user-message transport a human uses (`sendText` with an
// `auto-goal:<intentId>:<revision>` command id). F-03 is that this transport
// classified it `semantics.origin: real_user` / `kind: user_prompt`, so an
// automatic continuation was indistinguishable from a fresh human decision.
//
// The fix keeps the transport and records the authoritative origin HERE, at the
// one validated admission boundary, rather than duplicating a schema downstream.
// The rules are monotone on purpose: the wire may only REMOVE human authority,
// never assert it. `humanAuthored` is DERIVED from the classification and is
// never read from a producer field, so a forged `humanAuthored: true` grants
// nothing.

/** The product's own automatic-continuation command namespace. */
export const AUTO_GOAL_COMMAND_PREFIX = "auto-goal:";

const PROVENANCE_ORIGINS: ReadonlySet<string> = new Set(INPUT_PROVENANCE_ORIGINS);
const PROVENANCE_SOURCES: ReadonlySet<string> = new Set(INPUT_PROVENANCE_SOURCES);

function knownOrigin(value: string | undefined): TurnInputProvenance["origin"] | undefined {
  return value !== undefined && PROVENANCE_ORIGINS.has(value)
    ? (value as TurnInputProvenance["origin"])
    : undefined;
}

function knownSource(value: string | undefined): TurnInputProvenance["source"] | undefined {
  return value !== undefined && PROVENANCE_SOURCES.has(value)
    ? (value as TurnInputProvenance["source"])
    : undefined;
}

/**
 * Origin implied by a declared producer route, so a producer that names only the
 * route is still classified correctly. `retry`/`queue_promotion` inherit their
 * origin from the canonical input and therefore imply nothing here.
 */
function originOfDeclaredSource(
  source: TurnInputProvenance["source"] | undefined,
): TurnInputProvenance["origin"] | undefined {
  switch (source) {
    case "goal_autocontinuation":
    case "background_automation":
    case "synthetic_notice":
      return "agent_runtime";
    case "shared_context_import":
      return "import";
    default:
      return undefined;
  }
}

/**
 * Trusted provenance of ONE freshly admitted command.
 *
 * Order of decision, first match wins:
 *  1. a recognized declared origin (an explicit `real_user` claim from the wire
 *     is NOT trusted and degrades to `unknown`);
 *  2. the origin implied by a recognized declared producer route;
 *  3. `unknown` when a provenance block was declared but nothing in it is
 *     recognized -- an unclassifiable claim is never the operator ingress;
 *  4. otherwise the command's own namespace: the product's Auto Goal namespace
 *     is agent_runtime (the prefix can only NARROW authority, so it is never
 *     proof of authority), anything else is the ordinary operator ingress.
 */
export function admittedInputProvenance(input: {
  commandId: string;
  sourceCommandId: string;
  queueItemId?: string;
  clientId?: string;
  declared?: InputProvenanceClaim | undefined;
}): TurnInputProvenance {
  const declared = input.declared;
  const declaredOrigin = knownOrigin(declared?.origin);
  const declaredSource = knownSource(declared?.source);
  const autoContinuation = input.commandId.startsWith(AUTO_GOAL_COMMAND_PREFIX);

  let origin: TurnInputProvenance["origin"];
  if (declaredOrigin !== undefined) {
    // Only the ingress itself may be `real_user`; a declaration that claims it is
    // exactly the spoof this boundary exists to refuse.
    origin = declaredOrigin === "real_user" ? "unknown" : declaredOrigin;
  } else if (declared !== undefined && declared.origin !== undefined) {
    origin = "unknown";
  } else {
    origin =
      originOfDeclaredSource(declaredSource) ??
      (autoContinuation ? "agent_runtime" : "real_user");
  }

  const source: TurnInputProvenance["source"] =
    declaredSource ??
    (declared !== undefined && declared.source !== undefined
      ? "unknown"
      : autoContinuation
        ? "goal_autocontinuation"
        : "operator_ingress");

  return {
    sourceCommandId: input.sourceCommandId,
    ...(input.queueItemId ? { queueItemId: input.queueItemId } : {}),
    ...(input.clientId ? { clientId: input.clientId } : {}),
    origin,
    source,
    humanAuthored: origin === "real_user",
    ...(declared?.originalUserIntentId
      ? { originalUserIntentId: declared.originalUserIntentId }
      : {}),
    ...(declared?.goalIntentId ? { goalIntentId: declared.goalIntentId } : {}),
    ...(declared?.producerId ? { producerId: declared.producerId } : {}),
  };
}

/**
 * Provenance of an input REBUILT from a canonical input (edit, retry, queue
 * promotion). The authorization classification is invariant here -- a retry or a
 * promotion re-issues the same decision, it never creates a new one -- while the
 * producer route is re-stamped. Legacy canonical inputs carry no classification
 * and stay `unknown`: nothing may silently upgrade them to human authority.
 */
export function rebuiltInputProvenance(input: {
  inherited: TurnInputProvenance | undefined;
  sourceCommandId: string;
  route: TurnInputProvenance["source"];
  queueItemId?: string;
  clientId?: string;
}): TurnInputProvenance {
  const inherited = input.inherited;
  if (inherited === undefined) {
    return {
      sourceCommandId: input.sourceCommandId,
      ...(input.queueItemId ? { queueItemId: input.queueItemId } : {}),
      ...(input.clientId ? { clientId: input.clientId } : {}),
    };
  }
  const originalUserIntentId =
    inherited.originalUserIntentId ??
    (inherited.origin === "real_user" ? inherited.sourceCommandId : undefined);
  return {
    ...inherited,
    ...(input.queueItemId ? { queueItemId: input.queueItemId } : {}),
    ...(input.clientId ? { clientId: input.clientId } : {}),
    source: input.route,
    ...(originalUserIntentId ? { originalUserIntentId } : {}),
  };
}

export function inputIntentMetadata(
  envelope: CommandEnvelope,
  options: {
    text: string;
    requestedDelivery: TurnInputIntentMetadata["requestedDelivery"];
    admittedDelivery?: TurnInputIntentMetadata["admittedDelivery"];
    fallbackReasonCode?: string;
    attachmentRefs?: readonly AttachmentRef[];
    modelSelection?: ModelSelection;
    mode?: SubmissionMode;
    planEnabled?: boolean;
    sharedContextRefs?: TurnInputIntentMetadata["sharedContextRefs"];
    /** T-283: producer-declared provenance carried on the input command payload. */
    inputProvenance?: InputProvenanceClaim | undefined;
    /** T-286: the caller may supply the session's response contract instead of resolving it. */
    responseContract?: TurnInputIntentMetadata["responseContract"];
  },
): TurnInputIntentMetadata {
  const admission = commandAdmissionOf(envelope);
  const clientId = envelope.clientId || "cli";
  // T-286 (SAIHANDOFF F-06): the contract in force is recorded at the same
  // admission boundary as the provenance, from the documents the host read.
  const responseContract =
    options.responseContract ?? resolveSessionResponseContract({ projectRoot: process.cwd() });
  return {
    sourceCommandId: envelope.commandId,
    queueItemId: admission.queueItemId,
    clientId,
    kind:
      envelope.type === "compact"
        ? "compact"
        : envelope.type === "sendGoalCommand"
          ? "sendGoalCommand"
          : "sendText",
    // live intent 过去只带 kind/来源，projection 只能回退可见 command 文案；
    // goal 的 displayText（如 `/GoAl replace X`）不是 runtime 已解析的 canonical objective。
    text: options.text,
    ...(options.modelSelection ? { modelSelection: options.modelSelection } : {}),
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.planEnabled !== undefined ? { planEnabled: options.planEnabled } : {}),
    admissionSeq: admission.admissionSeq,
    admittedAt: admission.admittedAt,
    requestedDelivery: options.requestedDelivery,
    admittedDelivery:
      options.admittedDelivery ??
      (options.requestedDelivery === "guide"
        ? "guide"
        : options.requestedDelivery === "queue"
          ? "queue"
          : "startNow"),
    ...(options.fallbackReasonCode ? { fallbackReasonCode: options.fallbackReasonCode } : {}),
    ...(options.attachmentRefs ? { attachmentRefs: [...options.attachmentRefs] } : {}),
    ...(options.sharedContextRefs ? { sharedContextRefs: [...options.sharedContextRefs] } : {}),
    provenance: admittedInputProvenance({
      commandId: envelope.commandId,
      sourceCommandId: envelope.commandId,
      queueItemId: admission.queueItemId,
      clientId,
      ...(options.inputProvenance ? { declared: options.inputProvenance } : {}),
    }),
    responseContract,
  };
}

/** edit/retry 以新 commandId 重建，但保留原 canonical kind/delivery/cause。 */
export function inputIntentMetadataFromCanonical(
  envelope: CommandEnvelope,
  canonical: CanonicalCommandIntent,
  text = canonical.text,
): TurnInputIntentMetadata {
  const admission = commandAdmissionOf(envelope);
  const originalSourceCommandId =
    canonical.provenance?.sourceCommandId ?? canonical.sourceCommandId;
  const clientId = envelope.clientId || canonical.clientId || "cli";
  return {
    sourceCommandId: envelope.commandId,
    queueItemId: admission.queueItemId,
    clientId,
    kind: canonical.kind,
    text,
    ...(canonical.modelSelection ? { modelSelection: canonical.modelSelection } : {}),
    ...(canonical.mode ? { mode: canonical.mode } : {}),
    ...(canonical.planEnabled !== undefined ? { planEnabled: canonical.planEnabled } : {}),
    admissionSeq: admission.admissionSeq,
    admittedAt: admission.admittedAt,
    requestedDelivery: canonical.requestedDelivery ?? "startNow",
    admittedDelivery: canonical.admittedDelivery ?? "startNow",
    ...(canonical.fallbackReasonCode ? { fallbackReasonCode: canonical.fallbackReasonCode } : {}),
    ...(canonical.attachmentRefs ? { attachmentRefs: [...canonical.attachmentRefs] } : {}),
    ...(canonical.sharedContextRefs ? { sharedContextRefs: [...canonical.sharedContextRefs] } : {}),
    ...(canonical.provenance || originalSourceCommandId
      ? {
          provenance: rebuiltInputProvenance({
            inherited: canonical.provenance,
            sourceCommandId: originalSourceCommandId ?? envelope.commandId,
            route: envelope.type === "retryTurn" ? "retry" : "unknown",
            queueItemId: admission.queueItemId,
            clientId,
          }),
        }
      : {}),
    // T-286: the contract in force is a session fact, so a rebuilt input records
    // it too rather than leaving the session unreadable from an edit/retry turn.
    responseContract:
      canonical.responseContract ?? resolveSessionResponseContract({ projectRoot: process.cwd() }),
  };
}

/** sendQueuedNow 只能转换原 QueueItem，禁止用 promotion commandId 重建来源。 */
export function inputIntentMetadataFromQueueItem(
  item: QueueItem,
  canonicalText: string,
): TurnInputIntentMetadata {
  return {
    sourceCommandId: item.sourceCommandId,
    queueItemId: item.queueItemId,
    clientId: item.clientId,
    kind: item.kind,
    text: canonicalText,
    ...(item.modelSelection ? { modelSelection: item.modelSelection } : {}),
    ...(item.mode ? { mode: item.mode } : {}),
    ...(item.planEnabled !== undefined ? { planEnabled: item.planEnabled } : {}),
    admissionSeq: item.order.admissionSeq,
    admittedAt: item.admittedAt,
    requestedDelivery: item.delivery.requested,
    admittedDelivery: item.delivery.admitted,
    ...(item.order.queuePosition !== undefined ? { queuePosition: item.order.queuePosition } : {}),
    ...(item.delivery.fallbackReasonCode
      ? { fallbackReasonCode: item.delivery.fallbackReasonCode }
      : {}),
    attachmentRefs: item.attachments,
    ...(item.sharedContextRefs ? { sharedContextRefs: [...item.sharedContextRefs] } : {}),
    // 提升只改变调度状态；重试／编辑原始输入的来源关联不能在此丢失。
    provenance: rebuiltInputProvenance({
      inherited: item.provenance,
      sourceCommandId: item.provenance?.sourceCommandId ?? item.sourceCommandId,
      route: "queue_promotion",
      queueItemId: item.queueItemId,
      clientId: item.clientId,
    }),
    // T-286: queue promotion is still the same session, so it records the same
    // contract identity as the input it promotes.
    responseContract: resolveSessionResponseContract({ projectRoot: process.cwd() }),
  };
}
