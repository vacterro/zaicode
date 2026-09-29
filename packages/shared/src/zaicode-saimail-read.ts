/**
 * The read side of the SAIMAIL operator widget: pure types and parsers for
 * the canonical `saimail-local` letter commands. The CLI owns decryption,
 * durable read state and reopen semantics; this module only shapes its JSON
 * and picks the command, so the widget can never invent a second mail
 * lifecycle.
 *
 * Security shape (SAIHANDOFF SRC-079): listing stays metadata-only; a body
 * exists in the process only after an explicit operator Open/Reopen, and the
 * parsed result carries no disk path because none is written.
 */

export type ZaicodeSaimailLetterState = "UNREAD" | "READ";

export interface ZaicodeSaimailLetterHeader {
  envelopeId: string;
  from: string;
  kind: string;
  topic: string | null;
  receivedAt: string | null;
  state: ZaicodeSaimailLetterState;
}

export interface ZaicodeSaimailReadLetterList {
  ok: boolean;
  letters: ZaicodeSaimailLetterHeader[];
  message: string;
}

export interface ZaicodeSaimailOpenedLetter {
  ok: boolean;
  /** The durable state AFTER the canonical command ran. */
  state: ZaicodeSaimailLetterState | null;
  /** Decrypted body. Present only after an explicit open/reopen succeeded. */
  body: string | null;
  message: string;
}

const ENVELOPE_ID = /^sha256:[0-9a-f]{64}$/;

export function isZaicodeSaimailEnvelopeId(value: unknown): value is string {
  return typeof value === "string" && ENVELOPE_ID.test(value);
}

/** Unread letters open (`open`); already-read letters reopen (`reopen`). */
export function zaicodeSaimailOpenCommand(state: ZaicodeSaimailLetterState): "open" | "reopen" {
  return state === "READ" ? "reopen" : "open";
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** Parses `saimail-local inbox --state READ --json`: headers only, never bodies. */
export function parseZaicodeSaimailReadLetterList(json: Record<string, unknown> | null): ZaicodeSaimailReadLetterList {
  if (!json || json.ok !== true || !Array.isArray(json.items)) {
    return { ok: false, letters: [], message: text(json?.detail) ?? "saimail-local could not list read letters." };
  }
  const letters: ZaicodeSaimailLetterHeader[] = [];
  for (const item of json.items) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const envelopeId = text(record.envelope_id);
    const from = text(record.from);
    if (!isZaicodeSaimailEnvelopeId(envelopeId) || !from) continue;
    const state = record.state === "READ" ? "READ" : "UNREAD";
    letters.push({
      envelopeId,
      from,
      kind: text(record.kind) ?? "PERSONAL_MESSAGE",
      topic: text(record.topic),
      receivedAt: text(record.received_at),
      state,
    });
  }
  return { ok: true, letters, message: "" };
}

/** Parses `saimail-local open|reopen --json`: the only place a body appears. */
export function parseZaicodeSaimailOpenedLetter(json: Record<string, unknown> | null): ZaicodeSaimailOpenedLetter {
  if (!json || json.ok !== true) {
    return {
      ok: false,
      state: null,
      body: null,
      message: text(json?.detail) ?? text(json?.status) ?? "saimail-local refused to open the letter.",
    };
  }
  const message = json.message as Record<string, unknown> | undefined;
  const record = json.record as Record<string, unknown> | undefined;
  const state = message?.state === "READ" || json.status === "READ" ? "READ" : "UNREAD";
  const body = text(record?.claim);
  return {
    ok: true,
    state,
    body,
    message: body === null ? "Opened, but the letter carries no readable body." : text(json.detail) ?? "",
  };
}
