/**
 * T-396: a live Effort change is a command, not a draft edit.
 *
 * The composer owns the next submission's intent, but a bound session has its own
 * runtime selection. Until this ticket the thought picker only rewrote the draft, so the
 * runtime kept the old level until the user happened to send another message -- the
 * "change effort without restarting the task" case was silently a no-op.
 *
 * These helpers keep the decision and the read-out pure so both are testable without a
 * renderer: the plan says whether a command is needed at all, and the phase is derived
 * from the runtime projection rather than from the ACK alone.
 */

export type ZaicodeEffortSwitchPlan =
  | { kind: "draft"; thought: string }
  | { kind: "dispatch"; thought: string }
  | { kind: "unsupported"; thought: string };

export type ZaicodeEffortSwitchPhase =
  | "REQUESTED"
  | "APPLYING"
  | "APPLIED"
  | "REJECTED"
  | "UNSUPPORTED";

/**
 * Decide whether picking `thought` needs a `switchModelConfig` command.
 *
 * - no bound session (or a read-only pane): the choice stays draft-only, the first send
 *   carries it, exactly as before this ticket.
 * - the session exists but its projection has not arrived: still draft-only. There is no
 *   authoritative provider/model to send yet, and guessing one would turn an Effort pick
 *   into a model switch.
 * - the runtime projection does not list the level while listing others: refuse locally
 *   and say so, instead of spending a CAS that the handler must reject.
 * - the session already pins this level: the handler would answer `config.unchanged`,
 *   so there is nothing to send.
 */
export function zaicodeEffortSwitchPlan(input: {
  sessionId: string | null;
  readOnly: boolean;
  thought: string;
  liveProvider: string | null;
  liveModel: string | null;
  pinnedThought: string | null;
  supportedThoughtLevels: readonly string[];
}): ZaicodeEffortSwitchPlan {
  const thought = input.thought.trim();
  if (!input.sessionId || input.readOnly || !thought) return { kind: "draft", thought };
  if (!input.liveProvider || !input.liveModel) return { kind: "draft", thought };
  if (
    input.supportedThoughtLevels.length > 0 &&
    !input.supportedThoughtLevels.includes(thought)
  ) {
    return { kind: "unsupported", thought };
  }
  if (input.pinnedThought?.trim() === thought) return { kind: "draft", thought };
  return { kind: "dispatch", thought };
}

/**
 * The strip reads runtime truth: an accepted ACK is not proof the switch landed, and the
 * projection is. `APPLIED` therefore requires the snapshot's effective thought to equal
 * the request; anything accepted but not yet projected is `APPLYING`.
 */
export function zaicodeEffortSwitchPhase(input: {
  requested: string | null;
  unsupported: boolean;
  acknowledged: boolean;
  error: string | null;
  effectiveThought: string;
}): ZaicodeEffortSwitchPhase | null {
  const requested = input.requested?.trim();
  if (!requested) return null;
  if (input.unsupported) return "UNSUPPORTED";
  if (input.error) return "REJECTED";
  if (input.effectiveThought.trim() === requested) return "APPLIED";
  return input.acknowledged ? "APPLYING" : "REQUESTED";
}

/** One line for the strip; the caller renders it with the phase as a data attribute. */
export function describeZaicodeEffortSwitchPhase(
  phase: ZaicodeEffortSwitchPhase,
  input: {
    requested: string;
    effectiveThought: string;
    executing: boolean;
    error?: string | null;
  },
): string {
  const effective = input.effectiveThought.trim() || "the current level";
  switch (phase) {
    case "REQUESTED":
      return `Effort ${input.requested} requested…`;
    case "APPLYING":
      return input.executing
        ? `Effort switch to ${input.requested} applies to the next request; in-flight keeps ${effective}`
        : `Applying effort ${input.requested}…`;
    case "APPLIED":
      return `Effort: ${input.requested}`;
    case "REJECTED":
      return `Effort switch failed — ${input.error ?? "rejected"}. Still on ${effective}.`;
    case "UNSUPPORTED":
      return `This model does not offer effort ${input.requested}.`;
  }
}

/**
 * A late ACK belongs to an older request. Only the newest request may rewrite the strip,
 * so a slow model switch cannot overwrite a newer effort state (or the reverse).
 */
export function zaicodeLiveSwitchAckIsCurrent(ackSeq: number, latestSeq: number): boolean {
  return ackSeq === latestSeq;
}
