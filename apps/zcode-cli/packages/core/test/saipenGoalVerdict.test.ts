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

// SAIHANDOFF F-05 (Q5): a COMPLETE verdict now cites the memory records it read, so a
// fixture that claims completion needs the LOG.md a real SAIPEN workspace always has.
function workspace(board: string, state: string): string {
  const root = mkdtempSync(join(tmpdir(), "saipen-goal-"));
  mkdirSync(join(root, ".saipen"));
  writeFileSync(join(root, ".saipen", "BOARD.md"), board);
  writeFileSync(join(root, ".saipen", "STATE.md"), state);
  writeFileSync(join(root, ".saipen", "LOG.md"), LOG);
  return root;
}

const LOG = "- 01.01.26 00:00 [E-1] [T-1] [agent: test] [op: fixture] RUN: fixture log\n";

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

// SAIHANDOFF F-01 (Q1): this test used to assert `passed: true` for a board whose only
// remainder was blocked on a human -- exactly the drift the audit found. The host read
// that boolean as "the goal is complete" and closed the goal while the blocker stood.
// The oracle changed with the repair, so the assertion is the repaired contract:
// autonomous exhaustion is not objective completion, and the verdict names why.
test("a human-blocked ticket reports blocked_human instead of completing the goal", async () => {
  const root = workspace(BOARD("", "- [ ] T-9 [P3] needs operator | blocker: x"), STATE("DONE", "WAIT: blocked -- T-9 needs a human."));
  const verdict = await saipenGoalVerdict({ workspaceRoot: root, objective: "cc all" });
  assert.equal(verdict?.passed, false);
  assert.equal(verdict?.disposition, "blocked_human");
  // No next action: the runtime then parks the goal instead of running another turn.
  assert.equal(verdict?.nextAction, undefined);
  assert.match(verdict?.reason ?? "", /T-9/);
  assert.match(verdict?.reason ?? "", /not complete/);
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
  const secretVerdict = await saipenGoalVerdict({ workspaceRoot: secret, objective: "cc all" });
  assert.equal(secretVerdict?.passed, false);
  assert.equal(secretVerdict?.disposition, "blocked_human");
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

test("the loop guard gives up on the same wall after two pushes without claiming completion", async () => {
  resetSaipenGoalVerdictMemory();
  const root = workspace(BOARD("", "- [ ] T-61 [P2] docs | blocker: missing translation"), STATE("DONE", "none"));
  assert.equal((await saipenGoalVerdict({ workspaceRoot: root, objective: "cc all" }))?.passed, false);
  assert.equal((await saipenGoalVerdict({ workspaceRoot: root, objective: "cc all" }))?.passed, false);
  // Giving up is not finishing: the third answer names the disposition and hands back
  // no next action, so the goal is neither continued nor reported complete.
  const third = await saipenGoalVerdict({ workspaceRoot: root, objective: "cc all" });
  assert.equal(third?.passed, false);
  assert.equal(third?.disposition, "blocked_external");
  assert.equal(third?.nextAction, undefined);
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

// ------------------------------------------------- SAIHANDOFF F-01 (Q1) regression
// The audit scenario: a long-finished board with one ticket a human has to unblock.
// Acceptance: it stays resumable (the goal is not closed) and claims no completion.
function auditBoard(blockedTicket: string, doneCount: number): string {
  const NL = String.fromCharCode(10);
  const done = Array.from(
    { length: doneCount },
    (_, index) => `- [x] T-${index + 1} shipped thing ${index + 1} | verify: x`,
  );
  return [
    "## DOING",
    "",
    "## TODO",
    "",
    "## DONE",
    ...done,
    "",
    "## BLOCKED",
    `- [ ] ${blockedTicket}`,
    "",
  ].join(NL);
}

test("the audit scenario: 43 done and one human-blocked ticket is never reported complete", async () => {
  const root = workspace(
    auditBoard("T-1402 [P1] needs operator decision | blocker: the external account-isolation evidence is missing", 43),
    STATE("DONE", "WAIT: blocked -- T-1402 needs operator decision"),
  );
  const verdict = await saipenGoalVerdict({ workspaceRoot: root, objective: "cc all" });
  assert.equal(verdict?.passed, false);
  assert.equal(verdict?.disposition, "blocked_human");
  assert.equal(verdict?.nextAction, undefined);
  assert.match(verdict?.reason ?? "", /T-1402/);
  assert.match(verdict?.reason ?? "", /43 done/);
});

test("a human-only WAIT in STATE is a remaining human dependency too", async () => {
  const root = workspace(BOARD(""), STATE("DONE", "WAIT: blocked -- operator must pick the release boundary"));
  const verdict = await saipenGoalVerdict({ workspaceRoot: root, objective: "cc all" });
  assert.equal(verdict?.passed, false);
  assert.equal(verdict?.disposition, "blocked_human");
  assert.equal(verdict?.nextAction, undefined);
});

test("a genuinely clear board still completes the goal (positive control)", async () => {
  const root = workspace(BOARD(""), STATE("DONE"));
  const verdict = await saipenGoalVerdict({ workspaceRoot: root, objective: "cc all" });
  assert.equal(verdict?.passed, true);
  assert.equal(verdict?.disposition, "complete");
  assert.equal(verdict?.nextAction, "");
});

// ------------------------------------------------------------------- T-309 (SRC-221)
// Mission: stop autonomous goal-continuation loops when SAIPEN is waiting for an
// external operator decision. The incident: `/goal cc all` reached goal iteration 35
// while SAIPEN reported a bounded safety valve -- `continuation_authority:
// operator_required`, `safety_valve_mode: hard_wait`, `next_action: WAIT: ...` -- on
// task T-260. The verifier still answered `continue` / `cc continuing T-260` and the
// runtime sent another synthetic goal-continuation, because it read only the claimed
// and top-workable tickets. The fixture below is that answer's shape and values.
const INCIDENT_STATUS = {
  ok: true,
  protocol_version: "8.1.0",
  phase: "SCOUT",
  task: "T-260",
  next_action: "WAIT: safety valve -- Flush(true) power-loss durability ceiling needs an operator decision",
  blocker: "none",
  execution_intent: "goal",
  claimed_ticket: "T-260",
  top_workable_ticket: "T-283",
  log_tail_event: 4811,
  head: "a308593121453b1d713533fcfd0ec565c10c438e",
  automation: {
    schema_version: 1,
    disposition: "WAIT_USER",
    next_command: null,
    operator_action_due: true,
    reason_code: "wait-safety-valve",
    closure_complete: false,
  },
};

const INCIDENT_BOARD = [
  "## DOING",
  "- [ ] T-260 [P0] flush durability | blocker: Flush(true) power-loss ceiling needs an operator decision",
  "## TODO",
  "- [ ] T-283 [P2] independent documentation ticket",
  "## DONE",
  "- [x] T-1 shipped thing | verify: x",
  "## BLOCKED",
  "- [ ] T-261 [P2] blocked one | blocker: depends on T-260",
  "- [ ] T-262 [P2] blocked two | blocker: depends on T-260",
  "",
].join(String.fromCharCode(10));

const INCIDENT_STATE = [
  "---",
  "phase: SCOUT",
  "task: T-260",
  "execution_intent: goal",
  "last_event: 4811",
  'next_action: "WAIT: safety valve -- Flush(true) power-loss durability ceiling needs an operator decision"',
  "---",
  "",
].join(String.fromCharCode(10));

// The incident's own answer, as bytes: the real parser reads it, not a hand-built object.
const INCIDENT_BYTES = `SAIPEN 8.1.0\n${JSON.stringify(INCIDENT_STATUS, null, 1)}\n`;

test("T-309: the authority block of the incident answer is read as the closed vocabulary", () => {
  const projection = parseSaipenGoalProjection(INCIDENT_BYTES);
  assert.deepEqual(projection?.automation, {
    disposition: "WAIT_USER",
    nextCommand: null,
    operatorActionDue: true,
    reasonCode: "wait-safety-valve",
  });
  // The two tickets the pre-fix reading mistook for authorization are still parsed.
  assert.equal(projection?.claimedTicket, "T-260");
  assert.equal(projection?.topWorkableTicket, "T-283");
});

test("T-309: the incident answer reproduces the loop, and the repair suspends it", async () => {
  resetSaipenGoalVerdictMemory();
  const root = workspace(INCIDENT_BOARD, INCIDENT_STATE);
  const incident = parseSaipenGoalProjection(INCIDENT_BYTES);

  // RED HALF, kept as the fixture's own reproduction: without the authority block --
  // the shape the pre-fix verdict read -- "a ticket is claimed" answers `continue`, and
  // that answer is what the runtime turned into another synthetic `cc` every iteration.
  const { automation: _dropped, ...withoutAuthority } = incident!;
  const preFix = await saipenGoalVerdict({ workspaceRoot: root, objective: "cc all", projection: withoutAuthority });
  assert.equal(preFix?.disposition, "continue");
  assert.match(preFix?.nextAction ?? "", /T-260/);

  // GREEN HALF: the same bytes, read in full, suspend instead of dispatching.
  const verdict = await saipenGoalVerdict({ workspaceRoot: root, objective: "cc all", projection: incident });
  assert.equal(verdict?.passed, false);
  assert.equal(verdict?.disposition, "blocked_human");
  assert.equal(verdict?.nextAction, undefined, "no next action means the loop sends no turn");
  assert.match(verdict?.reason ?? "", /WAIT_USER/);
  assert.match(verdict?.reason ?? "", /wait-safety-valve/);
  assert.match(verdict?.reason ?? "", /T-260/);
  assert.doesNotMatch(verdict?.reason ?? "", /cc — continue/);
});

test("T-309 (A, D, I): repeating the same operator-required wait never produces another action", async () => {
  resetSaipenGoalVerdictMemory();
  const root = workspace(INCIDENT_BOARD, INCIDENT_STATE);
  const incident = parseSaipenGoalProjection(INCIDENT_BYTES);
  const seen = new Set<string>();
  for (let iteration = 1; iteration <= 5; iteration += 1) {
    // The loop's own noise: a synthetic reminder per iteration and self-generated log
    // entries. Neither is progress, and neither may become an action.
    writeFileSync(
      join(root, ".saipen", "LOG.md"),
      `- 01.01.26 00:0${iteration} [E-${4800 + iteration}] [T-260] [agent: test] [op: fixture] RUN: cc continuing T-260\n`,
      { flag: "a" },
    );
    const verdict = await saipenGoalVerdict({ workspaceRoot: root, objective: "cc all", projection: incident });
    assert.equal(verdict?.passed, false);
    assert.equal(verdict?.disposition, "blocked_human");
    assert.equal(verdict?.nextAction, undefined);
    seen.add(verdict?.reason ?? "");
  }
  assert.equal(seen.size, 1, "an unchanged condition yields one identical answer, never a new instruction");
});

test("T-309 (B, E, F): a decision SAIPEN reports as CONTINUE resumes, and COMPLETE still finishes", async () => {
  resetSaipenGoalVerdictMemory();
  const root = workspace(INCIDENT_BOARD, INCIDENT_STATE);
  const incident = parseSaipenGoalProjection(INCIDENT_BYTES);
  const resumed = await saipenGoalVerdict({
    workspaceRoot: root,
    objective: "cc all",
    // The operator answered; SAIPEN reauthorized the run on the same ticket.
    projection: {
      ...incident!,
      automation: { disposition: "CONTINUE", nextCommand: "cc", operatorActionDue: false, reasonCode: "finish" },
    },
  });
  assert.equal(resumed?.disposition, "continue");
  assert.match(resumed?.nextAction ?? "", /T-260/);

  const clear = workspace(BOARD(""), STATE("DONE"));
  const done = await saipenGoalVerdict({
    workspaceRoot: clear,
    objective: "cc all",
    projection: {
      ...PROJECTION(),
      automation: { disposition: "COMPLETE", nextCommand: null, operatorActionDue: false, reasonCode: "closure-complete" },
    },
  });
  assert.equal(done?.disposition, "complete");
  assert.equal(done?.passed, true);
});

test("T-309 (C, G): WAIT_EXTERNAL, BLOCKED and INVALID park for their own reason, and an unknown block is no authority", async () => {
  resetSaipenGoalVerdictMemory();
  const root = workspace(INCIDENT_BOARD, INCIDENT_STATE);
  const incident = parseSaipenGoalProjection(INCIDENT_BYTES);
  const withDisposition = async (disposition: string, operatorActionDue: boolean) =>
    await saipenGoalVerdict({
      workspaceRoot: root,
      objective: "cc all",
      projection: {
        ...incident!,
        automation: { disposition, nextCommand: null, operatorActionDue, reasonCode: "route" } as never,
      },
    });
  const external = await withDisposition("WAIT_EXTERNAL", false);
  assert.equal(external?.disposition, "blocked_external");
  assert.equal(external?.nextAction, undefined);
  const blocked = await withDisposition("BLOCKED", false);
  assert.equal(blocked?.disposition, "blocked_external");
  const blockedOnHuman = await withDisposition("BLOCKED", true);
  assert.equal(blockedOnHuman?.disposition, "blocked_human");
  const invalid = await withDisposition("INVALID", false);
  assert.equal(invalid?.disposition, "invalid_or_unverified");
  assert.equal(invalid?.passed, false);
  assert.equal(invalid?.nextAction, undefined);

  // Fail closed: an authority block ZAICODE cannot read is no authority. An unknown
  // disposition or a foreign schema version is dropped by the parser, and the reading
  // is the pre-existing one -- never an invented suspension, never a completion.
  for (const automation of [
    { schema_version: 1, disposition: "MAYBE", next_command: null, operator_action_due: true },
    { schema_version: 2, disposition: "WAIT_USER", next_command: null, operator_action_due: true },
    { schema_version: 1, disposition: "WAIT_USER", next_command: null },
  ]) {
    const bytes = `banner\n${JSON.stringify({ ...INCIDENT_STATUS, automation })}\n`;
    const projection = parseSaipenGoalProjection(bytes);
    assert.equal(projection?.automation, undefined, JSON.stringify(automation));
    const verdict = await saipenGoalVerdict({ workspaceRoot: root, objective: "cc all", projection });
    assert.equal(verdict?.disposition, "continue");
  }
});

test("T-309 (H): without a projection the board still decides, and a real no-op turn is bounded", async () => {
  resetSaipenGoalVerdictMemory();
  const root = workspace(BOARD("- [ ] T-7 [P1] ship the thing | verify: y"), STATE("BUILD", "PHASE BUILD T-7"));
  // No authority was read, so the workspace's own board work continues -- the fallback
  // the file-only tests above pin.
  const first = await saipenGoalVerdict({ workspaceRoot: root, objective: "cc all", projection: null });
  assert.equal(first?.disposition, "continue");
  assert.match(first?.nextAction ?? "", /T-7/);
  const second = await saipenGoalVerdict({ workspaceRoot: root, objective: "cc all", projection: null });
  assert.equal(second?.disposition, "continue");
  // The third identical reading -- same board, same phase, same action, and no SAIPEN
  // event in between, so nothing at all changed -- is the same attempt repeated. It
  // suspends instead of falling through to a completion claim the board contradicts.
  const third = await saipenGoalVerdict({ workspaceRoot: root, objective: "cc all", projection: null });
  assert.equal(third?.passed, false);
  assert.equal(third?.disposition, "blocked_external");
  assert.equal(third?.nextAction, undefined);
  assert.match(third?.reason ?? "", /not complete/);
});

test("T-309: the incident answer read through the real launcher path suspends too", { skip: process.platform !== "win32" }, async () => {
  resetSaipenGoalVerdictMemory();
  const root = workspace(INCIDENT_BOARD, INCIDENT_STATE);
  const home = mkdtempSync(join(tmpdir(), "saipen-home-"));
  mkdirSync(join(home, "bin"));
  writeFileSync(join(home, "bin", "incident.json"), INCIDENT_BYTES);
  // The command shape `readSaipenGoalProjection` runs; the payload is the incident.
  writeFileSync(join(home, "bin", "saipen.cmd"), '@echo off\r\ntype "%~dp0incident.json"\r\n');
  const previous = process.env.SAIPEN_HOME;
  process.env.SAIPEN_HOME = home;
  try {
    const verdict = await saipenGoalVerdict({ workspaceRoot: root, objective: "cc all" });
    assert.equal(verdict?.disposition, "blocked_human");
    assert.equal(verdict?.nextAction, undefined);
  } finally {
    if (previous === undefined) delete process.env.SAIPEN_HOME;
    else process.env.SAIPEN_HOME = previous;
  }
});
