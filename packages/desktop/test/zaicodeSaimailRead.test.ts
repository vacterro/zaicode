import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  isZaicodeSaimailEnvelopeId,
  parseZaicodeSaimailOpenedLetter,
  parseZaicodeSaimailReadLetterList,
  zaicodeSaimailOpenCommand,
} from "@zcode/shared";
import { listZaicodeSaimailReadLetters, openZaicodeSaimailLetter } from "../src/main/zaicodeSaimailRead.js";
import { pairZaicodeSaimail, runSaimailCli, sendZaicodeSaimailTestLetter, type SaimailCliRunner } from "../src/main/zaicodeSaimailPost.js";

/**
 * Direct operator letter reading (SRC-079), end to end with the real
 * `saimail-local` on scratch mailboxes. The contract under test:
 * listing is metadata-only, a body appears only after the explicit
 * open/reopen the widget triggers, and the canonical CLI stays the only
 * thing that decrypts or moves durable read state.
 */

const installed = (() => {
  try {
    execFileSync("saimail-local", ["--version"], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
})();
const real = { skip: installed ? false : "saimail-local is not installed on this machine" };

function scratch<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "zaicode-saimail-read-"));
  return run(root).finally(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }));
}

/** A paired operator mailbox with one delivered unread letter; returns ids the tests open. */
async function mailboxWithLetter(root: string, topic: string, claim: string) {
  const operatorPath = join(root, "operator");
  const deskPath = join(root, "desk");
  const created = await runSaimailCli(["init", "--workspace", operatorPath, "--seat", "operator", "--json"]);
  assert.equal(created.json?.ok, true, "operator mailbox init");
  const paired = await pairZaicodeSaimail({ operatorPath, deskPath });
  assert.equal(paired.ok, true, paired.message);
  const seat = JSON.parse(readFileSync(join(operatorPath, "saimail-workspace.json"), "utf8")).seat as string;
  const sent = await runSaimailCli([
    "send", "--workspace", deskPath, "--to", "operator",
    "--kind", "PERSONAL_MESSAGE", "--topic", topic, "--claim", claim, "--json",
  ]);
  assert.equal(sent.json?.status, "ACCEPTED");
  const envelopeId = String((sent.json?.message as { envelope_id?: unknown }).envelope_id);
  return { operatorPath, seat, envelopeId };
}

test("pure: unread opens, read reopens; envelope ids are validated, not trusted", () => {
  assert.equal(zaicodeSaimailOpenCommand("UNREAD"), "open");
  assert.equal(zaicodeSaimailOpenCommand("READ"), "reopen");
  assert.equal(isZaicodeSaimailEnvelopeId("sha256:" + "a".repeat(64)), true);
  assert.equal(isZaicodeSaimailEnvelopeId("../../../etc/passwd"), false);
  assert.equal(isZaicodeSaimailEnvelopeId(""), false);
});

test("pure: the read-letter list parser is metadata-only -- a body in the JSON is not surfaced", () => {
  const list = parseZaicodeSaimailReadLetterList({
    ok: true,
    items: [
      {
        envelope_id: "sha256:" + "1".repeat(64),
        from: "zaicode-agent",
        kind: "DISCOVERY",
        topic: "T-115",
        received_at: "2026-09-29T13:33:02Z",
        state: "READ",
      },
    ],
  });
  assert.equal(list.ok, true);
  assert.equal(list.letters.length, 1);
  assert.deepEqual(Object.keys(list.letters[0]!).sort(), ["envelopeId", "from", "kind", "receivedAt", "state", "topic"]);
  const refused = parseZaicodeSaimailReadLetterList({ ok: false, detail: "nope" });
  assert.equal(refused.ok, false);
  assert.equal(refused.message, "nope");
});

test("pure: the opened-letter parser carries the body only when the CLI says ok", () => {
  const ok = parseZaicodeSaimailOpenedLetter({
    ok: true,
    status: "READ",
    detail: "opened explicitly",
    message: { state: "READ" },
    record: { claim: "the letter body" },
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.state, "READ");
  assert.equal(ok.body, "the letter body");
  const refused = parseZaicodeSaimailOpenedLetter({ ok: false, detail: "ENVELOPE_UNKNOWN" });
  assert.equal(refused.ok, false);
  assert.equal(refused.body, null);
  assert.equal(refused.state, null);
  assert.equal(refused.message, "ENVELOPE_UNKNOWN");
});

test("pure: listing never decrypts -- a malformed items array is refused, not guessed", () => {
  assert.equal(parseZaicodeSaimailReadLetterList(null).ok, false);
  assert.equal(parseZaicodeSaimailReadLetterList({ ok: true, items: "nope" }).ok, false);
  assert.equal(parseZaicodeSaimailReadLetterList({ ok: true, items: [{ envelope_id: "junk", from: "x" }] }).letters.length, 0);
});

test("real CLI, mock runner: the widget cannot smuggle a non-canonical command or a bad id", async () => {
  const seen: string[][] = [];
  const run: SaimailCliRunner = async (args) => {
    seen.push([...args]);
    return { missing: false, code: 0, stdout: JSON.stringify({ ok: true, items: [] }), stderr: "", json: { ok: true, items: [] } };
  };
  await listZaicodeSaimailReadLetters({ workspace: "X:\\mb", run });
  assert.deepEqual(seen.at(-1), ["inbox", "--workspace", "X:\\mb", "--state", "READ", "--json"]);

  await openZaicodeSaimailLetter({ workspace: "X:\\mb", envelopeId: "sha256:" + "b".repeat(64), state: "UNREAD", run });
  assert.deepEqual(seen.at(-1)!.slice(0, 2), ["open", "--workspace"]);

  await openZaicodeSaimailLetter({ workspace: "X:\\mb", envelopeId: "sha256:" + "b".repeat(64), state: "READ", run });
  assert.deepEqual(seen.at(-1)!.slice(0, 2), ["reopen", "--workspace"]);

  // A forged envelope id never reaches the CLI at all.
  seen.length = 0;
  const refused = await openZaicodeSaimailLetter({ workspace: "X:\\mb", envelopeId: "../secrets", state: "UNREAD", run });
  assert.equal(refused.ok, false);
  assert.equal(seen.length, 0);
  const noMailbox = await listZaicodeSaimailReadLetters({ workspace: null, run });
  assert.equal(noMailbox.ok, false);
  assert.equal(seen.length, 0);
});

test("real CLI, mock runner: a missing CLI is a readable degraded state, not a crash", async () => {
  const missing: SaimailCliRunner = async () => ({ missing: true, code: null, stdout: "", stderr: "", json: null });
  const list = await listZaicodeSaimailReadLetters({ workspace: "X:\\mb", run: missing });
  assert.equal(list.ok, false);
  assert.match(list.message, /not found on PATH/);
  const opened = await openZaicodeSaimailLetter({ workspace: "X:\\mb", envelopeId: "sha256:" + "c".repeat(64), state: "UNREAD", run: missing });
  assert.equal(opened.ok, false);
  assert.equal(opened.body, null);
  assert.match(opened.message, /not found on PATH/);
});

test("real CLI: explicit Open moves the durable UNREAD -> READ and returns the body", { ...real, skip: !installed && "saimail-local is not installed" } as never, async () => {
  await scratch(async (root) => {
    const claim = "letter body for the reader test";
    const { operatorPath, seat, envelopeId } = await mailboxWithLetter(root, "reader-check", claim);
    assert.equal(readdirSync(join(operatorPath, "mail", "inbox", seat)).length, 1, "the letter starts unread");

    const opened = await openZaicodeSaimailLetter({ workspace: operatorPath, envelopeId, state: "UNREAD" });
    assert.equal(opened.ok, true, opened.message);
    assert.equal(opened.body, claim, "the decrypted body came from the canonical open");
    assert.equal(opened.state, "READ", "the durable state moved, reported by the backend");

    // The canonical transition really happened on disk: inbox empty, read holds the envelope.
    assert.deepEqual(readdirSync(join(operatorPath, "mail", "inbox", seat)), []);
    const readDir = join(operatorPath, "mail", "read", seat, envelopeId.replace("sha256:", ""));
    assert.equal(existsSync(readDir), true, "the envelope moved to mail/read through the CLI's own lifecycle");
  });
});

test("real CLI: Reopen keeps durable READ and returns the body again", { ...real, skip: !installed && "saimail-local is not installed" } as never, async () => {
  await scratch(async (root) => {
    const claim = "reopen reads it again";
    const { operatorPath, envelopeId } = await mailboxWithLetter(root, "reader-reopen", claim);
    const first = await openZaicodeSaimailLetter({ workspace: operatorPath, envelopeId, state: "UNREAD" });
    assert.equal(first.ok, true);

    const listed = await listZaicodeSaimailReadLetters({ workspace: operatorPath });
    assert.equal(listed.ok, true, listed.message);
    assert.equal(listed.letters.filter((letter) => letter.envelopeId === envelopeId).length, 1);
    assert.equal(listed.letters.every((letter) => "claim" in letter === false), true, "the list carries headers only");

    const reopened = await openZaicodeSaimailLetter({ workspace: operatorPath, envelopeId, state: "READ" });
    assert.equal(reopened.ok, true, reopened.message);
    assert.equal(reopened.body, claim);
    assert.equal(reopened.state, "READ", "reopen never flips durable state");
  });
});

test("real CLI: a failed open leaves the letter unread and reports the refusal", { ...real, skip: !installed && "saimail-local is not installed" } as never, async () => {
  await scratch(async (root) => {
    const { operatorPath, seat, envelopeId } = await mailboxWithLetter(root, "reader-fail", "never opened by this test");
    const wrongId = "sha256:" + "0".repeat(64);
    const failed = await openZaicodeSaimailLetter({ workspace: operatorPath, envelopeId: wrongId, state: "UNREAD" });
    assert.equal(failed.ok, false);
    assert.equal(failed.body, null);
    assert.equal(failed.state, null, "no state is claimed when nothing opened");
    // The real unread letter is untouched by the neighbour's failure.
    assert.equal(readdirSync(join(operatorPath, "mail", "inbox", seat)).length, 1);
    const untouched = await openZaicodeSaimailLetter({ workspace: operatorPath, envelopeId, state: "UNREAD" });
    assert.equal(untouched.ok, true);
    assert.equal(untouched.body, "never opened by this test");
  });
});
