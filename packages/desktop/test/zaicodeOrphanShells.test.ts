import assert from "node:assert/strict";
import test from "node:test";
import {
  ZAICODE_ORPHAN_SHELL_MIN_AGE_MS,
  isZaicodeAgentShell,
  parseZaicodeProcessTable,
  selectZaicodeOrphanAgentShells,
  sweepZaicodeOrphanAgentShells,
  type ZaicodeProcessRow,
} from "../src/main/zaicodeOrphanShells.js";

const BASH = "C:\\Program Files\\Git\\bin\\..\\usr\\bin\\bash.exe";
const agentCommand = (tail: string) =>
  `"${BASH}" -c ". /c/Users/op/.zcode/cli/exec/shell-snapshots/snapshot-bash-1-x.sh 2>/dev/null || true\n. /c/Users/op/.zcode/cli/exec/bash-startup/sess_e8/embedded-search-startup-5d.sh\n${tail}"`;
const at = (iso: string) => Date.parse(iso);

function row(pid: number, parentPid: number, name: string, createdAt: string, commandLine = ""): ZaicodeProcessRow {
  return { pid, parentPid, name, commandLine, createdAtMs: at(createdAt) };
}

// The machine on 2026-09-30: what three agent `node --test` pipelines of 27.09 left behind, next to a live agent.
const live = [
  row(60020, 63208, "ZAICODE.exe", "2026-09-29T19:51:23Z"),
  row(55996, 60020, "ZAICODE.exe", "2026-09-29T19:51:25Z"),
  row(36292, 55996, "ZAICODE.exe", "2026-09-29T19:51:31Z", ""),
  // this app's agent, running a command right now: its owner (36292) lives
  row(70001, 36292, "bash.exe", "2026-09-29T21:00:00Z", agentCommand("pnpm test")),
  row(70002, 70001, "node.exe", "2026-09-29T21:00:01Z"),
  // tree 1: `for i in 1 2 3; do node --test | grep; done`, owner 26508 gone; the forks carry the same command line
  row(38228, 26508, "bash.exe", "2026-09-27T16:19:23Z", agentCommand("for i in 1 2 3; do node --test | grep -E x; done")),
  row(67172, 38228, "bash.exe", "2026-09-27T16:20:27Z", agentCommand("for i in 1 2 3; do node --test | grep -E x; done")),
  row(27548, 38228, "bash.exe", "2026-09-27T16:20:27Z", agentCommand("for i in 1 2 3; do node --test | grep -E x; done")),
  row(33296, 67172, "node.exe", "2026-09-27T16:20:27Z"),
  row(55432, 32424, "ugrep.exe", "2026-09-27T16:20:27Z"),
  row(32424, 27548, "bash.exe", "2026-09-27T16:20:27Z", agentCommand("for i in 1 2 3; do node --test | grep -E x; done")),
  // tree 2: owner 44188 gone
  row(47956, 44188, "bash.exe", "2026-09-27T16:20:38Z", agentCommand("node --test w7.test.js 2>&1 | head -60")),
  row(33208, 47956, "bash.exe", "2026-09-27T16:20:39Z", agentCommand("node --test w7.test.js 2>&1 | head -60")),
  // a terminal the operator opened: a shell, but not an agent's
  row(80001, 99999, "bash.exe", "2026-09-27T10:00:00Z", `"${BASH}" --login -i`),
  // 9router, started by hand long ago and orphaned on purpose: not a shell at all
  row(53112, 32960, "node.exe", "2026-09-27T04:02:12Z"),
];
const NOW = at("2026-09-29T22:00:00Z");

test("O1 an agent shell whose owner is gone is selected; its forks and children ride along with the root", () => {
  const picked = selectZaicodeOrphanAgentShells(live, NOW - ZAICODE_ORPHAN_SHELL_MIN_AGE_MS).map((shell) => shell.pid);
  assert.deepEqual(picked, [38228, 47956]);
});

test("O2 a shell whose owner lives is never selected, however old", () => {
  const picked = selectZaicodeOrphanAgentShells(live, NOW).map((shell) => shell.pid);
  assert.ok(!picked.includes(70001), "this app's running agent command");
  assert.ok(!picked.includes(67172) && !picked.includes(33208), "a fork of an orphan is killed with its root, not listed");
});

test("O3 only agent shells: a terminal's bash and an orphaned non-shell are left alone", () => {
  const picked = selectZaicodeOrphanAgentShells(live, NOW).map((shell) => shell.pid);
  assert.ok(!picked.includes(80001));
  assert.ok(!picked.includes(53112));
  assert.equal(isZaicodeAgentShell({ name: "bash.exe", commandLine: `"${BASH}" --login -i` }), false);
  assert.equal(isZaicodeAgentShell({ name: "node.exe", commandLine: agentCommand("x") }), false, "the image must be a shell");
  assert.equal(isZaicodeAgentShell({ name: "sh.exe", commandLine: agentCommand("x") }), true);
  assert.equal(
    isZaicodeAgentShell({ name: "bash", commandLine: "bash -c '. /home/op/.zcode/cli/exec/bash-startup/s/e.sh\nls'" }),
    true,
  );
});

test("O4 a reused parent PID is not an owner: the process that holds it now is younger than the shell", () => {
  const rows = [
    row(500, 400, "bash.exe", "2026-09-27T10:00:00Z", agentCommand("sleep 999")),
    row(400, 4, "notepad.exe", "2026-09-28T10:00:00Z"),
  ];
  assert.deepEqual(selectZaicodeOrphanAgentShells(rows, NOW).map((shell) => shell.pid), [500]);
  const owned = [row(500, 400, "bash.exe", "2026-09-27T10:00:00Z", agentCommand("sleep 999")), row(400, 4, "ZAICODE.exe", "2026-09-27T09:00:00Z")];
  assert.deepEqual(selectZaicodeOrphanAgentShells(owned, NOW), []);
});

test("O5 a shell born after the cutoff waits: its owner may be killing its own tree right now", () => {
  const rows = [row(600, 1, "bash.exe", "2026-09-29T21:58:00Z", agentCommand("sleep 999"))];
  assert.deepEqual(selectZaicodeOrphanAgentShells(rows, NOW - ZAICODE_ORPHAN_SHELL_MIN_AGE_MS), []);
  assert.deepEqual(selectZaicodeOrphanAgentShells(rows, NOW).map((shell) => shell.pid), [600]);
  const unknownAge = [{ ...rows[0]!, createdAtMs: 0 }];
  assert.deepEqual(selectZaicodeOrphanAgentShells(unknownAge, NOW), [], "no creation time, no verdict");
});

test("O6 the scan's JSON: an array, a single object, missing command lines and junk rows", () => {
  const many = parseZaicodeProcessTable(
    JSON.stringify([
      { p: 1, pp: 0, n: "System", c: "", t: 0 },
      { p: 38228, pp: 26508, n: "bash.exe", c: agentCommand("ls"), t: 1790525963530 },
      { p: "x", pp: 1, n: "bad" },
      { p: 7, pp: 1, n: "node.exe", c: null, t: 5 },
    ]),
  );
  assert.deepEqual(
    many.map((entry) => [entry.pid, entry.parentPid, entry.name, entry.commandLine.length > 0, entry.createdAtMs]),
    [
      [1, 0, "System", false, 0],
      [38228, 26508, "bash.exe", true, 1790525963530],
      [7, 1, "node.exe", false, 5],
    ],
  );
  assert.deepEqual(parseZaicodeProcessTable(JSON.stringify({ p: 9, pp: 1, n: "bash.exe", c: "x", t: 1 })).map((entry) => entry.pid), [9]);
  assert.deepEqual(parseZaicodeProcessTable("  "), []);
});

test("O7 a sweep kills every orphan root, logs each one, keeps the start-up orphans and never throws", async () => {
  const killed: number[] = [];
  const logs: string[] = [];
  const appStartedAtMs = at("2026-09-29T19:51:23Z");
  const result = await sweepZaicodeOrphanAgentShells(appStartedAtMs, {
    scan: async () => live,
    kill: async (pid) => {
      killed.push(pid);
      return pid !== 47956;
    },
    log: (message) => logs.push(message),
    // right after start: only what is older than this app is fair game
    now: () => appStartedAtMs + 20_000,
  });
  assert.deepEqual(killed, [38228, 47956]);
  assert.deepEqual(result.killed, [38228]);
  assert.deepEqual(result.failed, [47956]);
  assert.equal(logs.length, 2);
  assert.match(logs[0]!, /stopped an agent shell left without its owner: pid 38228 \(parent 26508 gone\)/);
  assert.match(logs[1]!, /could not stop/);

  const failing = await sweepZaicodeOrphanAgentShells(appStartedAtMs, {
    scan: async () => {
      throw new Error("powershell missing");
    },
    kill: async () => assert.fail("nothing to kill"),
    log: (message) => logs.push(message),
    now: () => appStartedAtMs,
  });
  assert.deepEqual(failing, { found: [], killed: [], failed: [] });
  assert.match(logs.at(-1)!, /process scan failed: powershell missing/);
});
