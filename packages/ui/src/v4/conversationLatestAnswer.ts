import type { AssistantTextRow, UserInputRow } from "@zcode/shared/zcode-protocol-v4";

/**
 * SRC-139: the compact "latest answer" anchor.
 *
 * The sidebar's sessions-index only ever kept the boolean `hasAssistantOutput` (the
 * preview text was dropped at the projection), so nothing in the conversation view
 * could say where the latest answer IS. The operator who scrolled a long transcript
 * had one way back: the bottom arrow, which goes to the end, not to the answer.
 *
 * This derives, from the render units the timeline already builds, the newest
 * assistant answer that is worth pointing at -- and it derives it every render, so
 * there is no second copy of the conversation to go stale:
 *
 *   - identity is `entityId ?? rowId`, the row's own stable id. The preview text is
 *     display data; it is never an identity and never a lookup key (text matching is
 *     not a stable mechanism: two answers can read the same, and a streaming one
 *     changes under you). The row is reached by rowId through the timeline's own
 *     scrollToQuery, the same anchor every other jump uses.
 *   - only a SETTLED answer is offered: `complete` or `interrupted` with non-empty
 *     text. A streaming row would make the bar grow and shift on every chunk, which
 *     is the jitter this must not have; a failed row has no answer to show.
 *   - nothing is remembered between renders, so a conversation or project switch
 *     cannot leave an anchor pointing into the previous conversation.
 *
 * SRC-161:REQ-009 adds the other half: the operator's own latest message, derived from
 * the same units, by the same rule (stable row id, projection-supplied `origin`, never
 * the text). The two anchors are independent — one side existing never invents the
 * other — which is what lets the strip go from one chip to two without a rewrite.
 */

/** The bar is a hint, not a reader: one line, cut on a word where possible. */
export const CONVERSATION_LATEST_ANSWER_PREVIEW_CHARS = 140;

/**
 * What the derivation reads: the timeline's render unit carries the turn's assistant
 * text rows. Declared as the minimum shape so the caller passes units unchanged and a
 * test needs no whole-unit fixture.
 */
export interface ConversationAnswerSource {
  assistantTextRows: readonly AssistantTextRow[];
  /**
   * SRC-161:REQ-009 — the same unit carries the operator's own inputs, so the paired
   * affordance derives both sides from one source. Optional: a unit that carries none
   * (an older projection, a workflow-launched turn) simply contributes no user anchor
   * instead of failing the derivation for the answer side.
   */
  visibleUserInputs?: readonly UserInputRow[];
}

/** Which side of the transcript an anchor belongs to. */
export type ConversationAnchorSide = "user" | "assistant";

export interface ConversationLatestAnswer {
  /**
   * Stable row/message identity, kept so the affordance can be keyed and compared
   * without ever looking at the text.
   */
  identity: string;
  /** The virtual/DOM anchor the jump uses: `[data-row-id="<rowId>"]`. */
  rowId: number;
  /** The render unit the row belongs to; needed to mount it before a precise jump. */
  unitIndex: number;
  /** One short line of the answer, whitespace collapsed. */
  preview: string;
  /** SRC-161:REQ-009: the two affordances are independent targets, so the side travels with the anchor. */
  side: ConversationAnchorSide;
}

/** Is this row an answer the operator would want to be taken back to? */
export function isMeaningfulAssistantAnswer(row: AssistantTextRow): boolean {
  if (row.text.trim() === "") return false;
  return row.state === "complete" || row.state === "interrupted";
}

/** One line, cut short. Newlines and runs of spaces are what make a transcript ragged. */
export function assistantAnswerPreview(
  text: string,
  maxChars: number = CONVERSATION_LATEST_ANSWER_PREVIEW_CHARS,
): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= maxChars) return flat;
  const cut = flat.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
}

/** The newest settled answer of the transcript, or null when there is none yet. */
export function latestAssistantAnswer(
  units: readonly ConversationAnswerSource[],
): ConversationLatestAnswer | null {
  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = units[index];
    if (!unit) continue;
    const rows = unit.assistantTextRows;
    for (let rowIndex = rows.length - 1; rowIndex >= 0; rowIndex -= 1) {
      const row = rows[rowIndex];
      if (!row || !isMeaningfulAssistantAnswer(row)) continue;
      return {
        identity: row.entityId ?? String(row.rowId),
        rowId: row.rowId,
        unitIndex: index,
        preview: assistantAnswerPreview(row.text),
        side: "assistant",
      };
    }
  }
  return null;
}

/**
 * SRC-161:REQ-009 — is this the operator's own message?
 *
 * `origin` is the projection's own fact about who wrote the row (the CLI writes it
 * precisely so the UI never sniffs text), and only `realUser` is the operator at the
 * keyboard. A goal continuation, a mailbox delivery, a background result or a workflow
 * launch is a row that happens to be a userInput; offering "your last message" for one
 * of those would send the operator somewhere they never typed.
 */
export function isMeaningfulUserInput(row: UserInputRow): boolean {
  return row.origin === "realUser" && row.text.trim() !== "";
}

/** The operator's newest real message, or null when they have not sent one yet. */
export function latestUserMessage(
  units: readonly ConversationAnswerSource[],
): ConversationLatestAnswer | null {
  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = units[index];
    if (!unit) continue;
    const rows = unit.visibleUserInputs ?? [];
    for (let rowIndex = rows.length - 1; rowIndex >= 0; rowIndex -= 1) {
      const row = rows[rowIndex];
      if (!row || !isMeaningfulUserInput(row)) continue;
      return {
        identity: row.entityId ?? String(row.rowId),
        rowId: row.rowId,
        unitIndex: index,
        preview: assistantAnswerPreview(row.text),
        side: "user",
      };
    }
  }
  return null;
}

/**
 * Both sides at once, each derived independently: one side existing must never decide
 * the other, and neither is remembered between renders — which is what makes a newer
 * turn replace its own chip, a conversation switch reset both, and a second strip
 * impossible.
 */
export function latestTurnAnchors(units: readonly ConversationAnswerSource[]): {
  user: ConversationLatestAnswer | null;
  assistant: ConversationLatestAnswer | null;
} {
  return { user: latestUserMessage(units), assistant: latestAssistantAnswer(units) };
}

/**
 * Is the row already on screen? The coalesced timeline rows are pixel-snapped and the
 * bar sits over the top of the viewport, so the tolerance keeps a row that only just
 * peeks out from counting as visible (which would make the click do nothing and look
 * broken) -- and keeps a fully visible row to a no-op instead of a jump that moves the
 * transcript under the operator for no reason.
 */
export function answerRowVisible(
  rowRect: Pick<DOMRect, "top" | "bottom">,
  viewportRect: Pick<DOMRect, "top" | "bottom">,
  tolerancePx = 8,
): boolean {
  return (
    rowRect.top >= viewportRect.top + tolerancePx && rowRect.bottom <= viewportRect.bottom - tolerancePx
  );
}
