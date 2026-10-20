// T-283 (SAIHANDOFF F-03): the ONE owner of the provenance -> classification
// mapping, shared by every consumer so live and cold can never disagree.
//
// Two axes are deliberately separate:
//   * AUTHORIZATION -- "may this input be counted as an operator decision?".
//     `inputProvenanceSemanticsOrigin` answers it for the persisted message
//     semantics and never returns `real_user` for anything but a genuine
//     operator submission; `humanAuthored` is re-derived from the same fact.
//   * DISPLAY -- "how is this row drawn?". `inputProvenanceRowOrigin` /
//     `inputProvenanceTurnHeaderOrigin` answer it for the v4 projection and
//     return `undefined` when provenance carries nothing to classify, so the
//     caller keeps its historical fallback and never hides a legitimate
//     historical message merely because its authority is unknown.

/** The minimal structural view of an admitted input's provenance. */
export interface InputProvenanceLike {
  origin?: string | undefined;
  source?: string | undefined;
  humanAuthored?: boolean | undefined;
}

/** v4 `userInput.origin` values this mapping can produce. */
export type InputProvenanceRowOrigin =
  | "realUser"
  | "backgroundResult"
  | "goalContinuation"
  | "synthetic";

const AGENT_CONTINUATION_SOURCES = new Set(["goal_autocontinuation", "background_automation"]);

/**
 * The v4 row origin implied by an admitted input's provenance. `undefined` means
 * "nothing to classify": the caller applies its own fallback.
 */
export function inputProvenanceRowOrigin(
  provenance: InputProvenanceLike | undefined,
): InputProvenanceRowOrigin | undefined {
  if (provenance === undefined) return undefined;
  switch (provenance.origin) {
    case "real_user":
      return "realUser";
    case "agent_runtime":
      if (provenance.source === "goal_autocontinuation") return "goalContinuation";
      if (provenance.source === "background_automation") return "backgroundResult";
      return "synthetic";
    case "import":
      return "synthetic";
    default:
      return undefined;
  }
}

/** v4 `turnHeader.origin` values this mapping can produce. */
export type InputProvenanceTurnHeaderOrigin =
  | "userInput"
  | "backgroundResult"
  | "goalContinuation";

/**
 * Same decision as `inputProvenanceRowOrigin`, in the turn-header vocabulary.
 * `turnHeader.origin` has no synthetic value, so the synthetic/mailbox family
 * keeps the historical `userInput` default exactly as the legacy inputSource
 * mapping did.
 */
export function inputProvenanceTurnHeaderOrigin(
  provenance: InputProvenanceLike | undefined,
): InputProvenanceTurnHeaderOrigin | undefined {
  const rowOrigin = inputProvenanceRowOrigin(provenance);
  if (rowOrigin === undefined) return undefined;
  if (rowOrigin === "goalContinuation") return "goalContinuation";
  if (rowOrigin === "backgroundResult") return "backgroundResult";
  return "userInput";
}

/** Persisted `message.semantics.origin` values this mapping can produce. */
export type InputProvenanceSemanticsOrigin = "real_user" | "agent_runtime" | "system" | "import";

/**
 * The authorization classification as persisted message semantics. Anything
 * unrecognized (`system`, `unknown`, a legacy value) becomes `system`, never
 * `real_user`: an unclassifiable input must not silently become a human decision.
 */
export function inputProvenanceSemanticsOrigin(
  provenance: InputProvenanceLike | undefined,
): InputProvenanceSemanticsOrigin | undefined {
  if (provenance === undefined) return undefined;
  switch (provenance.origin) {
    case "real_user":
      return "real_user";
    case "agent_runtime":
      return "agent_runtime";
    case "import":
      return "import";
    default:
      return "system";
  }
}

/**
 * The authorization fact itself, re-derived from the classification rather than
 * trusted as a boolean: a provenance that carries `humanAuthored: true` without a
 * `real_user` origin grants nothing.
 */
export function inputProvenanceHumanAuthored(provenance: InputProvenanceLike | undefined): boolean {
  return provenance?.origin === "real_user" && provenance.humanAuthored === true;
}

/** Re-exported so a display consumer can name the agent-continuation routes. */
export function isAgentRuntimeContinuationSource(source: string | undefined): boolean {
  return source !== undefined && AGENT_CONTINUATION_SOURCES.has(source);
}
