import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeZaicodeAutostartJobs,
  type ZCodeTaskMeta,
  type ZaicodeLimitSnapshot,
} from "@zcode/shared";
import { attachTaskListRowActivity } from "../src/v4/taskListRowActivity.js";
import { zaicodeSessionStateOf, zaicodeWasCutOff } from "../src/zaicode/zaicodeSessionState.js";
import {
  decideZaicodeProjectStart,
  planZaicodeContinueAll,
  zaicodeDoneUnseen,
  zaicodeSessionBriefOf,
  type ZaicodeSessionBrief,
} from "../src/zaicode/zaicodeContinue.js";
import { planZaicodeCrashResume } from "../src/zaicode/zaicodeCrashResume.js";
import { detectZaicodeWorkerSignals, stripZaicodeAnsi } from "../src/zaicode/zaicodeWorkerWatch.js";
import { zaicodeNextUsefulReset, zaicodeResetRows } from "../src/zaicode/ZaicodeResetTimer.js";
import { zaicodeDockForPoint, zaicodeEffectiveSplit } from "../src/zaicode/zaicodeWorkerLayout.js";
import { normalizeZaicodeWorkerPrefs } from "../src/zaicode/zaicodeWorkerPrefs.js";
import { normalizeZaicodeUiPrefs } from "../src/zaicode/zaicodeUiPrefs.js";
import {
  orderZaicodeScheduleTargets,
  planZaicodeBeforeRun,
  zaicodeCommandForPrompt,
  zaicodeEngineRank,
  zaicodeIsStopgapModel,
  zaicodeProblemScore,
} from "../src/zaicode/zaicodeScheduleRun.js";
import {
  formatZaicodeClearDoneRun,
  planZaicodeClearAllDone,
  runZaicodeClearAllDone,
  splitZaicodeClearDonePlan,
} from "../src/zaicode/ZaicodeClearAllDone.js";
import {
  archiveZaicodeSessions,
  registerZaicodeArchiveSome,
  useZaicodeArchiveUndo,
} from "../src/zaicode/zaicodeArchiveUndo.js";
import {
  ZAICODE_NAV_ITEMS,
  normalizeZaicodeLayoutList,
} from "../src/zaicode/zaicodeLayoutPrefs.js";
import { normalizeZaicodeHeaderTitlePrefs } from "../src/zaicode/ZaicodeHeaderProjectTitle.js";
import {
  zaicodeWorkerFilePrompt,
  zaicodeWorkerPromptNeedsFile,
} from "../src/zaicode/zaicodeEngines.js";
import { normalizeZaicodeAliveWorkers } from "../src/zaicode/zaicodeWorkerRecovery.js";
import { zaicodeAuditProgressFor } from "../src/zaicode/zaicodeAuditStore.js";

function task(patch: Partial<ZCodeTaskMeta> & { taskId: string }): ZCodeTaskMeta {
  return {
    title: patch.taskId,
    workspacePath: "C:/p/a",
    createdAt: 0,
    updatedAt: 1000,
    mode: "build",
    traceId: "t",
    ...patch,
  } as ZCodeTaskMeta;
}

function live(
  meta: ZCodeTaskMeta,
  phase: "running" | "completedSuccess" | "completedInterrupted" | "error",
): ZCodeTaskMeta {
  return attachTaskListRowActivity(meta, { phase, lastActivityAt: 1, hasBackgroundWork: false });
}

function brief(
  patch: Partial<ZaicodeSessionBrief> & { sessionId: string; projectKey: string },
): ZaicodeSessionBrief {
  return {
    title: patch.sessionId,
    workspacePath: `C:/p/${patch.projectKey}`,
    running: false,
    waiting: false,
    failed: false,
    interrupted: false,
    manuallyStopped: false,
    crashCut: false,
    updatedAt: 0,
    model: null,
    unreadAt: null,
    goalStatus: null,
    goalObjective: null,
    ...patch,
  };
}

// --- INTERRUPTED vs DONE (SRC-044) ------------------------------------------------

test("a session the dead process left 'running' is INTERRUPTED, never DONE", () => {
  const crashed = task({ taskId: "c", status: "running", unreadAt: 5 });
  assert.equal(zaicodeWasCutOff(crashed), true);
  assert.equal(zaicodeSessionStateOf(crashed), "interrupted");
  assert.equal(
    zaicodeSessionStateOf(live(task({ taskId: "s", status: "running" }), "completedInterrupted")),
    "interrupted",
    "Stop",
  );
  assert.equal(
    zaicodeSessionStateOf(live(task({ taskId: "r", status: "running" }), "running")),
    "running",
  );
  assert.equal(
    zaicodeSessionStateOf(live(task({ taskId: "d", unreadAt: 3 }), "completedSuccess")),
    "done",
  );
  assert.equal(
    zaicodeSessionStateOf(
      task({
        taskId: "g",
        status: "completed",
        target: { status: "active", objective: "cc all" } as never,
      }),
    ),
    "interrupted",
    "goal still active",
  );
  assert.equal(zaicodeSessionStateOf(task({ taskId: "e", status: "error" })), "failed");
  const facts = zaicodeSessionBriefOf(crashed, "k", { workspacePath: "C:/p/a" });
  assert.equal(facts.interrupted, true);
  assert.equal(facts.crashCut, true, "no live phase + running = the process died");
  const stopped = zaicodeSessionBriefOf(
    live(task({ taskId: "s", status: "completed" }), "completedInterrupted"),
    "k",
    { workspacePath: "C:/p/a" },
  );
  assert.equal(stopped.interrupted, true);
  assert.equal(stopped.crashCut, false, "a Stop is the operator's, never auto-continued");
  const reloaded = zaicodeSessionBriefOf(
    live(task({ taskId: "r", status: "running" }), "completedInterrupted"),
    "k",
    { workspacePath: "C:/p/a" },
  );
  assert.equal(
    reloaded.crashCut,
    true,
    "the CLI reloaded the dead turn as interrupted, tasks-index still says running",
  );
  assert.equal(
    zaicodeSessionStateOf(
      live(task({ taskId: "x", status: "running", unreadAt: 1 }), "completedSuccess"),
    ),
    "interrupted",
  );
});

test("DONE skips interrupted sessions; CONTINUE ALL continues them with cc", () => {
  const sessions = [
    brief({ sessionId: "done", projectKey: "a", unreadAt: 10 }),
    brief({ sessionId: "cut", projectKey: "a", unreadAt: 5, interrupted: true }),
  ];
  assert.deepEqual(
    zaicodeDoneUnseen(sessions).map((session) => session.sessionId),
    ["done"],
  );
  const plan = planZaicodeContinueAll(
    [{ key: "a", name: "a", disabled: false, hasSaipen: true, state: "done", mainSessionId: null }],
    sessions,
  );
  assert.deepEqual(
    plan.steps.map((step) =>
      step.kind === "session"
        ? `${step.sessionId}:${step.command.kind === "text" ? step.command.text : ""}:${step.why}`
        : "",
    ),
    ["cut:cc:cut off mid-turn"],
  );
  assert.equal(plan.steps[0]?.autoEligible, true, "a process cut remains eligible for Auto");
  const stoppedPlan = planZaicodeContinueAll(
    [{ key: "a", name: "a", disabled: false, hasSaipen: true, state: "done", mainSessionId: null }],
    [brief({ sessionId: "stop", projectKey: "a", interrupted: true, manuallyStopped: true })],
  );
  assert.equal(
    stoppedPlan.steps[0]?.autoEligible,
    false,
    "operator Stop remains available manually but Auto excludes it",
  );
});

// --- ▶ START continues instead of piling up sessions (SRC-044) ---------------------

test("project START: MAIN continues in place, a cut-off session becomes MAIN, fresh only with nothing to continue", () => {
  assert.deepEqual(
    decideZaicodeProjectStart("m", [brief({ sessionId: "m", projectKey: "a", running: true })]),
    {
      action: "open",
      sessionId: "m",
      why: "MAIN is already working",
    },
  );
  const cut = decideZaicodeProjectStart("m", [
    brief({
      sessionId: "m",
      projectKey: "a",
      interrupted: true,
      goalStatus: "paused",
      goalObjective: "fix x",
    }),
  ]);
  assert.equal(cut.action, "send");
  assert.deepEqual(
    cut.action === "send" ? cut.command : null,
    { kind: "goal", objective: "fix x" },
    "its own goal again",
  );
  const idle = decideZaicodeProjectStart("m", [brief({ sessionId: "m", projectKey: "a" })]);
  assert.deepEqual(idle.action === "send" ? idle.command : null, {
    kind: "goal",
    objective: "cc all",
  });
  const unknownMain = decideZaicodeProjectStart("gone", []);
  assert.equal(unknownMain.action, "send", "MAIN not loaded: still continued by id");
  const adopt = decideZaicodeProjectStart(null, [
    brief({ sessionId: "new", projectKey: "a" }),
    brief({ sessionId: "old", projectKey: "a", interrupted: true }),
  ]);
  assert.equal(adopt.action === "send" ? `${adopt.sessionId}:${adopt.makeMain}` : "", "old:true");
  assert.equal(
    decideZaicodeProjectStart(null, [brief({ sessionId: "x", projectKey: "a", unreadAt: 1 })])
      .action,
    "fresh",
  );
});

test("project A3 badge sums only active campaign wave progress", () => {
  const campaign = (status: "planned" | "complete", states: string[]) =>
    ({
      workspacePath: "C:/p/a",
      status,
      waves: states.map((waveStatus, index) => ({ waveId: String(index), status: waveStatus })),
    }) as never;
  assert.deepEqual(
    zaicodeAuditProgressFor(
      [
        campaign("planned", ["complete", "pending", "pending"]),
        campaign("complete", ["complete", "complete", "complete"]),
      ],
      "C:/p/a",
    ),
    { complete: 1, total: 3, campaigns: 1 },
  );
  assert.equal(zaicodeAuditProgressFor([campaign("complete", ["complete"])], "C:/p/a"), null);
});

// --- auto-continue after a crash (SRC-044) -----------------------------------------

test("crash auto-continue: only crash-cut, recent, switched-on projects; oldest first; goal or cc", () => {
  const now = 10 * 3_600_000;
  const steps = planZaicodeCrashResume(
    [
      brief({ sessionId: "late", projectKey: "a", crashCut: true, updatedAt: now - 1000 }),
      brief({
        sessionId: "early",
        projectKey: "a",
        crashCut: true,
        updatedAt: now - 5000,
        goalStatus: "active",
        goalObjective: "cc all",
      }),
      brief({
        sessionId: "stale",
        projectKey: "a",
        crashCut: true,
        updatedAt: now - 20 * 3_600_000,
      }),
      brief({ sessionId: "stopped", projectKey: "a", interrupted: true, updatedAt: now }),
      brief({ sessionId: "off", projectKey: "off", crashCut: true, updatedAt: now }),
      brief({ sessionId: "plain", projectKey: "b", crashCut: true, updatedAt: now - 2000 }),
    ],
    (key) =>
      key === "off"
        ? { hasSaipen: true, disabled: true }
        : key === "b"
          ? { hasSaipen: false, disabled: false }
          : null,
    now,
    12,
  );
  assert.deepEqual(
    steps.map(
      (step) =>
        `${step.sessionId}:${step.command.kind === "goal" ? `goal ${step.command.objective}` : step.command.text}`,
    ),
    ["early:goal cc all", "plain:continue", "late:cc"],
  );
});

test("worker recovery list: bad entries dropped, placement kept", () => {
  assert.deepEqual(
    normalizeZaicodeAliveWorkers([
      { accountId: "a", projectPath: "C:/p", prompt: "cc", placement: "window" },
      { accountId: 1 },
      null,
    ]),
    // T-42: an entry from before generations were recorded restarts as generation 1 + 1.
    [{ accountId: "a", projectPath: "C:/p", prompt: "cc", placement: "window", generation: 1 }],
  );
});

// --- worker watch: limit + trust (SRC-046) --------------------------------------------

test("worker watch: the CLI's own limit line counts, prose about limits does not", () => {
  const claude =
    "Ran 1 shell command\n  ⎿ You've hit your session limit · resets 7:40pm (Europe/Tallinn)\n     Continuing automatically at 7:40pm";
  const signal = detectZaicodeWorkerSignals(claude).limit;
  assert.equal(signal?.window, "five_hour");
  assert.equal(signal?.resetText, "7:40pm (Europe/Tallinn)");
  assert.equal(
    detectZaicodeWorkerSignals(
      "■ You've hit your usage limit. Upgrade to Pro or try again in 2 days",
    ).limit?.resetText,
    "2 days",
  );
  assert.equal(
    detectZaicodeWorkerSignals("● Weekly limit reached · resets Mon 9:00").limit?.window,
    "weekly",
  );
  assert.equal(
    detectZaicodeWorkerSignals(
      "• Detector: when a worker says it hit your session limit we close it",
    ).limit,
    null,
    "prose",
  );
  assert.equal(detectZaicodeWorkerSignals("nothing here").limit, null);
});

test("worker watch: first-run trust questions of Claude Code and Codex", () => {
  assert.equal(
    detectZaicodeWorkerSignals("│ Do you trust the files in this folder?\n│ ❯ 1. Yes, proceed")
      .trust,
    true,
  );
  assert.equal(
    detectZaicodeWorkerSignals(
      " Quick safety check: Is this a project you created or one you trust?\n ❯ 1. Yes, I trust this folder\n   2. No, exit",
    ).trust,
    true,
  );
  assert.equal(
    detectZaicodeWorkerSignals(
      "› 1. Yes, allow Codex to work in this folder without asking for approval",
    ).trust,
    true,
  );
  assert.equal(
    detectZaicodeWorkerSignals(
      "The operator said: a worker waits on Trust this folder? for 8 hours",
    ).trust,
    false,
    "prose",
  );
  assert.equal(stripZaicodeAnsi("\u001b[1mYou've\u001b[1Chit\u001b[0m\r\nx"), "You've hit\nx");
});

// --- nearest resets column (SRC-046) ----------------------------------------------------

test("nearest resets: every reset ahead, soonest first, FastPrompter's window names", () => {
  const now = 1_000_000;
  const window = (
    key: string,
    label: string,
    remaining: number | null,
    inMs: number,
    group = "",
  ) => ({
    key,
    label,
    group,
    groupLabel: group,
    remainingPercent: remaining,
    resetsAt: now + inMs,
    durationMinutes: key === "five_hour" ? 300 : 10_080,
    gatedBy: null,
    assumedFull: false,
  });
  const limits: Record<string, ZaicodeLimitSnapshot> = {
    c1: {
      accountId: "c1",
      windows: [window("five_hour", "5h", 40, 600_000), window("weekly", "weekly", 90, 86_400_000)],
      plan: null,
      fetchedAt: now,
      checkedAt: now,
      error: null,
      source: "t",
    },
    ag: {
      accountId: "ag",
      windows: [window("five_hour", "5h", 100, 60_000, "Claude and GPT")],
      plan: null,
      fetchedAt: now,
      checkedAt: now,
      error: null,
      source: "t",
    },
  };
  const rows = zaicodeResetRows(
    [
      { id: "c1", short: "C1", label: "Claude 1", vendor: "claude" },
      { id: "ag", short: "AG", label: "Antigravity", vendor: "antigravity" },
    ],
    limits,
    now,
  );
  assert.deepEqual(
    rows.map((row) => `${row.accountShort}:${row.window}:${row.pool}`),
    ["AG:Session:Claude and GPT", "C1:Session:", "C1:Weekly:"],
  );
  assert.equal(
    zaicodeNextUsefulReset(rows)?.accountShort,
    "C1",
    "a full window is listed but not the timer's pick",
  );
});

// --- WORKERS dock (SRC-046) ---------------------------------------------------------------

test("dock: nearest edge under the pointer; a side column stacks panes", () => {
  const box = { x: 0, y: 0, width: 1000, height: 600 };
  assert.equal(zaicodeDockForPoint(box, 980, 300), "right");
  assert.equal(zaicodeDockForPoint(box, 10, 300), "left");
  assert.equal(zaicodeDockForPoint(box, 500, 590), "bottom");
  assert.equal(zaicodeDockForPoint(box, 500, 5), "top");
  assert.equal(zaicodeEffectiveSplit("row", "right"), "column");
  assert.equal(zaicodeEffectiveSplit("row", "bottom"), "row");
  assert.equal(zaicodeEffectiveSplit("grid", "left"), "grid");
  const prefs = normalizeZaicodeWorkerPrefs({
    panelDock: "right",
    panelWidth: 10,
    onLimit: "closeAndResume",
    autoTrust: false,
  });
  assert.equal(prefs.panelDock, "right");
  assert.equal(prefs.panelWidth, 240, "clamped to the minimum width");
  assert.equal(prefs.onLimit, "closeAndResume");
  assert.equal(prefs.autoTrust, false);
  assert.equal(normalizeZaicodeWorkerPrefs({ panelDock: "diagonal" }).panelDock, "bottom");
  const ui = normalizeZaicodeUiPrefs({});
  assert.equal(ui.resumeAfterCrash, true);
  assert.equal(ui.relaunchWorkersAfterCrash, true);
  assert.equal(normalizeZaicodeUiPrefs({ resumeAfterCrashHours: 9999 }).resumeAfterCrashHours, 168);
});

// --- SCHEDULER: no cap, conditions, order (SRC-044 / SRC-046) -------------------------

test("schedules keep whole audits and carry conditions with safe defaults", () => {
  const audit = "x".repeat(50_000);
  const [job] = normalizeZaicodeAutostartJobs([
    { id: "j", projectPath: "C:/p", engineId: "pool:start", prompt: audit },
  ]);
  assert.equal(job!.prompt.length, 50_000, "the old 2 000-character cut is gone");
  assert.equal(job!.beforeRun, "none");
  assert.equal(job!.onlyWhenIdle, false);
  assert.equal(job!.order, "problems");
  assert.equal(job!.onlyMarked, false);
  const [custom] = normalizeZaicodeAutostartJobs([
    {
      id: "j",
      projectPath: "C:/p",
      engineId: "c1",
      beforeRun: "stopWeaker",
      order: "list",
      onlyMarked: true,
    },
  ]);
  assert.deepEqual(
    [custom!.beforeRun, custom!.order, custom!.onlyMarked],
    ["stopWeaker", "list", true],
  );
  assert.equal(zaicodeWorkerPromptNeedsFile(audit), true);
  assert.equal(zaicodeWorkerPromptNeedsFile("line one\nline two"), true);
  assert.equal(zaicodeWorkerPromptNeedsFile("cc"), false);
  assert.match(zaicodeWorkerFilePrompt("C:/x/p.md"), /Read the file "C:\/x\/p\.md"/);
});

test("section order: most blocked / open first, unknown last, ties keep the sidebar order", () => {
  const targets = ["calm", "burning", "none", "busy"].map((key) => ({
    key,
    path: `C:/${key}`,
    name: key,
  }));
  const rows = {
    calm: { openTickets: 1, blockedTickets: 0 },
    burning: { openTickets: 2, blockedTickets: 3 },
    busy: { openTickets: 11, blockedTickets: 0 },
  };
  assert.deepEqual(
    orderZaicodeScheduleTargets(targets, rows, "problems").map((target) => target.key),
    ["burning", "busy", "calm", "none"],
    "11 = 11: the blocked one first",
  );
  const busier = { ...rows, busy: { openTickets: 12, blockedTickets: 0 } };
  assert.deepEqual(
    orderZaicodeScheduleTargets(targets, busier, "problems").map((target) => target.key),
    ["busy", "burning", "calm", "none"],
  );
  assert.deepEqual(
    orderZaicodeScheduleTargets(targets, rows, "list").map((target) => target.key),
    ["calm", "burning", "none", "busy"],
  );
  assert.equal(zaicodeProblemScore(null), -1);
});

test("before it starts: the stopgap goes (free pool sessions, weaker workers), the real thing stays", () => {
  assert.equal(zaicodeIsStopgapModel("new-provider/SAIFREN"), true);
  assert.equal(zaicodeIsStopgapModel("new-provider/SAIOPP"), false);
  assert.equal(zaicodeIsStopgapModel("kilo-auto/free"), true);
  assert.equal(zaicodeEngineRank("claude") > zaicodeEngineRank("zcode"), true);
  const plan = planZaicodeBeforeRun({
    mode: "stopWeaker",
    runnerRank: zaicodeEngineRank("claude"),
    targets: [{ key: "a", path: "C:/a" }],
    sessions: [
      {
        sessionId: "free",
        title: "free",
        projectKey: "a",
        running: true,
        model: "new-provider/SAIFREN",
      },
      {
        sessionId: "opp",
        title: "opp",
        projectKey: "a",
        running: true,
        model: "new-provider/SAIOPP",
      },
      {
        sessionId: "other",
        title: "other",
        projectKey: "b",
        running: true,
        model: "new-provider/SAIFREN",
      },
    ],
    workers: [
      {
        id: "z",
        kind: "worker",
        vendor: "zcode",
        exitCode: null,
        projectPath: "C:/A",
        short: "ZC",
        projectName: "a",
      },
      {
        id: "c",
        kind: "worker",
        vendor: "claude",
        exitCode: null,
        projectPath: "C:/a",
        short: "C2",
        projectName: "a",
      },
      {
        id: "sh",
        kind: "shell",
        vendor: null,
        exitCode: null,
        projectPath: "C:/a",
        short: "PS",
        projectName: "a",
      },
    ],
  });
  assert.deepEqual(
    plan.sessions.map((session) => session.sessionId),
    ["free"],
  );
  assert.deepEqual(
    plan.workers.map((worker) => worker.id),
    ["z"],
  );
  const all = planZaicodeBeforeRun({
    mode: "stopAll",
    runnerRank: 3,
    targets: [{ key: "a", path: "C:/a" }],
    sessions: [{ sessionId: "opp", title: "opp", projectKey: "a", running: true, model: null }],
    workers: [],
  });
  assert.deepEqual(
    all.sessions.map((session) => session.sessionId),
    ["opp"],
  );
  assert.deepEqual(zaicodeCommandForPrompt(""), { kind: "goal", objective: "cc all" });
  assert.deepEqual(zaicodeCommandForPrompt("/goal cc all"), { kind: "goal", objective: "cc all" });
  assert.deepEqual(zaicodeCommandForPrompt("saiwiki"), { kind: "text", text: "saiwiki" });
});

// --- CLEAR ALL DONE, menu names, title bar (SRC-044) --------------------------------------

test("CLEAR ALL DONE: finished helpers archived, cut-off helpers continued, MAIN / running / waiting untouched", () => {
  const plan = planZaicodeClearAllDone(
    [
      brief({ sessionId: "main", projectKey: "a" }),
      brief({ sessionId: "done", projectKey: "a", unreadAt: 3 }),
      brief({ sessionId: "cut", projectKey: "a", interrupted: true }),
      brief({
        sessionId: "goal",
        projectKey: "a",
        interrupted: true,
        goalStatus: "active",
        goalObjective: "saiwiki",
      }),
      brief({ sessionId: "run", projectKey: "a", running: true }),
      brief({ sessionId: "ask", projectKey: "a", waiting: true }),
    ],
    new Set(["main"]),
    () => true,
  );
  assert.deepEqual(
    plan.archive.map((entry) => entry.sessionId),
    ["done"],
  );
  assert.deepEqual(
    plan.resume.map(
      (entry) =>
        `${entry.sessionId}:${entry.command.kind === "goal" ? entry.command.objective : entry.command.text}`,
    ),
    ["cut:cc", "goal:saiwiki"],
  );
});

test("menu lines keep the operator's names; title bar prefs clamp", () => {
  const list = normalizeZaicodeLayoutList(
    [
      { id: "scheduler", visible: true, label: "  NIGHT SHIFT  " },
      { id: "workers", visible: true, label: "" },
    ],
    ZAICODE_NAV_ITEMS,
  );
  assert.equal(list.find((entry) => entry.id === "scheduler")?.label, "NIGHT SHIFT");
  assert.equal(
    "label" in (list.find((entry) => entry.id === "workers") ?? {}),
    false,
    "empty = the built-in name",
  );
  const title = normalizeZaicodeHeaderTitlePrefs({
    size: 99,
    align: "center",
    color: "project",
    font: "nope",
  });
  assert.equal(title.size, 40);
  assert.equal(title.align, "center");
  assert.equal(title.color, "project");
  assert.equal(title.font, "verdana");
  assert.equal(normalizeZaicodeHeaderTitlePrefs(null).showProject, true);
});

// --- CLEAR ALL DONE: requested vs completed (T-299) -----------------------------------

/**
 * The button's number is what CAN run; the run's report is what DID. Every
 * scenario here fails on the old behaviour, where the counter showed the plan
 * (archive + resume), a missing handler was skipped in silence, a rejected
 * send was swallowed, and the toast reported two aggregates with no failures.
 */
function emptyOutcome(): ZaicodeArchiveOutcome {
  return { archived: [], unregistered: [], failed: [], skipped: [] };
}
function clearDoneSessions(): ZaicodeSessionBrief[] {
  return [
    ...Array.from({ length: 120 }, (_, index) =>
      brief({ sessionId: `done-${index}`, projectKey: "a", unreadAt: index }),
    ),
    ...Array.from({ length: 42 }, (_, index) =>
      brief({ sessionId: `cut-${index}`, projectKey: "b", interrupted: true }),
    ),
    brief({ sessionId: "main", projectKey: "a" }),
    brief({ sessionId: "run", projectKey: "a", running: true }),
    brief({ sessionId: "ask", projectKey: "a", waiting: true }),
  ];
}
function makePlan(sessions: ZaicodeSessionBrief[]): ZaicodeClearDonePlan {
  return planZaicodeClearAllDone(sessions, new Set(["main"]), () => true);
}
function outcomeOf(plan: ZaicodeClearDonePlan): ZaicodeArchiveOutcome {
  return {
    ...emptyOutcome(),
    archived: plan.archive.map((entry) => ({ projectKey: entry.projectKey, sessionId: entry.sessionId })),
  };
}

test("CLEAR ALL DONE A: 162 eligible sessions, every operation successful -- requested and completed are reported apart", async () => {
  const sessions = clearDoneSessions();
  const plan = makePlan(sessions);
  assert.equal(plan.archive.length, 120);
  assert.equal(plan.resume.length, 42);
  let sends = 0;
  const result = await runZaicodeClearAllDone({
    plan,
    archive: async () => outcomeOf(plan),
    send: async () => {
      sends += 1;
    },
    remaining: () => ({ archive: [], resume: [] }),
  });
  assert.equal(sends, 42, "one continuation per cut-off session");
  assert.equal(result.requestedArchive, 120);
  assert.equal(result.requestedResume, 42);
  assert.equal(result.archived, 120);
  assert.equal(result.accepted, 42);
  assert.equal(result.skipped, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.remainingArchive + result.remainingResume, 0);
  const summary = formatZaicodeClearDoneRun(result);
  assert.match(summary, /Archived: 120/);
  assert.match(summary, /Continuation accepted: 42/);
  assert.match(summary, /Skipped: 0/);
  assert.match(summary, /Failed: 0/);
  assert.match(summary, /Nothing left to clear/);
});

test("CLEAR ALL DONE B: a partially successful archive is split into archived / failed / skipped", async () => {
  const plan = makePlan([
    brief({ sessionId: "d1", projectKey: "a", unreadAt: 1 }),
    brief({ sessionId: "d2", projectKey: "a", unreadAt: 2 }),
    brief({ sessionId: "d3", projectKey: "a", unreadAt: 3 }),
    brief({ sessionId: "d4", projectKey: "b", unreadAt: 4 }),
    brief({ sessionId: "c1", projectKey: "a", interrupted: true }),
  ]);
  const result = await runZaicodeClearAllDone({
    plan,
    archive: async () => ({
      ...emptyOutcome(),
      archived: [
        { projectKey: "a", sessionId: "d1" },
        { projectKey: "a", sessionId: "d2" },
        { projectKey: "b", sessionId: "d4" },
      ],
      failed: [{ projectKey: "a", sessionIds: ["d3"], reason: "session-store write failed" }],
    }),
    send: async () => {
      throw new Error("host refused");
    },
    remaining: () => ({ archive: [], resume: [] }),
  });
  assert.equal(result.archived, 3);
  assert.equal(result.failed, 2, "the failed archive and the rejected send are both counted as failed");
  assert.ok(result.problems.some((line) => line.includes("d3") && line.includes("session-store write failed")));
  assert.ok(result.problems.some((line) => line.includes("c1") && line.includes("host refused")));
});

test("CLEAR ALL DONE C: a project with no archive handler is never counted and never silently dropped", async () => {
  const whole = makePlan([
    brief({ sessionId: "d1", projectKey: "a", unreadAt: 1 }),
    brief({ sessionId: "d2", projectKey: "collapse", unreadAt: 2 }),
  ]);
  const split = splitZaicodeClearDonePlan(
    whole,
    (key) => key === "a",
    () => true,
  );
  assert.deepEqual(
    split.runnable.archive.map((entry) => entry.sessionId),
    ["d1"],
  );
  assert.deepEqual(
    split.blocked.archive.map((entry) => entry.sessionId),
    ["d2"],
  );
  assert.ok(split.why.some((line) => line.includes("d2") && /no connection right now/.test(line)));
  const result = await runZaicodeClearAllDone({
    plan: split.runnable,
    archive: async () => outcomeOf(split.runnable),
    send: async () => undefined,
    remaining: () => ({ archive: [], resume: [] }),
  });
  assert.equal(result.failed, 0);
  assert.equal(result.archived, 1, "the unmounted project's session was not requested as done");
});

test("CLEAR ALL DONE D: a continuation whose project handle is gone fails loudly instead of being skipped", async () => {
  const whole = makePlan([
    brief({ sessionId: "c1", projectKey: "a", interrupted: true }),
    brief({ sessionId: "c2", projectKey: "b", interrupted: true }),
  ]);
  const split = splitZaicodeClearDonePlan(
    whole,
    () => true,
    (key) => key === "a",
  );
  assert.deepEqual(
    split.runnable.resume.map((entry) => entry.sessionId),
    ["c1"],
  );
  assert.deepEqual(
    split.blocked.resume.map((entry) => entry.sessionId),
    ["c2"],
  );
  let sent = 0;
  const result = await runZaicodeClearAllDone({
    plan: whole,
    archive: async () => emptyOutcome(),
    send: async (entry) => {
      if (entry.projectKey === "b") throw new Error("its project row disconnected before the send");
      sent += 1;
    },
    remaining: () => ({ archive: [], resume: [] }),
  });
  assert.equal(sent, 1);
  assert.equal(result.accepted, 1);
  assert.equal(result.failed, 1);
  assert.ok(result.problems.some((line) => line.includes("c2") && line.includes("disconnected")));
});

test("CLEAR ALL DONE E: a rejected continuation is a failure, and those sessions stay actionable", async () => {
  const plan = makePlan([
    brief({ sessionId: "c1", projectKey: "a", interrupted: true }),
    brief({ sessionId: "c2", projectKey: "a", interrupted: true }),
    brief({ sessionId: "c3", projectKey: "a", interrupted: true }),
  ]);
  const sends: string[] = [];
  const result = await runZaicodeClearAllDone({
    plan,
    archive: async () => emptyOutcome(),
    send: async (entry) => {
      sends.push(entry.sessionId);
      if (entry.sessionId !== "c1") throw new Error("quota exhausted");
    },
    remaining: () =>
      planZaicodeClearAllDone(
        [
          brief({ sessionId: "c2", projectKey: "a", interrupted: true }),
          brief({ sessionId: "c3", projectKey: "a", interrupted: true }),
        ],
        new Set<string>(),
        () => true,
      ),
  });
  assert.deepEqual(sends, ["c1", "c2", "c3"]);
  assert.equal(result.accepted, 1);
  assert.equal(result.failed, 2);
  assert.equal(result.remainingResume, 2, "the two rejections stay on the counter");
  const summary = formatZaicodeClearDoneRun(result);
  assert.match(summary, /Continuation accepted: 1/);
  assert.match(summary, /Failed: 2/);
  assert.match(summary, /Still actionable: 2/);
});

test("CLEAR ALL DONE F: collapsed or unmounted project rows are not advertised as executable work", () => {
  const whole = makePlan([
    brief({ sessionId: "d1", projectKey: "a", unreadAt: 1 }),
    brief({ sessionId: "c1", projectKey: "a", interrupted: true }),
    brief({ sessionId: "d2", projectKey: "collapsed", unreadAt: 2 }),
    brief({ sessionId: "c2", projectKey: "collapsed", interrupted: true }),
  ]);
  const split = splitZaicodeClearDonePlan(
    whole,
    (key) => key === "a",
    (key) => key === "a",
  );
  assert.equal(split.runnable.archive.length + split.runnable.resume.length, 2, "only the mounted row counts");
  assert.equal(split.blocked.archive.length + split.blocked.resume.length, 2);
  assert.ok(split.why.some((line) => line.includes("d2")));
  assert.ok(split.why.some((line) => line.includes("c2")));
});

test("CLEAR ALL DONE G: the counter follows the reconciled session list, never an assumed zero", async () => {
  const plan = makePlan([brief({ sessionId: "d1", projectKey: "a", unreadAt: 1 })]);
  const stale = await runZaicodeClearAllDone({
    plan,
    archive: async () => outcomeOf(plan),
    send: async () => undefined,
    remaining: () => makePlan([brief({ sessionId: "d1", projectKey: "a", unreadAt: 1 })]),
  });
  assert.equal(stale.archived, 1);
  assert.equal(stale.remainingArchive, 1, "a stale index keeps the session visible");
  assert.match(formatZaicodeClearDoneRun(stale), /Still actionable: 1/);
  const fresh = await runZaicodeClearAllDone({
    plan,
    archive: async () => outcomeOf(plan),
    send: async () => undefined,
    remaining: () => ({ archive: [], resume: [] }),
  });
  assert.equal(fresh.remainingArchive + fresh.remainingResume, 0);
  assert.match(formatZaicodeClearDoneRun(fresh), /Nothing left to clear/);
});

test("CLEAR ALL DONE H: several projects with mixed results are reported per project", async () => {
  const sessions = [
    brief({ sessionId: "a1", projectKey: "a", unreadAt: 1 }),
    brief({ sessionId: "a2", projectKey: "a", unreadAt: 2 }),
    brief({ sessionId: "a3", projectKey: "a", unreadAt: 3 }),
    brief({ sessionId: "b1", projectKey: "b", unreadAt: 4 }),
    brief({ sessionId: "b2", projectKey: "b", unreadAt: 5 }),
    brief({ sessionId: "ac", projectKey: "a", interrupted: true }),
    brief({ sessionId: "bc", projectKey: "b", interrupted: true }),
  ];
  const plan = makePlan(sessions);
  const result = await runZaicodeClearAllDone({
    plan,
    archive: async (byProject) => {
      assert.equal(byProject.get("a")?.length, 3, "one project entry per project, each session once");
      assert.equal(byProject.get("b")?.length, 2);
      return {
        ...emptyOutcome(),
        archived: [
          { projectKey: "a", sessionId: "a1" },
          { projectKey: "a", sessionId: "a2" },
          { projectKey: "b", sessionId: "b1" },
          { projectKey: "b", sessionId: "b2" },
        ],
        failed: [{ projectKey: "a", sessionIds: ["a3"], reason: "read-only workspace" }],
      };
    },
    send: async (entry) => {
      if (entry.projectKey === "b") throw new Error("remote host unreachable");
    },
    remaining: () => makePlan(sessions),
  });
  assert.equal(result.archived, 4);
  assert.equal(result.accepted, 1);
  assert.equal(result.failed, 2);
  assert.equal(result.remainingArchive + result.remainingResume, 7, "nothing was claimed as done");
  assert.ok(result.problems.some((line) => line.includes("a3") && line.includes("read-only")));
  assert.ok(result.problems.some((line) => line.includes("bc") && line.includes("remote host unreachable")));
});

test("CLEAR ALL DONE I + L: one run dispatches each continuation once, and the commands keep their identity", async () => {
  const plan = makePlan([
    brief({ sessionId: "c1", projectKey: "a", interrupted: true }),
    brief({ sessionId: "c2", projectKey: "a", interrupted: true, goalStatus: "active", goalObjective: "saiwiki" }),
  ]);
  const dispatched: { sessionId: string; command: ZaicodeClearDonePlan["resume"][number]["command"] }[] = [];
  const result = await runZaicodeClearAllDone({
    plan,
    archive: async () => emptyOutcome(),
    send: async (entry) => {
      dispatched.push({ sessionId: entry.sessionId, command: entry.command });
    },
    remaining: () => ({ archive: [], resume: [] }),
  });
  assert.equal(dispatched.length, 2, "each cut-off session gets exactly one continuation");
  assert.deepEqual(
    dispatched.map((entry) =>
      `${entry.sessionId}:${entry.command.kind === "goal" ? `goal ${entry.command.objective}` : entry.command.text}`,
    ),
    ["c1:cc", "c2:goal saiwiki"],
    "the original command identity is preserved",
  );
  assert.equal(result.accepted, 2);
});

test("CLEAR ALL DONE J: the archive batch is restorable with one Ctrl+Z after a clear", async () => {
  let restored = 0;
  const unregister = registerZaicodeArchiveSome("proj-j", async (taskIds) => ({
    count: taskIds.length,
    label: `${taskIds.length} finished sessions`,
    archivedIds: [...taskIds],
    restore: async () => {
      restored += taskIds.length;
    },
  }));
  try {
    const outcome = await archiveZaicodeSessions(new Map([["proj-j", ["j1", "j2"]]]));
    assert.equal(outcome.archived.length, 2);
    assert.equal(outcome.failed.length, 0);
    const undo = useZaicodeArchiveUndo.getState();
    assert.equal(undo.entries.length, 1, "one batch, one undo entry");
    const ok = await useZaicodeArchiveUndo.getState().undo();
    assert.equal(ok, true);
    assert.equal(restored, 2, "Ctrl+Z brings both sessions back");
    assert.equal(useZaicodeArchiveUndo.getState().entries.length, 0);
  } finally {
    unregister();
  }
});

test("CLEAR ALL DONE K: MAIN, running and waiting sessions are never planned as work", () => {
  const plan = makePlan(clearDoneSessions());
  const planned = [
    ...plan.archive.map((entry) => entry.sessionId),
    ...plan.resume.map((entry) => entry.sessionId),
  ];
  assert.ok(!planned.includes("main"));
  assert.ok(!planned.includes("run"));
  assert.ok(!planned.includes("ask"));
  assert.equal(planned.length, 162, "everything else is accounted for");
});
