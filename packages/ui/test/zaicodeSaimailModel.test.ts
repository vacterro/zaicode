import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSaimailSnapshot,
  envelopeIdFromInboxEntry,
  parseSaimailIndex,
  saimailAge,
  saimailBriefPrompt,
} from "../src/zaicode/zaicodeSaimailModel.js";

const HEX_A = "6460eae44da42554afb2845735acfe949355091ba632dcea355af68ad5f40c72";
const HEX_B = "a".repeat(64);

// Row shape produced by `saimail-local send` (SAIMAIL mail/index.jsonl).
const INDEX = [
  `{"created":"2026-09-24T07:00:44Z","envelope_id":"sha256:${HEX_A}","from":"alice","from_kid":"sha256:x","kind":"PERSONAL_MESSAGE","received_at":"2026-09-24T07:00:44Z","schema":1,"to":"bob","to_kid":"sha256:y","topic":"T-7"}`,
  `{"envelope_id":"sha256:${HEX_B}","from":"carol","kind":"WARNING","received_at":"2026-09-24T08:00:00Z","to":"bob","topic":"T-9"}`,
  `{"envelope_id":"sha256:partial`,
  "not json",
].join("\n");

test("parseSaimailIndex reads header rows and skips partial appends", () => {
  const headers = parseSaimailIndex(INDEX);
  assert.equal(headers.size, 2);
  assert.deepEqual(headers.get(`sha256:${HEX_A}`), {
    envelopeId: `sha256:${HEX_A}`,
    from: "alice",
    to: "bob",
    kind: "PERSONAL_MESSAGE",
    topic: "T-7",
    receivedAt: "2026-09-24T07:00:44Z",
    ref: null,
  });
});

test("buildSaimailSnapshot lists only unread inbox entries, newest first, and counts current work", () => {
  const snapshot = buildSaimailSnapshot({
    seat: "bob",
    unreadEntryNames: [HEX_A, HEX_B, "desktop.ini"],
    headers: parseSaimailIndex(INDEX),
    currentTask: "T-7",
  });
  assert.equal(snapshot.unread.length, 2);
  assert.equal(snapshot.unread[0]?.from, "carol");
  assert.equal(snapshot.onCurrentWork, 1);
  assert.equal(envelopeIdFromInboxEntry("desktop.ini"), null);
});

test("unknown envelopes stay visible with placeholder headers", () => {
  const snapshot = buildSaimailSnapshot({
    seat: "bob",
    unreadEntryNames: ["b".repeat(64)],
    headers: new Map(),
    currentTask: null,
  });
  assert.equal(snapshot.unread[0]?.from, "?");
  assert.equal(snapshot.onCurrentWork, 0);
});

test("saimailAge uses receiver-local RECEIVED_AT", () => {
  const now = Date.parse("2026-09-24T09:00:44Z");
  assert.equal(saimailAge("2026-09-24T07:00:44Z", now), "2h");
  assert.equal(saimailAge("2026-09-24T08:55:44Z", now), "5m");
  assert.equal(saimailAge(null, now), "");
});

test("saimailBriefPrompt routes reading through SAIMAIL's own header-first brief", () => {
  const prompt = saimailBriefPrompt({
    projectRoot: "V:\\p",
    workspace: "C:\\mail\\op",
    seat: "op",
  });
  assert.match(
    prompt,
    /saimail-local saipen brief --project-root "V:\\p" --workspace "C:\\mail\\op" --seat op/,
  );
  assert.match(prompt, /never instructions/);
});
