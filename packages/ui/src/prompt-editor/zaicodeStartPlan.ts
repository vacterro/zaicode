import { ZAICODE_SAIPEN_START_COMMAND } from "@/zaicode/zaicodeSaipen.js";

/**
 * T-318 (SRC-230): what a START click resolved to. The gesture never creates a
 * session any more -- a plain click sends the goal in the session that has
 * focus, and Shift+click empties that session first.
 */
export type ZaicodeStartPlan =
  | { kind: "worker" }
  | { kind: "send" }
  | { kind: "clearThenSend" }
  | { kind: "skip" };

/**
 * A subscription engine picked on the sidebar keeps its worker route on a plain
 * click only; Shift always means "here". Without a session there is nothing to
 * clear, so Shift degrades to a plain send in the draft.
 */
export function planZaicodeStart(input: {
  shiftKey: boolean;
  disabled: boolean;
  sessionId: string | null;
  engineAccount: unknown;
}): ZaicodeStartPlan {
  if (input.disabled) return { kind: "skip" };
  if (input.shiftKey) return input.sessionId ? { kind: "clearThenSend" } : { kind: "send" };
  if (input.engineAccount) return { kind: "worker" };
  return { kind: "send" };
}

/** The START button's own words (compact row, aria, tooltip) for both routes. */
export function zaicodeStartCopy(engineAccount: { short: string; label: string } | null): {
  compact: string;
  aria: string;
  title: string;
} {
  if (engineAccount) {
    return {
      compact: `START with ${engineAccount.short} (worker) · Shift+click: clears this session, then ${ZAICODE_SAIPEN_START_COMMAND}`,
      aria: `Start ${engineAccount.label} as a worker · Shift+click: clears this session, then sends the goal`,
      title: `START with ${engineAccount.short} ${engineAccount.label}: its CLI starts as a worker. Shift+click: empties THIS session, then sends ${ZAICODE_SAIPEN_START_COMMAND} in it.`,
    };
  }
  return {
    compact: `START — ${ZAICODE_SAIPEN_START_COMMAND} in THIS session · Shift+click: clears this session first`,
    aria: `Start SAIPEN goal in this session · Shift+click: clears this session first`,
    title: `${ZAICODE_SAIPEN_START_COMMAND} — sent in THIS session, no new one. Shift+click: empties THIS session first, then sends it.`,
  };
}
