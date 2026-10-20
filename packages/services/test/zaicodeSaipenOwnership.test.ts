import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  parseBoardDoingTickets,
  querySaipenOwnership,
  createZaicodeSaipenOwnershipQuery,
} from "../src/zaicode/zaicodeSaipenOwnership.js";
import { ZaicodeAuditLoopService } from "../src/zaicode/zaicodeAuditLoopService.js";
import type { IZaicodeAgentService, IZaicodeJobService } from "../src/index.js";

function setupWorkspace(): { dir: string; saipenDir: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "zaicode-ownership-test-"));
  const saipenDir = join(dir, ".saipen");
  return {
    dir,
    saipenDir,
    dispose: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort cleanup */
      }
    },
  };
}

function writeSaipenFiles(
  saipenDir: string,
  options: {
    lastEvent?: number;
    phase?: string;
    task?: string;
    doingTickets?: string[];
  } = {},
): void {
  mkdirSync(saipenDir, { recursive: true });
  const lastEvent = options.lastEvent ?? 100;
  const phase = options.phase ?? "BUILD";
  const task = options.task ?? "none";

  const stateContent = [
    "---",
    `phase: ${phase}`,
    `task: ${task}`,
    `last_event: ${lastEvent}`,
    'saipen_home: "C:/fake/saipen"',
    "---",
  ].join("\n");
  writeFileSync(join(saipenDir, "STATE.md"), stateContent, "utf8");

  const doingContent = (options.doingTickets ?? []).join("\n");
  const boardContent = [
    "# Board",
    "",
    "## DOING",
    doingContent,
    "",
    "## TODO",
    "- [ ] T-200 next task",
    "",
    "## DONE",
    "",
  ].join("\n");
  writeFileSync(join(saipenDir, "BOARD.md"), boardContent, "utf8");
}

test("1. non-SAIPEN workspace preserves existing policy (unowned, authoritative)", async () => {
  const { dir, dispose } = setupWorkspace();
  try {
    const answer = await querySaipenOwnership(dir);
    assert.equal(answer.authoritative, true);
    assert.equal(answer.foreign, false);
    assert.match(answer.detail, /not governed by SAIPEN/i);
  } finally {
    dispose();
  }
});

test("2. governed workspace missing STATE.md or BOARD.md fails closed", async () => {
  const { dir, saipenDir, dispose } = setupWorkspace();
  try {
    mkdirSync(saipenDir, { recursive: true });
    // Neither STATE.md nor BOARD.md exists
    const answer = await querySaipenOwnership(dir);
    assert.equal(answer.authoritative, false);
    assert.equal(answer.foreign, false);
    assert.match(answer.detail, /missing/i);
  } finally {
    dispose();
  }
});

test("3. launcher cannot be resolved fails closed", async () => {
  const { dir, saipenDir, dispose } = setupWorkspace();
  try {
    writeSaipenFiles(saipenDir);
    const answer = await querySaipenOwnership(dir, {
      resolveHome: async () => null,
    });
    assert.equal(answer.authoritative, false);
    assert.equal(answer.foreign, false);
    assert.match(answer.detail, /launcher executable could not be resolved/i);
  } finally {
    dispose();
  }
});

test("4. launcher execution failure fails closed", async () => {
  const { dir, saipenDir, dispose } = setupWorkspace();
  try {
    writeSaipenFiles(saipenDir);
    const answer = await querySaipenOwnership(dir, {
      resolveHome: async () => "C:/fake/saipen",
      runLauncher: async () => {
        throw new Error("process spawn error: EACCES");
      },
    });
    assert.equal(answer.authoritative, false);
    assert.equal(answer.foreign, false);
    assert.match(answer.detail, /status query failed/i);
  } finally {
    dispose();
  }
});

test("5. launcher output containing invalid JSON fails closed", async () => {
  const { dir, saipenDir, dispose } = setupWorkspace();
  try {
    writeSaipenFiles(saipenDir);
    const answer = await querySaipenOwnership(dir, {
      resolveHome: async () => "C:/fake/saipen",
      runLauncher: async () => "Error: crash occurred before JSON output",
    });
    assert.equal(answer.authoritative, false);
    assert.equal(answer.foreign, false);
    assert.match(answer.detail, /contains no valid JSON object/i);
  } finally {
    dispose();
  }
});

test("6. SAIPEN reporting ok: false fails closed", async () => {
  const { dir, saipenDir, dispose } = setupWorkspace();
  try {
    writeSaipenFiles(saipenDir);
    const answer = await querySaipenOwnership(dir, {
      resolveHome: async () => "C:/fake/saipen",
      runLauncher: async () => JSON.stringify({ ok: false, code: "VALIDATION_FAILED", reason: "schema mismatch" }),
    });
    assert.equal(answer.authoritative, false);
    assert.equal(answer.foreign, false);
    assert.match(answer.detail, /ok: false \(VALIDATION_FAILED: schema mismatch\)/i);
  } finally {
    dispose();
  }
});

test("7. SAIPEN reporting recovery_pending fails closed", async () => {
  const { dir, saipenDir, dispose } = setupWorkspace();
  try {
    writeSaipenFiles(saipenDir);
    const answer = await querySaipenOwnership(dir, {
      resolveHome: async () => "C:/fake/saipen",
      runLauncher: async () => JSON.stringify({ ok: true, recovery_pending: true }),
    });
    assert.equal(answer.authoritative, false);
    assert.equal(answer.foreign, false);
    assert.match(answer.detail, /unfinished recovery operation/i);
  } finally {
    dispose();
  }
});

test("8. SAIPEN reporting board_errors fails closed", async () => {
  const { dir, saipenDir, dispose } = setupWorkspace();
  try {
    writeSaipenFiles(saipenDir);
    const answer = await querySaipenOwnership(dir, {
      resolveHome: async () => "C:/fake/saipen",
      runLauncher: async () => JSON.stringify({ ok: true, board_errors: ["T-100 malformed field syntax"] }),
    });
    assert.equal(answer.authoritative, false);
    assert.equal(answer.foreign, false);
    assert.match(answer.detail, /board error\(s\): T-100 malformed field syntax/i);
  } finally {
    dispose();
  }
});

test("9. stale snapshot (concurrent modification of files during query) fails closed", async () => {
  const { dir, saipenDir, dispose } = setupWorkspace();
  try {
    writeSaipenFiles(saipenDir, { lastEvent: 100 });
    const answer = await querySaipenOwnership(dir, {
      resolveHome: async () => "C:/fake/saipen",
      runLauncher: async () => {
        // Deliberately modify STATE.md during query
        writeFileSync(join(saipenDir, "STATE.md"), "--- phase: BUILD\nlast_event: 101 ---\n", "utf8");
        return JSON.stringify({ ok: true, log_tail_event: 100, claimed_ticket: null });
      },
    });
    assert.equal(answer.authoritative, false);
    assert.equal(answer.foreign, false);
    assert.match(answer.detail, /modified concurrently/i);
  } finally {
    dispose();
  }
});

test("10. stale snapshot (log_tail_event does not match STATE.md last_event) fails closed", async () => {
  const { dir, saipenDir, dispose } = setupWorkspace();
  try {
    writeSaipenFiles(saipenDir, { lastEvent: 200 });
    const answer = await querySaipenOwnership(dir, {
      resolveHome: async () => "C:/fake/saipen",
      runLauncher: async () => JSON.stringify({ ok: true, log_tail_event: 190, claimed_ticket: null }),
    });
    assert.equal(answer.authoritative, false);
    assert.equal(answer.foreign, false);
    assert.match(answer.detail, /stale status response/i);
  } finally {
    dispose();
  }
});

test("11. unowned authorized SAIPEN project can proceed (no claimed ticket, empty ## DOING)", async () => {
  const { dir, saipenDir, dispose } = setupWorkspace();
  try {
    writeSaipenFiles(saipenDir, { lastEvent: 50, doingTickets: [] });
    const answer = await querySaipenOwnership(dir, {
      resolveHome: async () => "C:/fake/saipen",
      runLauncher: async () => JSON.stringify({ ok: true, log_tail_event: 50, claimed_ticket: null }),
    });
    assert.equal(answer.authoritative, true);
    assert.equal(answer.foreign, false);
    assert.match(answer.detail, /unowned authorized/i);
  } finally {
    dispose();
  }
});

test("12. foreign owner holding project refuses remediation (T-900 claimed by saihunt)", async () => {
  const { dir, saipenDir, dispose } = setupWorkspace();
  try {
    writeSaipenFiles(saipenDir, {
      lastEvent: 50,
      doingTickets: ["- [/] T-900 bug fix | owner: saihunt | claim_time: 2026-10-10T12:00:00Z"],
    });
    const answer = await querySaipenOwnership(dir, {
      resolveHome: async () => "C:/fake/saipen",
      runLauncher: async () => JSON.stringify({ ok: true, log_tail_event: 50, claimed_ticket: "T-900" }),
    });
    assert.equal(answer.authoritative, true);
    assert.equal(answer.foreign, true);
    assert.match(answer.detail, /T-900 is claimed by owner 'saihunt'/i);
  } finally {
    dispose();
  }
});

test("13. absence of BOARD row for claimed ticket fails closed (does not invent approval)", async () => {
  const { dir, saipenDir, dispose } = setupWorkspace();
  try {
    // Status reports T-900, but BOARD has no tickets in DOING
    writeSaipenFiles(saipenDir, { lastEvent: 50, doingTickets: [] });
    const answer = await querySaipenOwnership(dir, {
      resolveHome: async () => "C:/fake/saipen",
      runLauncher: async () => JSON.stringify({ ok: true, log_tail_event: 50, claimed_ticket: "T-900" }),
    });
    assert.equal(answer.authoritative, false);
    assert.equal(answer.foreign, false);
    assert.match(answer.detail, /absent from BOARD\.md ## DOING/i);
  } finally {
    dispose();
  }
});

test("14. contradiction between status and BOARD fails closed (status null, BOARD has tickets)", async () => {
  const { dir, saipenDir, dispose } = setupWorkspace();
  try {
    writeSaipenFiles(saipenDir, {
      lastEvent: 50,
      doingTickets: ["- [/] T-900 bug fix | owner: saihunt | claim_time: 2026-10-10T12:00:00Z"],
    });
    const answer = await querySaipenOwnership(dir, {
      resolveHome: async () => "C:/fake/saipen",
      runLauncher: async () => JSON.stringify({ ok: true, log_tail_event: 50, claimed_ticket: null }),
    });
    assert.equal(answer.authoritative, false);
    assert.equal(answer.foreign, false);
    assert.match(answer.detail, /contains 1 ticket\(s\) in ## DOING/i);
  } finally {
    dispose();
  }
});

test("15. matching authorized owner allows remediation", async () => {
  const { dir, saipenDir, dispose } = setupWorkspace();
  try {
    writeSaipenFiles(saipenDir, {
      lastEvent: 50,
      doingTickets: ["- [/] T-291 audit loop work | owner: saipen-cli | claim_time: 2026-10-10T12:00:00Z"],
    });
    const answer = await querySaipenOwnership(dir, {
      resolveHome: async () => "C:/fake/saipen",
      authorizedOwner: "saipen-cli",
      runLauncher: async () => JSON.stringify({ ok: true, log_tail_event: 50, claimed_ticket: "T-291" }),
    });
    assert.equal(answer.authoritative, true);
    assert.equal(answer.foreign, false);
    assert.match(answer.detail, /claimed by authorized owner 'saipen-cli'/i);
  } finally {
    dispose();
  }
});

test("16. real launcher batch script execution on Windows", { skip: process.platform !== "win32" }, async () => {
  const base = mkdtempSync(join(tmpdir(), "zaicode-real-launcher-test-"));
  const home = join(base, "home");
  const project = join(base, "project");
  try {
    mkdirSync(join(home, "bin"), { recursive: true });
    // Real .cmd batch file that outputs SAIPEN JSON
    const launcherScript = [
      "@echo off",
      'echo {"ok":true,"log_tail_event":42,"claimed_ticket":null}',
      "",
    ].join("\r\n");
    writeFileSync(join(home, "bin", "saipen.cmd"), launcherScript);

    const saipenDir = join(project, ".saipen");
    writeSaipenFiles(saipenDir, { lastEvent: 42, doingTickets: [] });
    // Write saipen_home to point to our test home
    const stateContent = [
      "---",
      "phase: BUILD",
      "task: none",
      "last_event: 42",
      `saipen_home: "${home.replaceAll("\\", "/")}"`,
      "---",
    ].join("\n");
    writeFileSync(join(saipenDir, "STATE.md"), stateContent, "utf8");

    const answer = await querySaipenOwnership(project);
    assert.equal(answer.authoritative, true);
    assert.equal(answer.foreign, false);
    assert.match(answer.detail, /unowned authorized/i);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("17. parseBoardDoingTickets parses various field layouts and ignores non-DOING sections", () => {
  const sampleBoard = `
# Board

## DOING
- [/] T-100 first task | owner: dev1 | claim_time: 2026-10-10T10:00:00Z | claim_session: sess1
- [/] T-101 second task without fields
- [/] T-102 third task | owner: dev2

## TODO
- [ ] T-103 todo task | owner: someone_else

## DONE
- [x] T-104 done task | owner: dev1
`;
  const tickets = parseBoardDoingTickets(sampleBoard);
  assert.equal(tickets.length, 3);
  assert.equal(tickets[0].id, "T-100");
  assert.equal(tickets[0].owner, "dev1");
  assert.equal(tickets[0].claimTime, "2026-10-10T10:00:00Z");
  assert.equal(tickets[0].claimSession, "sess1");

  assert.equal(tickets[1].id, "T-101");
  assert.equal(tickets[1].owner, null);

  assert.equal(tickets[2].id, "T-102");
  assert.equal(tickets[2].owner, "dev2");
});

test("18. ZaicodeAuditLoopService constructor wiring: production adapter integrates cleanly", async () => {
  const { dir, saipenDir, dispose } = setupWorkspace();
  try {
    writeSaipenFiles(saipenDir, { lastEvent: 10, doingTickets: [] });

    const queryOwnership = createZaicodeSaipenOwnershipQuery({
      resolveHome: async () => "C:/fake/saipen",
      runLauncher: async () => JSON.stringify({ ok: true, log_tail_event: 10, claimed_ticket: null }),
    });

    const fakeJobs = {
      get: async () => null,
      list: async () => ({ jobs: [], total: 0 }),
      create: async () => ({ id: "j1", status: "queued" }),
    } as unknown as IZaicodeJobService;

    const fakeAgents = {
      list: async () => ({ agents: [{ id: "a1", role: "auditor" }, { id: "a2", role: "implementer" }] }),
      get: async (id: string) => ({ id, role: "auditor" }),
      createFromTemplate: async () => ({ id: "a-new", role: "implementer" }),
    } as unknown as IZaicodeAgentService;

    const service = new ZaicodeAuditLoopService({
      jobService: fakeJobs,
      agentService: fakeAgents,
      queryOwnership,
      rootDir: () => join(dir, "loop-root"),
    });

    const answer = await queryOwnership(dir);
    assert.equal(answer.authoritative, true);
    assert.equal(answer.foreign, false);
    assert.ok(service);
  } finally {
    dispose();
  }
});
