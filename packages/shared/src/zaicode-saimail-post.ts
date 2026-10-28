/**
 * SAIMAIL post office for ZAICODE (pure part: facts in, verdict out).
 *
 * ZAICODE has always READ the operator's mailbox, but a letter can only arrive
 * when the sender is known on BOTH sides (measured with the real saimail-local):
 *
 *   - the sender's workspace must hold the operator as a registered recipient,
 *     else `send` answers RECIPIENT_UNKNOWN and nothing leaves;
 *   - the operator's workspace must hold the sender's key, else the post office
 *     accepts the bytes and QUARANTINES them (UNKNOWN_SENDER_KEY) into
 *     mail/quarantine/, a folder the title-bar envelope never looked at.
 *
 * Nobody ever registered anybody, so an agent letter could not arrive by
 * construction. The desk below is the agents' own workspace (their own seat and
 * keys, never the operator's identity), paired with the operator mailbox in both
 * directions; this module judges whether that is true right now.
 */

/** Alias under which the desk knows the operator. Agents are told to `--to operator`. */
export const ZAICODE_SAIMAIL_OPERATOR_ALIAS = "operator";
/** Seat of the agents' own workspace: the `from` shown on every agent letter. */
export const ZAICODE_SAIMAIL_DESK_SEAT = "zaicode-agent";
/** Environment variable that carries the desk path to agent processes. */
export const ZAICODE_SAIMAIL_DESK_ENV = "ZAICODE_SAIMAIL_DESK";
/** Reason SAIMAIL gives when it refuses a letter from a key it was never told about. */
export const ZAICODE_SAIMAIL_UNKNOWN_SENDER = "UNKNOWN_SENDER_KEY";

/** One registered peer as `peers.json` records it (public data only). */
export interface ZaicodeSaimailPeerFacts {
  alias: string;
  seat: string | null;
  recipientKid: string | null;
  senderKid: string | null;
  addedAt: string | null;
}

/** A letter the post office refused, from mail/quarantine/<id>/reason.json. */
export interface ZaicodeSaimailRefusedFacts {
  id: string;
  reason: string;
  /** Epoch ms the refusal was written; lets "refused after pairing" be told from history. */
  atMs: number | null;
}

/** What one SAIMAIL workspace folder says about itself, read without any key. */
export interface ZaicodeSaimailWorkspaceFacts {
  path: string;
  /** saimail-workspace.json is present and well-formed. */
  exists: boolean;
  seat: string | null;
  recipientKid: string | null;
  senderKid: string | null;
  peers: readonly ZaicodeSaimailPeerFacts[];
  unread: number;
  refused: readonly ZaicodeSaimailRefusedFacts[];
}

export interface ZaicodeSaimailFacts {
  cli: { found: boolean; version: string | null };
  /** Null while the operator has not chosen a mailbox folder. */
  operator: ZaicodeSaimailWorkspaceFacts | null;
  desk: ZaicodeSaimailWorkspaceFacts;
}

/** What the Settings buttons can ask the main process to do. */
export type ZaicodeSaimailPostAction = "pair" | "test-letter";

export interface ZaicodeSaimailPostResult {
  ok: boolean;
  message: string;
  status: ZaicodeSaimailPostStatus;
}

export type ZaicodeSaimailFix = "install-cli" | "create-operator" | "pair" | "reset-desk";
export type ZaicodeSaimailOverall = "off" | "needs-setup" | "degraded" | "ready";

export interface ZaicodeSaimailCheck {
  id: string;
  level: "ok" | "warn" | "fail";
  title: string;
  detail: string;
  /** The one action that repairs it, when there is one. */
  fix: ZaicodeSaimailFix | null;
}

export interface ZaicodeSaimailPostStatus {
  overall: ZaicodeSaimailOverall;
  cli: { found: boolean; version: string | null };
  operatorPath: string | null;
  operatorSeat: string | null;
  deskPath: string;
  deskReady: boolean;
  /** Agents can address the operator (desk holds the operator as a recipient). */
  deskKnowsOperator: boolean;
  /** The operator's post office accepts the desk's key. */
  operatorAcceptsDesk: boolean;
  unread: number;
  /** Letters refused since the operator last registered the desk (all of them while unpaired). */
  refused: readonly ZaicodeSaimailRefusedFacts[];
  checks: readonly ZaicodeSaimailCheck[];
}

/** Refusals worth showing: only what arrived after the operator admitted the desk. */
export function zaicodeSaimailActiveRefusals(
  operator: ZaicodeSaimailWorkspaceFacts,
  desk: ZaicodeSaimailWorkspaceFacts,
): ZaicodeSaimailRefusedFacts[] {
  const admitted = operator.peers.find((peer) => peer.senderKid !== null && peer.senderKid === desk.senderKid);
  const since = admitted?.addedAt ? Date.parse(admitted.addedAt) : Number.NaN;
  if (!Number.isFinite(since)) return [...operator.refused];
  return operator.refused.filter((item) => item.atMs === null || item.atMs > since);
}

/** The desk's registration of the operator that carries a DIFFERENT key: the operator mailbox was recreated. */
export function zaicodeSaimailDeskIsStale(
  operator: ZaicodeSaimailWorkspaceFacts,
  desk: ZaicodeSaimailWorkspaceFacts,
): boolean {
  if (!operator.recipientKid) return false;
  const known = desk.peers.filter((peer) => peer.alias === ZAICODE_SAIMAIL_OPERATOR_ALIAS);
  return known.length > 0 && known.every((peer) => peer.recipientKid !== operator.recipientKid);
}

const reasonsOf = (items: readonly ZaicodeSaimailRefusedFacts[]): string =>
  [...new Set(items.map((item) => item.reason))].join(", ");

export function evaluateZaicodeSaimailPost(facts: ZaicodeSaimailFacts): ZaicodeSaimailPostStatus {
  const { cli, operator, desk } = facts;
  const checks: ZaicodeSaimailCheck[] = [];
  const base = {
    cli,
    operatorPath: operator?.path ?? null,
    operatorSeat: operator?.seat ?? null,
    deskPath: desk.path,
    unread: operator?.unread ?? 0,
  };

  if (!operator) {
    return {
      ...base,
      overall: "off",
      deskReady: desk.exists,
      deskKnowsOperator: false,
      operatorAcceptsDesk: false,
      refused: [],
      checks: [
        {
          id: "operator-mailbox",
          level: "warn",
          title: "Your mailbox",
          detail: "No folder chosen yet. Pick one (or type a path) and create the mailbox.",
          fix: null,
        },
      ],
    };
  }

  checks.push(
    cli.found
      ? {
          id: "cli",
          level: "ok",
          title: "saimail-local",
          detail: cli.version ? `Found (${cli.version}).` : "Found.",
          fix: null,
        }
      : {
          id: "cli",
          level: "fail",
          title: "saimail-local",
          detail: "Not found on PATH. Install SAIMAIL, then restart ZAICODE.",
          fix: "install-cli",
        },
  );

  checks.push(
    operator.exists
      ? {
          id: "operator-mailbox",
          level: "ok",
          title: "Your mailbox",
          detail: `Seat ${operator.seat}, ${operator.unread} unread.`,
          fix: null,
        }
      : {
          id: "operator-mailbox",
          level: "fail",
          title: "Your mailbox",
          detail: "This folder is not a SAIMAIL mailbox yet.",
          fix: cli.found ? "create-operator" : null,
        },
  );

  const stale = operator.exists && desk.exists && zaicodeSaimailDeskIsStale(operator, desk);
  const deskKnowsOperator =
    operator.exists &&
    desk.exists &&
    operator.recipientKid !== null &&
    desk.peers.some((peer) => peer.recipientKid === operator.recipientKid);
  const operatorAcceptsDesk =
    operator.exists &&
    desk.exists &&
    desk.senderKid !== null &&
    operator.peers.some((peer) => peer.senderKid === desk.senderKid);

  if (operator.exists) {
    checks.push(
      desk.exists
        ? {
            id: "desk",
            level: "ok",
            title: "Agent desk",
            detail: `Seat ${desk.seat}. Agents write from here.`,
            fix: null,
          }
        : {
            id: "desk",
            level: "warn",
            title: "Agent desk",
            detail: "Not created yet. Without it no agent has a way to write to you.",
            fix: cli.found ? "pair" : null,
          },
    );
  }

  if (stale) {
    checks.push({
      id: "pairing",
      level: "fail",
      title: "Pairing",
      detail: "The desk knows an older key of your mailbox (the mailbox was recreated). Its letters would be undeliverable.",
      fix: "reset-desk",
    });
  } else if (operator.exists && desk.exists) {
    checks.push(
      deskKnowsOperator && operatorAcceptsDesk
        ? { id: "pairing", level: "ok", title: "Pairing", detail: "Agents can write to you and your mailbox accepts them.", fix: null }
        : {
            id: "pairing",
            level: "fail",
            title: "Pairing",
            detail: !deskKnowsOperator && !operatorAcceptsDesk
              ? "Neither side knows the other: an agent letter cannot leave the desk and would be refused on arrival."
              : !deskKnowsOperator
                ? "The desk does not know you: an agent has no recipient to write to."
                : "Your mailbox does not know the desk: its letters are refused (UNKNOWN_SENDER_KEY).",
            fix: cli.found ? "pair" : null,
          },
    );
  }

  const refused = operator.exists && desk.exists ? zaicodeSaimailActiveRefusals(operator, desk) : [...operator.refused];
  if (operator.exists && refused.length > 0) {
    checks.push({
      id: "refused",
      level: "warn",
      title: "Refused letters",
      detail: `${refused.length} letter(s) arrived but were refused (${reasonsOf(refused)}); the sender is not paired with your mailbox.`,
      fix: desk.exists && cli.found ? "pair" : null,
    });
  }

  const failed = checks.some((check) => check.level === "fail");
  const warned = checks.some((check) => check.level === "warn");
  return {
    ...base,
    overall: failed ? "needs-setup" : warned ? "degraded" : "ready",
    deskReady: desk.exists && deskKnowsOperator && operatorAcceptsDesk && !stale,
    deskKnowsOperator,
    operatorAcceptsDesk,
    refused,
    checks,
  };
}

/** Recipient alias the operator's mailbox uses for the desk (falls back to a key-suffixed alias on a conflict). */
export function zaicodeSaimailDeskAlias(recipientKid: string | null, attempt: 0 | 1): string {
  if (attempt === 0) return ZAICODE_SAIMAIL_DESK_SEAT;
  const tail = (recipientKid ?? "").replace(/^sha256:/, "").slice(0, 8) || "desk";
  return `${ZAICODE_SAIMAIL_DESK_SEAT}-${tail}`;
}
