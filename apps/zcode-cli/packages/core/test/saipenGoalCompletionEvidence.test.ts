import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  digestEvidenceRecord,
  saipenLogBoundary,
} from "../src/runtime/methods/saipen-goal-evidence.js";
import {
  parseSaipenBoardForGoal,
  saipenGoalVerdict,
  type SaipenGoalProjection,
} from "../src/runtime/methods/saipen-goal-verdict.js";

// SAIHANDOFF F-05 (Q5): the completion verdict must carry a receipt an independent
// reader can recompute, and must report UNVERIFIED -- never complete -- when the
// records behind it are missing. These tests never touch a real SAIPEN install.
delete process.env.SAIPEN_HOME;

const LOG = [
  "- 01.01.26 00:00 [E-40] [T-1] [agent: test] [op: a] RUN: first line",
  "- 01.01.26 00:01 [E-41] [T-2] [agent: test] [op: b] RUN: last line",
  "",
].join("\n");

function workspace(input: { board: string; state?: string; log?: string | null; boardIsDir?: boolean }): string {
  const root = mkdtempSync(join(tmpdir(), "saipen-evidence-"));
  mkdirSync(join(root, ".saipen"));
  if (input.boardIsDir) mkdirSync(join(root, ".saipen", "BOARD.md"));
  else writeFileSync(join(root, ".saipen", "BOARD.md"), input.board);
  writeFileSync(join(root, ".saipen", "STATE.md"), input.state ?? "---\nphase: DONE\nnext_action: \"none\"\n---\n");
  if (input.log !== null) writeFileSync(join(root, ".saipen", "LOG.md"), input.log ?? LOG);
  return root;
}

const CLEAR_BOARD = "## DOING\n\n## TODO\n\n## DONE\n- [x] T-1 shipped | verify: x\n\n## BLOCKED\n";
const STALE_BOARD = "## DOING\n\n## TODO\n- [ ] T-7 [P1] stale line | verify: y\n\n## DONE\n\n## BLOCKED\n";

const PROJECTION = (over: Partial<SaipenGoalProjection> = {}): SaipenGoalProjection => ({
  phase: "DONE",
  claimedTicket: null,
  topWorkableTicket: null,
  closureComplete: true,
  blocker: null,
  ...over,
});

test("a clear board completes with a receipt a reader recomputes from the records", async () => {
  const root = workspace({ board: CLEAR_BOARD });
  const objective = "cc all";
  const verdict = await saipenGoalVerdict({ workspaceRoot: root, objective, goalId: "goal-abc" });
  assert.equal(verdict?.disposition, "complete");
  const receipt = verdict?.evidence;
  assert.ok(receipt, "the completion claim carries a receipt");

  // The reader's own reconstruction: the same bytes, the product's own board reader.
  const boardBytes = readFileSync(join(root, ".saipen", "BOARD.md"), "utf8");
  const logBytes = readFileSync(join(root, ".saipen", "LOG.md"), "utf8");
  const recomputed = parseSaipenBoardForGoal(boardBytes);
  assert.equal(receipt.board.hash, digestEvidenceRecord(boardBytes));
  assert.equal(receipt.board.done, recomputed.done);
  assert.equal(receipt.board.actionable, recomputed.doing.length + recomputed.todo.length);
  assert.deepEqual(receipt.board.blockedIds, recomputed.blocked.map((ticket) => ticket.id));
  assert.deepEqual(receipt.evidenceLocations, [".saipen/BOARD.md", ".saipen/STATE.md", ".saipen/LOG.md"]);

  assert.equal(receipt.ruleVersion, "zcode.saipen-goal-evidence/1");
  assert.equal(receipt.projectIdentity, root);
  assert.equal(receipt.goal.id, "goal-abc");
  assert.equal(receipt.goal.objectiveDigest, digestEvidenceRecord(objective));
  assert.equal(receipt.log.hash, digestEvidenceRecord(logBytes));
  assert.equal(receipt.log.boundary, "E-41");
  assert.equal(saipenLogBoundary(logBytes), receipt.log.boundary);
  assert.equal(receipt.authority, "board_files");
  assert.equal(receipt.projection, null);
  // The receipt names the verdict it belongs to, so it cannot drift from it.
  assert.equal(receipt.disposition, "complete");
  assert.equal(receipt.reason, verdict?.reason);
});

test("a record changed after the decision no longer matches its receipt", async () => {
  const root = workspace({ board: CLEAR_BOARD });
  const verdict = await saipenGoalVerdict({ workspaceRoot: root, objective: "cc all" });
  const decidedBoardHash = verdict?.evidence?.board.hash;
  assert.ok(decidedBoardHash);
  writeFileSync(
    join(root, ".saipen", "BOARD.md"),
    CLEAR_BOARD.replace("## TODO\n", "## TODO\n- [ ] T-9 [P1] added after the verdict\n"),
  );
  const tampered = readFileSync(join(root, ".saipen", "BOARD.md"), "utf8");
  assert.notEqual(decidedBoardHash, digestEvidenceRecord(tampered), "a reader sees the board moved");
  // And the same workspace no longer completes at all.
  const again = await saipenGoalVerdict({ workspaceRoot: root, objective: "cc all" });
  assert.equal(again?.passed, false);
  assert.equal(again?.evidence?.board.actionable, 1);
});

test("a projection-decided completion records SAIPEN as the authority, with the bytes' own counts", async () => {
  const root = workspace({ board: STALE_BOARD });
  const verdict = await saipenGoalVerdict({
    workspaceRoot: root,
    objective: "cc all",
    projection: PROJECTION({ projectIdentity: "v:/proj", protocolVersion: "8.1.0", head: "a3085931" }),
  });
  assert.equal(verdict?.disposition, "complete");
  const receipt = verdict?.evidence;
  assert.ok(receipt);
  assert.equal(receipt.authority, "saipen_projection");
  assert.deepEqual(receipt.projection, {
    phase: "DONE",
    claimedTicket: null,
    topWorkableTicket: null,
    closureComplete: true,
  });
  assert.equal(receipt.protocolVersion, "8.1.0");
  assert.equal(receipt.board.revision, "a3085931");
  assert.equal(receipt.projectIdentity, "v:/proj");
  // The board still lists the stale line; the receipt keeps what the bytes say, so the
  // reader can tell an authoritative projection decision from a board-files one.
  assert.equal(receipt.board.actionable, 1);
  assert.equal(receipt.board.hash, digestEvidenceRecord(readFileSync(join(root, ".saipen", "BOARD.md"), "utf8")));
});

test("a completion claim without the log record is reported unverified, not complete", async () => {
  const root = workspace({ board: CLEAR_BOARD, log: null });
  const verdict = await saipenGoalVerdict({ workspaceRoot: root, objective: "cc all" });
  assert.equal(verdict?.passed, false);
  assert.equal(verdict?.disposition, "invalid_or_unverified");
  assert.equal(verdict?.nextAction, undefined);
  assert.match(verdict?.reason ?? "", /^UNVERIFIED:/);
  assert.equal(verdict?.evidence, undefined, "no records, no receipt");
});

test("a log with no boundary event cannot back a completion", async () => {
  const root = workspace({ board: CLEAR_BOARD, log: "# Log\n\nnothing has happened yet\n" });
  const verdict = await saipenGoalVerdict({ workspaceRoot: root, objective: "cc all" });
  assert.equal(verdict?.disposition, "invalid_or_unverified");
  assert.match(verdict?.reason ?? "", /no boundary event/);
  // The receipt still travels: it says what was read and what was missing.
  assert.equal(verdict?.evidence?.log.boundary, null);
  assert.ok(verdict?.evidence?.board.hash);
});

test("an unreadable board is unverified, not complete", async () => {
  const root = workspace({ board: CLEAR_BOARD, boardIsDir: true });
  const verdict = await saipenGoalVerdict({ workspaceRoot: root, objective: "cc all" });
  assert.equal(verdict?.passed, false);
  assert.equal(verdict?.disposition, "invalid_or_unverified");
  assert.match(verdict?.reason ?? "", /could not be read/);
});

test("a non-continuation objective still falls through to the model verifier", async () => {
  const root = workspace({ board: CLEAR_BOARD });
  assert.equal(await saipenGoalVerdict({ workspaceRoot: root, objective: "rewrite the README" }), null);
});

test("every verdict a record-reading decision returns carries its receipt, bounded", async () => {
  const blocked = Array.from(
    { length: 25 },
    (_, index) => `- [ ] T-${index + 100} [P3] waiting | blocker: needs the operator password ${index}`,
  ).join("\n");
  const root = workspace({ board: `## DOING\n\n## TODO\n\n## DONE\n\n## BLOCKED\n${blocked}\n` });
  const verdict = await saipenGoalVerdict({ workspaceRoot: root, objective: "cc all" });
  assert.equal(verdict?.disposition, "blocked_human");
  const receipt = verdict?.evidence;
  assert.ok(receipt);
  assert.equal(receipt.disposition, "blocked_human");
  // Exact count, truncated list: the receipt is bounded data, not a copy of the board.
  assert.equal(receipt.board.blocked, 25);
  assert.equal(receipt.board.blockedIds.length, 20);
  assert.equal(receipt.board.blockedIds[0], "T-100");
});
