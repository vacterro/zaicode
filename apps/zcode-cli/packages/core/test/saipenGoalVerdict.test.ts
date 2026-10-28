import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  isHumanOnlyBlocker,
  isSaipenContinuationObjective,
  parseSaipenGoalProjection,
  resetSaipenGoalVerdictMemory,
  saipenGoalVerdict,
  type SaipenGoalProjection,
} from "../src/runtime/methods/saipen-goal-verdict.js";

// The file-only tests below must not reach a real SAIPEN install on the test machine.
delete process.env.SAIPEN_HOME;

function workspace(board: string, state: string): string {
  const root = mkdtempSync(join(tmpdir(), "saipen-goal-"));
  mkdirSync(join(root, ".saipen"));
  writeFileSync(join(root, ".saipen", "BOARD.md"), board);
  writeFileSync(join(root, ".saipen", "STATE.md"), state);
  return root;
}

const BOARD = (todo: string, blocked = "") =>
  `## DOING\n\n## TODO\n${todo}\n## DONE\n- [x] T-1 done thing | verify: x\n\n## BLOCKED\n${blocked}\n`;
const STATE = (phase: string, next = "none") => `---\nphase: ${phase}\nnext_action: "${next}"\n---\n`;

test("no .saipen means no verdict", async () => {
  const root = mkdtempSync(join(tmpdir(), "saipen-goal-none-"));
  assert.equal(await saipenGoalVerdict({ workspaceRoot: root, objective: "cc all" }), null);
});

test("open TODO ticket keeps the goal running with the next ticket as action", async () => {
  const root = workspace(BOARD("- [ ] T-7 [P1] ship the thing | verify: y"), STATE("DONE"));
  const verdict = await saipenGoalVerdict({ workspaceRoot: root, objective: "anything" });
  assert.equal(verdict?.passed, false);
  assert.match(verdict?.nextAction ?? "", /T-7 ship the thing/);
});

test("only human-blocked tickets complete a continuation goal", async () => {
  const root = workspace(BOARD("", "- [ ] T-9 [P3] needs operator | blocker: x"), STATE("DONE", "WAIT: blocked -- T-9 needs a human."));
  const verdict = await saipenGoalVerdict({ workspaceRoot: root, objective: "cc all" });
  assert.equal(verdict?.passed, true);
  assert.match(verdict?.reason ?? "", /T-9/);
});

test("autonomous blocker (missing files / wiki stubs) keeps goal running to resolve autonomously", async () => {
  const root = workspace(
    BOARD("", "- [ ] T-53 [P2] translate README | blocker: puuduvad README.ee.md ja README.ded.md"),
    STATE("DONE", "none"),
  );
  const verdict = await saipenGoalVerdict({ workspaceRoot: root, objective: "cc all" });
  assert.equal(verdict?.passed, false);
  assert.match(verdict?.reason ?? "", /Decide yourself/);
  assert.match(verdict?.nextAction ?? "", /unblock T-53 and resolve autonomously/);
});

test("busy phase without WAIT is not complete", async () => {
  const root = workspace(BOARD(""), STATE("BUILD", "PHASE BUILD T-3"));
  assert.equal((await saipenGoalVerdict({ workspaceRoot: root, objective: "cc all" }))?.passed, false);
});

test("clear board defers non-continuation objectives to the model verifier", async () => {
  const root = workspace(BOARD(""), STATE("DONE"));
  assert.equal(await saipenGoalVerdict({ workspaceRoot: root, objective: "rewrite the README" }), null);
});

test("continuation objectives", async () => {
  for (const objective of ["cc", "cc all", "сс", "saipen continue", "ccc"]) {
    assert.equal(isSaipenContinuationObjective(objective), true, objective);
  }
  assert.equal(isSaipenContinuationObjective("fix the sidebar"), false);
});

test("a 'user decision' on content is the agent's to make; credentials are not", async () => {
  resetSaipenGoalVerdictMemory();
  const wiki = workspace(
    BOARD("", "- [ ] T-56 [P2] saiwiki pages | blocker: Wiki sisaldab ainult Home.md stubi; vaja kasutaja otsust: 4 lehte või tühi Wiki"),
    STATE("DONE", "WAIT: blocked -- T-56 needs a decision"),
  );
  assert.equal((await saipenGoalVerdict({ workspaceRoot: wiki, objective: "cc all" }))?.passed, false);
  const secret = workspace(
    BOARD("", "- [ ] T-57 [P2] publish | blocker: needs the npm token for the registry"),
    STATE("DONE", "WAIT: blocked -- T-57 npm token"),
  );
  assert.equal((await saipenGoalVerdict({ workspaceRoot: secret, objective: "cc all" }))?.passed, true);
  assert.equal(isHumanOnlyBlocker("vaja kasutaja parooli"), true);
  assert.equal(isHumanOnlyBlocker("нужен пароль от сервера"), true);
  assert.equal(isHumanOnlyBlocker("missing README.ee.md"), false);
});

test("a TODO ticket with a blocker is blocked, and a non-human WAIT is pushed back", async () => {
  resetSaipenGoalVerdictMemory();
  const root = workspace(
    BOARD("- [ ] T-60 [P1] release | blocker: C-001 hash stale, no upstream answer"),
    STATE("DONE", "WAIT: blocked -- no release surface"),
  );
  const verdict = await saipenGoalVerdict({ workspaceRoot: root, objective: "cc all" });
  assert.equal(verdict?.passed, false);
  assert.match(verdict?.nextAction ?? "", /unblock T-60/);
  const waitOnly = workspace(BOARD(""), STATE("DONE", "WAIT: blocked -- choose between two layouts"));
  assert.match((await saipenGoalVerdict({ workspaceRoot: waitOnly, objective: "cc all" }))?.nextAction ?? "", /resolve the WAIT/);
});

test("the loop guard gives up on the same wall after two pushes", async () => {
  resetSaipenGoalVerdictMemory();
  const root = workspace(BOARD("", "- [ ] T-61 [P2] docs | blocker: missing translation"), STATE("DONE", "none"));
  assert.equal((await saipenGoalVerdict({ workspaceRoot: root, objective: "cc all" }))?.passed, false);
  assert.equal((await saipenGoalVerdict({ workspaceRoot: root, objective: "cc all" }))?.passed, false);
  assert.equal((await saipenGoalVerdict({ workspaceRoot: root, objective: "cc all" }))?.passed, true);
});

const PROJECTION = (over: Partial<SaipenGoalProjection> = {}): SaipenGoalProjection => ({
  phase: "DONE",
  claimedTicket: null,
  topWorkableTicket: null,
  closureComplete: true,
  blocker: null,
  ...over,
});

test("SAIPEN's projection decides open work, not the board parse (T-41 read model)", async () => {
  // The board still lists a TODO line, but SAIPEN says everything workable is closed.
  const stale = workspace(BOARD("- [ ] T-7 [P1] stale line | verify: y"), STATE("BUILD", "PHASE BUILD T-7"));
  assert.equal((await saipenGoalVerdict({ workspaceRoot: stale, objective: "cc all", projection: PROJECTION() }))?.passed, true);
  // The board looks clear, but SAIPEN has claimed work: keep going on SAIPEN's ticket.
  const busy = workspace(BOARD(""), STATE("DONE"));
  const verdict = await saipenGoalVerdict({
    workspaceRoot: busy,
    objective: "cc all",
    projection: PROJECTION({ phase: "SCOUT", claimedTicket: "T-41", closureComplete: false }),
  });
  assert.equal(verdict?.passed, false);
  assert.match(verdict?.nextAction ?? "", /T-41/);
  // Without the projection the files still decide.
  assert.equal((await saipenGoalVerdict({ workspaceRoot: stale, objective: "cc all", projection: null }))?.passed, false);
});

test("the projection keeps the autonomy push for engineering blockers", async () => {
  resetSaipenGoalVerdictMemory();
  const root = workspace(BOARD("", "- [ ] T-53 [P2] translate README | blocker: puuduvad README.ee.md"), STATE("DONE"));
  const verdict = await saipenGoalVerdict({ workspaceRoot: root, objective: "cc all", projection: PROJECTION() });
  assert.equal(verdict?.passed, false);
  assert.match(verdict?.nextAction ?? "", /unblock T-53/);
});

test("parseSaipenGoalProjection reads saipen status --json and rejects junk", async () => {
  const output = `banner
${JSON.stringify({
    ok: true,
    phase: "SCOUT",
    claimed_ticket: "T-41",
    top_workable_ticket: "T-45",
    blocker: "none",
    automation: { closure_complete: false },
  })}
`;
  assert.deepEqual(parseSaipenGoalProjection(output), {
    phase: "SCOUT",
    claimedTicket: "T-41",
    topWorkableTicket: "T-45",
    closureComplete: false,
    blocker: null,
  });
  assert.equal(parseSaipenGoalProjection('{"ok":false,"phase":"X"}'), null);
  assert.equal(parseSaipenGoalProjection("not json"), null);
});
