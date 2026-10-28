import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ZAICODE_SAIMAIL_DESK_SEAT,
  ZAICODE_SAIMAIL_OPERATOR_ALIAS,
  evaluateZaicodeSaimailPost,
  zaicodeSaimailActiveRefusals,
  zaicodeSaimailDeskAlias,
  type ZaicodeSaimailFacts,
  type ZaicodeSaimailWorkspaceFacts,
} from "@zcode/shared";

/**
 * SAIMAIL post office verdicts. The fixtures are the shapes the real
 * saimail-local writes (measured in a scratch pair of mailboxes): a workspace
 * file with the seat and both key ids, peers.json with one entry per
 * registered recipient, and mail/quarantine/<id>/reason.json for a refusal.
 */

const OP_RECIPIENT = "sha256:op-recipient";
const OP_SENDER = "sha256:op-sender";
const DESK_RECIPIENT = "sha256:desk-recipient";
const DESK_SENDER = "sha256:desk-sender";

function workspace(overrides: Partial<ZaicodeSaimailWorkspaceFacts> & Pick<ZaicodeSaimailWorkspaceFacts, "path">): ZaicodeSaimailWorkspaceFacts {
  return {
    exists: true,
    seat: null,
    recipientKid: null,
    senderKid: null,
    peers: [],
    unread: 0,
    refused: [],
    ...overrides,
  };
}

const operator = (overrides: Partial<ZaicodeSaimailWorkspaceFacts> = {}) =>
  workspace({ path: "C:/mail/operator", seat: "operator", recipientKid: OP_RECIPIENT, senderKid: OP_SENDER, ...overrides });
const desk = (overrides: Partial<ZaicodeSaimailWorkspaceFacts> = {}) =>
  workspace({ path: "C:/app/saimail/agent", seat: ZAICODE_SAIMAIL_DESK_SEAT, recipientKid: DESK_RECIPIENT, senderKid: DESK_SENDER, ...overrides });

const peerOf = (seat: string, recipientKid: string, senderKid: string, addedAt = "2026-09-29T11:00:00Z") => ({
  alias: seat,
  seat,
  recipientKid,
  senderKid,
  addedAt,
});

const cliOk = { found: true, version: "saimail 0.0.2a3" };

function facts(overrides: Partial<ZaicodeSaimailFacts> = {}): ZaicodeSaimailFacts {
  return { cli: cliOk, operator: operator(), desk: desk({ exists: false }), ...overrides };
}

test("no mailbox chosen: the post office is off and says how to start, without blaming anything", () => {
  const status = evaluateZaicodeSaimailPost(facts({ operator: null }));
  assert.equal(status.overall, "off");
  assert.equal(status.operatorPath, null);
  assert.equal(status.checks.length, 1);
  assert.equal(status.checks[0]!.fix, null);
});

test("today's real state: a mailbox with zero peers cannot receive an agent letter, and the verdict names the repair", () => {
  const status = evaluateZaicodeSaimailPost(facts());
  assert.equal(status.overall, "degraded");
  assert.equal(status.deskReady, false);
  const desks = status.checks.find((check) => check.id === "desk")!;
  assert.equal(desks.level, "warn");
  assert.equal(desks.fix, "pair");
});

test("a desk that exists but nobody registered is a failure with the pair action, whichever side is missing", () => {
  const neither = evaluateZaicodeSaimailPost(facts({ desk: desk() }));
  assert.equal(neither.overall, "needs-setup");
  assert.match(neither.checks.find((check) => check.id === "pairing")!.detail, /Neither side knows the other/);

  const onlyDesk = evaluateZaicodeSaimailPost(
    facts({ desk: desk({ peers: [peerOf("operator", OP_RECIPIENT, OP_SENDER)] }) }),
  );
  assert.equal(onlyDesk.deskKnowsOperator, true);
  assert.equal(onlyDesk.operatorAcceptsDesk, false);
  assert.match(onlyDesk.checks.find((check) => check.id === "pairing")!.detail, /UNKNOWN_SENDER_KEY/);

  const onlyOperator = evaluateZaicodeSaimailPost(
    facts({ operator: operator({ peers: [peerOf(ZAICODE_SAIMAIL_DESK_SEAT, DESK_RECIPIENT, DESK_SENDER)] }), desk: desk() }),
  );
  assert.equal(onlyOperator.deskKnowsOperator, false);
  assert.equal(onlyOperator.operatorAcceptsDesk, true);
  assert.match(onlyOperator.checks.find((check) => check.id === "pairing")!.detail, /does not know you/);
});

test("both directions registered: ready, and the desk is reported usable", () => {
  const status = evaluateZaicodeSaimailPost(
    facts({
      operator: operator({ peers: [peerOf(ZAICODE_SAIMAIL_DESK_SEAT, DESK_RECIPIENT, DESK_SENDER)], unread: 2 }),
      desk: desk({ peers: [peerOf(ZAICODE_SAIMAIL_OPERATOR_ALIAS, OP_RECIPIENT, OP_SENDER)] }),
    }),
  );
  assert.equal(status.overall, "ready");
  assert.equal(status.deskReady, true);
  assert.equal(status.unread, 2);
  assert.ok(status.checks.every((check) => check.level === "ok"));
});

test("a recreated operator mailbox leaves the desk holding an old key: stale, repaired by resetting the desk", () => {
  const status = evaluateZaicodeSaimailPost(
    facts({
      operator: operator({ recipientKid: "sha256:new-op-recipient", peers: [peerOf(ZAICODE_SAIMAIL_DESK_SEAT, DESK_RECIPIENT, DESK_SENDER)] }),
      desk: desk({ peers: [peerOf(ZAICODE_SAIMAIL_OPERATOR_ALIAS, OP_RECIPIENT, OP_SENDER)] }),
    }),
  );
  assert.equal(status.overall, "needs-setup");
  assert.equal(status.deskReady, false);
  const pairing = status.checks.find((check) => check.id === "pairing")!;
  assert.equal(pairing.fix, "reset-desk");
});

test("refused letters are shown only when they arrived after the operator admitted the desk", () => {
  const admitted = peerOf(ZAICODE_SAIMAIL_DESK_SEAT, DESK_RECIPIENT, DESK_SENDER, "2026-09-29T11:00:00Z");
  const before = { id: "old", reason: "UNKNOWN_SENDER_KEY", atMs: Date.parse("2026-09-29T10:00:00Z") };
  const after = { id: "new", reason: "UNKNOWN_SENDER_KEY", atMs: Date.parse("2026-09-29T12:00:00Z") };
  const op = operator({ peers: [admitted], refused: [before, after] });
  const d = desk({ peers: [peerOf(ZAICODE_SAIMAIL_OPERATOR_ALIAS, OP_RECIPIENT, OP_SENDER)] });
  assert.deepEqual(zaicodeSaimailActiveRefusals(op, d).map((item) => item.id), ["new"]);
  const status = evaluateZaicodeSaimailPost(facts({ operator: op, desk: d }));
  assert.equal(status.overall, "degraded");
  assert.match(status.checks.find((check) => check.id === "refused")!.detail, /1 letter\(s\) arrived but were refused \(UNKNOWN_SENDER_KEY\)/);

  const unpaired = operator({ refused: [before, after] });
  assert.deepEqual(zaicodeSaimailActiveRefusals(unpaired, d).map((item) => item.id), ["old", "new"], "before any registration every refusal counts");
});

test("a missing CLI is a failure and never offers an action that would need it", () => {
  const status = evaluateZaicodeSaimailPost(facts({ cli: { found: false, version: null }, desk: desk() }));
  assert.equal(status.overall, "needs-setup");
  assert.equal(status.checks.find((check) => check.id === "cli")!.fix, "install-cli");
  assert.equal(status.checks.find((check) => check.id === "pairing")!.fix, null);
});

test("a folder that is not a mailbox offers to create one", () => {
  const status = evaluateZaicodeSaimailPost(facts({ operator: operator({ exists: false, seat: null, recipientKid: null, senderKid: null }) }));
  assert.equal(status.overall, "needs-setup");
  assert.equal(status.checks.find((check) => check.id === "operator-mailbox")!.fix, "create-operator");
});

test("the desk alias falls back to a key-suffixed one on a conflict and never collides with the plain one", () => {
  assert.equal(zaicodeSaimailDeskAlias("sha256:abcdef0123456789", 0), ZAICODE_SAIMAIL_DESK_SEAT);
  assert.equal(zaicodeSaimailDeskAlias("sha256:abcdef0123456789", 1), `${ZAICODE_SAIMAIL_DESK_SEAT}-abcdef01`);
  assert.equal(zaicodeSaimailDeskAlias(null, 1), `${ZAICODE_SAIMAIL_DESK_SEAT}-desk`);
});
