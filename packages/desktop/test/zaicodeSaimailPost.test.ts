import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import { ZAICODE_SAIMAIL_DESK_SEAT } from "@zcode/shared";
import {
  absoluteSaimailPath,
  getZaicodeSaimailPostStatus,
  pairZaicodeSaimail,
  readSaimailWorkspaceFacts,
  runSaimailCli,
  sendZaicodeSaimailTestLetter,
  zaicodeLocalStamp,
  type SaimailCliResult,
  type SaimailCliRunner,
} from "../src/main/zaicodeSaimailPost.js";
import { buildSaimailSnapshot, parseSaimailIndex } from "../../ui/src/zaicode/zaicodeSaimailModel.js";

/**
 * SAIMAIL <-> ZAICODE, end to end with the real `saimail-local`.
 *
 * The operator's real mailbox held `"recipients": {}`: nobody was registered
 * anywhere, so an agent letter either never left the sender (RECIPIENT_UNKNOWN)
 * or was QUARANTINED on arrival (UNKNOWN_SENDER_KEY) into a folder the title-bar
 * envelope never read. These tests run the actual CLI on scratch mailboxes and
 * pin the whole chain: the failure, the pairing, the delivered letter, and that
 * ZAICODE's own reader shows it. They skip, loudly, only where SAIMAIL is not
 * installed.
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

const stubResult = (overrides: Partial<SaimailCliResult> = {}): SaimailCliResult => ({
  missing: false,
  code: 0,
  stdout: "",
  stderr: "",
  json: null,
  ...overrides,
});

function scratch<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "zaicode-saimail-"));
  return run(root).finally(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }));
}

async function cli(...args: string[]) {
  const result = await runSaimailCli([...args, "--json"]);
  return result;
}

const unreadNames = (mailbox: string, seat: string) => {
  try {
    return readdirSync(join(mailbox, "mail", "inbox", seat), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
};

test("a folder that is not a mailbox, or a damaged one, reads as not existing, never as a crash", async () => {
  await scratch(async (root) => {
    assert.equal(readSaimailWorkspaceFacts(join(root, "nothing-here")).exists, false);
    mkdirSync(join(root, "damaged"), { recursive: true });
    writeFileSync(join(root, "damaged", "saimail-workspace.json"), "{ not json");
    assert.equal(readSaimailWorkspaceFacts(join(root, "damaged")).exists, false);
    mkdirSync(join(root, "wrong"), { recursive: true });
    writeFileSync(join(root, "wrong", "saimail-workspace.json"), JSON.stringify({ schema: "OTHER", seat: "operator" }));
    assert.equal(readSaimailWorkspaceFacts(join(root, "wrong")).exists, false);
    mkdirSync(join(root, "badseat"), { recursive: true });
    writeFileSync(join(root, "badseat", "saimail-workspace.json"), JSON.stringify({ schema: "SAIMAIL_LOCAL_WORKSPACE_1", seat: "../escape" }));
    assert.equal(readSaimailWorkspaceFacts(join(root, "badseat")).exists, false, "a seat that could climb out of the folder is refused");
  });
});

test("pairing refuses cleanly when there is no mailbox or no CLI, and touches nothing", async () => {
  await scratch(async (root) => {
    const desk = join(root, "desk");
    const missingMailbox = await pairZaicodeSaimail({ operatorPath: join(root, "op"), deskPath: desk, run: async () => stubResult() });
    assert.equal(missingMailbox.ok, false);
    assert.match(missingMailbox.message, /does not exist yet/);

    const op = join(root, "op");
    mkdirSync(op, { recursive: true });
    writeFileSync(
      join(op, "saimail-workspace.json"),
      JSON.stringify({ schema: "SAIMAIL_LOCAL_WORKSPACE_1", seat: "operator", recipient_kid: "sha256:a", sender_kid: "sha256:b" }),
    );
    const noCli: SaimailCliRunner = async () => stubResult({ missing: true, code: 1 });
    const result = await pairZaicodeSaimail({ operatorPath: op, deskPath: desk, run: noCli });
    assert.equal(result.ok, false);
    assert.match(result.message, /not found on PATH/);
    assert.equal(existsSync(desk), false, "no desk is made when the CLI is missing");

    const status = await getZaicodeSaimailPostStatus({ operatorPath: op, deskPath: desk, run: noCli });
    assert.equal(status.cli.found, false);
    assert.equal(status.overall, "needs-setup");
  });
});

test("the reported failure, then the repair: an unpaired agent letter is refused on arrival, pairing makes the next one arrive and ZAICODE's reader shows it", real, async () => {
  await scratch(async (root) => {
    const op = join(root, "Почта оператора");
    const desk = join(root, "app data", "saimail", "agent");
    assert.equal((await cli("init", "--workspace", op, "--seat", "operator")).json?.ok, true);

    // Before: the state of the operator's real mailbox. Nothing is registered.
    let status = await getZaicodeSaimailPostStatus({ operatorPath: op, deskPath: desk });
    assert.equal(status.cli.found, true);
    assert.equal(status.overall, "degraded");
    assert.equal(status.deskReady, false);
    const unpaired = await sendZaicodeSaimailTestLetter({ operatorPath: op, deskPath: desk });
    assert.equal(unpaired.ok, false);
    assert.match(unpaired.message, /Not paired yet/);

    // Half a pairing, the way a hand-made setup usually ends: the sender knows the operator, the operator does not know the sender.
    mkdirSync(join(root, "app data", "saimail"), { recursive: true });
    assert.equal((await cli("init", "--workspace", desk, "--seat", ZAICODE_SAIMAIL_DESK_SEAT)).json?.ok, true);
    await cli("identity", "--workspace", op, "--export-card", join(root, "op.card.json"));
    assert.equal(
      (await cli("recipient", "add", "--workspace", desk, "--alias", "operator", "--card", join(root, "op.card.json"), "--peer-workspace", op)).json?.ok,
      true,
    );
    const refusedSend = await cli("send", "--workspace", desk, "--to", "operator", "--claim", "hello from an unpaired agent");
    assert.equal(refusedSend.json?.status, "QUARANTINED");
    assert.equal((refusedSend.json?.delivery as { reason?: string } | undefined)?.reason, "UNKNOWN_SENDER_KEY");
    assert.deepEqual(unreadNames(op, "operator"), [], "the refused letter never reaches the unread folder");

    status = await getZaicodeSaimailPostStatus({ operatorPath: op, deskPath: desk });
    assert.equal(status.overall, "needs-setup");
    assert.equal(status.deskKnowsOperator, true);
    assert.equal(status.operatorAcceptsDesk, false);
    assert.equal(status.refused.length, 1, "ZAICODE now sees the refusal the envelope never showed");
    assert.match(status.checks.find((check) => check.id === "pairing")!.detail, /UNKNOWN_SENDER_KEY/);

    // Repair.
    const paired = await pairZaicodeSaimail({ operatorPath: op, deskPath: desk });
    assert.equal(paired.ok, true, paired.message);
    status = await getZaicodeSaimailPostStatus({ operatorPath: op, deskPath: desk });
    assert.equal(status.overall, "ready");
    assert.equal(status.deskReady, true);
    assert.equal(status.refused.length, 0, "the refusal predates the admission, so it is history, not a fault");

    const test1 = await sendZaicodeSaimailTestLetter({ operatorPath: op, deskPath: desk });
    assert.equal(test1.ok, true, test1.message);
    const names = unreadNames(op, "operator");
    assert.equal(names.length, 1);

    // ZAICODE's own reader, on the files the real post office wrote.
    const headers = parseSaimailIndex(readFileSync(join(op, "mail", "index.jsonl"), "utf8"));
    const desks = buildSaimailSnapshot({ seat: "operator", unreadEntryNames: names, headers, currentTask: null });
    assert.equal(desks.unread.length, 1);
    assert.equal(desks.unread[0]!.from, ZAICODE_SAIMAIL_DESK_SEAT);
    assert.equal(desks.unread[0]!.topic, "zaicode-check");
    assert.equal(desks.unread[0]!.kind, "PERSONAL_MESSAGE");

    // Pairing again changes nothing.
    const again = await pairZaicodeSaimail({ operatorPath: op, deskPath: desk });
    assert.equal(again.ok, true, again.message);
    assert.equal(readSaimailWorkspaceFacts(op).peers.length, 1);
    assert.equal(readSaimailWorkspaceFacts(desk).peers.length, 1);
  });
});

test("a recreated operator mailbox makes the desk stale: it is moved aside, never deleted, and pairing works again", real, async () => {
  await scratch(async (root) => {
    const op = join(root, "op");
    const desk = join(root, "desk");
    await cli("init", "--workspace", op, "--seat", "operator");
    assert.equal((await pairZaicodeSaimail({ operatorPath: op, deskPath: desk })).ok, true);
    assert.equal((await sendZaicodeSaimailTestLetter({ operatorPath: op, deskPath: desk })).ok, true);

    // The operator deletes and recreates the mailbox: same folder, brand-new keys.
    rmSync(op, { recursive: true, force: true });
    await cli("init", "--workspace", op, "--seat", "operator");
    let status = await getZaicodeSaimailPostStatus({ operatorPath: op, deskPath: desk });
    assert.equal(status.overall, "needs-setup");
    assert.equal(status.checks.find((check) => check.id === "pairing")!.fix, "reset-desk");

    const now = new Date("2026-09-29T12:00:00Z");
    const repaired = await pairZaicodeSaimail({ operatorPath: op, deskPath: desk, now });
    assert.equal(repaired.ok, true, repaired.message);
    assert.ok(existsSync(`${desk}.stale-20260929120000`), "the old desk is kept for the operator, not deleted");
    status = await getZaicodeSaimailPostStatus({ operatorPath: op, deskPath: desk });
    assert.equal(status.overall, "ready");
    assert.equal((await sendZaicodeSaimailTestLetter({ operatorPath: op, deskPath: desk })).ok, true);
  });
});

test("a desk rebuilt under an alias the operator already holds for the old desk still gets its letters accepted", real, async () => {
  await scratch(async (root) => {
    const op = join(root, "op");
    const desk = join(root, "desk");
    await cli("init", "--workspace", op, "--seat", "operator");
    assert.equal((await pairZaicodeSaimail({ operatorPath: op, deskPath: desk })).ok, true);

    // The desk folder is lost (a cleanup, a new machine profile). The operator keeps the old key under the plain alias.
    rmSync(desk, { recursive: true, force: true });
    const rebuilt = await pairZaicodeSaimail({ operatorPath: op, deskPath: desk });
    assert.equal(rebuilt.ok, true, rebuilt.message);
    const aliases = readSaimailWorkspaceFacts(op).peers.map((peer) => peer.alias).sort();
    assert.equal(aliases.length, 2);
    assert.ok(aliases.includes(ZAICODE_SAIMAIL_DESK_SEAT));
    assert.ok(aliases.some((alias) => alias.startsWith(`${ZAICODE_SAIMAIL_DESK_SEAT}-`)), "the new key sits under a key-suffixed alias, the old one is not overwritten");
    const sent = await sendZaicodeSaimailTestLetter({ operatorPath: op, deskPath: desk });
    assert.equal(sent.ok, true, sent.message);
  });
});

test("a folder typed with dots and a trailing slash is one mailbox, spelled once, everywhere the CLI and the registry see it", real, async () => {
  await scratch(async (root) => {
    const op = join(root, "op");
    const desk = join(root, "desk");
    await cli("init", "--workspace", op, "--seat", "operator");
    const typed = `${join(root, "elsewhere", "..", "op")}${sep}`;
    assert.equal(absoluteSaimailPath(typed), op);
    assert.equal(absoluteSaimailPath(`  ${op}  `), op, "surrounding spaces from a text field do not become part of the path");
    const paired = await pairZaicodeSaimail({ operatorPath: typed, deskPath: desk });
    assert.equal(paired.ok, true, paired.message);
    assert.equal(readSaimailWorkspaceFacts(desk).peers[0]!.seat, "operator");
    const peerWorkspace = JSON.parse(readFileSync(join(desk, "peers.json"), "utf8")).recipients.operator.workspace as string;
    assert.equal(peerWorkspace.toLowerCase(), op.toLowerCase(), "the desk stored the absolute mailbox path, not what was typed");
    assert.equal((await sendZaicodeSaimailTestLetter({ operatorPath: typed, deskPath: desk })).ok, true);
  });
});

test("T-133 the test letter names the time on this PC's clock, not a UTC ISO stamp", () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = "Europe/Tallinn";
    assert.equal(zaicodeLocalStamp(new Date("2026-09-29T22:44:24.547Z")), "2026-09-30 01:44:24");
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
