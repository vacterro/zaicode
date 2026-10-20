// T-286 (SAIHANDOFF F-06): the ONE owner of the response-contract admission
// decision, shared so a live session and a replay can never disagree about which
// contract was in force or whether it was enforced.
//
// Three questions are deliberately separate:
//   * IDENTITY -- which STYLE/EXECUTION documents governed the session. The
//     caller hashes the bytes it actually read; this module never invents a hash
//     for a document it did not see.
//   * DECLARATION -- what those documents pin (`reply_language`, `EXEC-*`). A
//     language the document does not declare is never assumed, and a duplicated
//     declaration with different values is an unresolvable contract, not a
//     coin toss.
//   * ENFORCEMENT -- what the host can MACHINE-CHECK about the reply. Today that
//     is nothing: the host records the contract and observes the reply. The
//     admission is therefore `observed` and ALWAYS carries a bounded
//     `limitation`; silence was the F-06 defect. `enforced` is reserved for a
//     real machine check and is not reachable from this module today.

/** Structural view of the effective contract documents, as read by the caller. */
export interface ResponseContractDocuments {
  styleText?: string | null | undefined;
  executionText?: string | null | undefined;
  /** Where the text came from (path or uri), recorded so a replay can re-read it. */
  styleRef?: string | null | undefined;
  executionRef?: string | null | undefined;
  /** Content hash of the bytes read, computed by the caller (node side). */
  styleHash?: string | null | undefined;
  executionHash?: string | null | undefined;
}

export const RESPONSE_CONTRACT_ADMISSION_MODES = ["enforced", "observed", "unavailable"] as const;
export type ResponseContractAdmissionMode = (typeof RESPONSE_CONTRACT_ADMISSION_MODES)[number];

/** What the host can machine-check about one axis of the reply. */
export type ResponseContractEnforcement = "observed" | "none";

export interface ResponseContractAdmission {
  styleRef: string | null;
  executionRef: string | null;
  styleHash: string | null;
  executionHash: string | null;
  /** The pinned language, or null when the document pins none. Never assumed. */
  replyLanguage: string | null;
  /** Distinct `reply_language` values declared, so an ambiguity is visible. */
  replyLanguageDeclarations: readonly string[];
  /** Declared `EXEC-*` structure rule ids, e.g. `EXEC-RESPONSE-01`. */
  structureRules: readonly string[];
  admissionMode: ResponseContractAdmissionMode;
  enforcement: { language: ResponseContractEnforcement; structure: ResponseContractEnforcement };
  /** Bounded statement of what is NOT machine-enforced. Null only when enforced. */
  limitation: string | null;
}

const REPLY_LANGUAGE_RE = /^[ \t]*[-*]?[ \t]*reply_language[ \t]*[:=][ \t]*["'`]?([A-Za-z0-9_-]+)["'`]?/i;
const STRUCTURE_RULE_RE = /\bEXEC-[A-Z0-9-]+/g;

function nonEmpty(text: string | null | undefined): string | null {
  const trimmed = text?.trim();
  return trimmed ? trimmed : null;
}

/** Every distinct `reply_language` value the text declares, in order, deduped. */
export function responseContractReplyLanguageDeclarations(styleText: string | null | undefined): string[] {
  const text = nonEmpty(styleText);
  if (text === null) return [];
  const declared: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = REPLY_LANGUAGE_RE.exec(line);
    const value = match?.[1];
    if (value !== undefined && !declared.includes(value)) declared.push(value);
  }
  return declared;
}

/** The pinned language, or null when the document pins none or pins several. */
export function parseReplyLanguage(styleText: string | null | undefined): string | null {
  const declared = responseContractReplyLanguageDeclarations(styleText);
  return declared.length === 1 ? (declared[0] ?? null) : null;
}

/** Declared `EXEC-*` rule ids, deduped and sorted. */
export function parseResponseStructureRules(executionText: string | null | undefined): string[] {
  const text = nonEmpty(executionText);
  if (text === null) return [];
  return [...new Set(text.match(STRUCTURE_RULE_RE) ?? [])].sort();
}

function limitationOf(input: {
  readable: readonly string[];
  unreadable: readonly string[];
  replyLanguage: string | null;
  replyLanguageDeclarations: readonly string[];
  structureRules: readonly string[];
}): string {
  const parts: string[] = [];
  if (input.unreadable.length > 0) {
    parts.push(`no ${input.unreadable.join(" or ")} was readable, so no contract could be resolved`);
  }
  if (input.replyLanguageDeclarations.length > 1) {
    parts.push(
      `STYLE.md pins reply_language ${input.replyLanguageDeclarations.join(" and ")} at once, so the host refuses to choose one`,
    );
  } else if (input.replyLanguage === null) {
    parts.push("no reply_language is pinned");
  } else {
    parts.push(`the host does not verify that the reply is written in ${input.replyLanguage}`);
  }
  if (input.structureRules.length === 0) {
    parts.push("no EXEC-* response structure rule is declared");
  } else {
    parts.push(`the host does not verify the reply against ${input.structureRules.join(", ")}`);
  }
  if (input.readable.length === 0) return `response contract not admitted: ${parts.join("; ")}`;
  return `response contract observed, not enforced: ${parts.join("; ")}`;
}

/**
 * The admission record for one session's effective response contract.
 *
 * Failure is never silence: an unreadable, absent or self-contradicting contract
 * is reported as `unavailable` with the reason, and an observed contract always
 * names what the host cannot check.
 */
export function resolveResponseContractAdmission(
  documents: ResponseContractDocuments | undefined,
): ResponseContractAdmission {
  const styleText = nonEmpty(documents?.styleText);
  const executionText = nonEmpty(documents?.executionText);
  const styleHash = nonEmpty(documents?.styleHash);
  const executionHash = nonEmpty(documents?.executionHash);

  const readable: string[] = [];
  const unreadable: string[] = [];
  if (styleText !== null) readable.push("STYLE.md");
  else unreadable.push("STYLE.md");
  if (executionText !== null) readable.push("EXECUTION.md");
  else unreadable.push("EXECUTION.md");

  const replyLanguageDeclarations = responseContractReplyLanguageDeclarations(styleText);
  const replyLanguage = parseReplyLanguage(styleText);
  const structureRules = parseResponseStructureRules(executionText);

  const admitted = readable.length > 0 && replyLanguageDeclarations.length <= 1;
  const admissionMode: ResponseContractAdmissionMode = admitted ? "observed" : "unavailable";

  return {
    styleRef: nonEmpty(documents?.styleRef),
    executionRef: nonEmpty(documents?.executionRef),
    styleHash,
    executionHash,
    replyLanguage,
    replyLanguageDeclarations,
    structureRules,
    admissionMode,
    enforcement: {
      // Nothing about the reply is machine-checked today; the record says so.
      language: "none",
      structure: "none",
    },
    limitation: limitationOf({
      readable,
      unreadable,
      replyLanguage,
      replyLanguageDeclarations,
      structureRules,
    }),
  };
}

/** True when the contract was admitted AND carries the rule the caller asked for. */
export function responseContractDeclares(
  admission: ResponseContractAdmission,
  ruleId: string,
): boolean {
  return admission.admissionMode !== "unavailable" && admission.structureRules.includes(ruleId);
}
