import assert from "node:assert/strict";
import test from "node:test";
import { normalizeZaicodeAutostartJobs, type ZCodeTaskMeta, type ZaicodeLimitSnapshot } from "@zcode/shared";
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
import { planZaicodeClearAllDone } from "../src/zaicode/ZaicodeClearAllDone.js";
import { ZAICODE_NAV_ITEMS, normalizeZaicodeLayoutList } from "../src/zaicode/zaicodeLayoutPrefs.js";
import { normalizeZaicodeHeaderTitlePrefs } from "../src/zaicode/ZaicodeHeaderProjectTitle.js";
import { zaicodeWorkerFilePrompt, zaicodeWorkerPromptNeedsFile } from "../src/zaicode/zaicodeEngines.js";
import { normalizeZaicodeAliveWorkers } from "../src/zaicode/zaicodeWorkerRecovery.js";

function task(patch: Partial<ZCodeTaskMeta> & { taskId: string }): ZCodeTaskMeta {
  return { title: patch.taskId, workspacePath: "C:/p/a", createdAt: 0, updatedAt: 1000, mode: "build", traceId: "t", ...patch } as ZCodeTaskMeta;
}

function live(meta: ZCodeTaskMeta, phase: "running" | "completedSuccess" | "completedInterrupted" | "error"): ZCodeTaskMeta {
  return attachTaskListRowActivity(meta, { phase, lastActivityAt: 1, hasBackgroundWork: false });
}

function brief(patch: Partial<ZaicodeSessionBrief> & { sessionId: string; projectKey: string }): ZaicodeSessionBrief {
  return {
    title: patch.sessionId,
    workspacePath: `C:/p/${patch.projectKey}`,
    running: false,
    waiting: false,
    failed: false,
    interrupted: false,
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
  assert.equal(zaicodeSessionStateOf(live(task({ taskId: "s", status: "running" }), "completedInterrupted")), "interrupted", "Stop");
  assert.equal(zaicodeSessionStateOf(live(task({ taskId: "r", status: "running" }), "running")), "running");
  assert.equal(zaicodeSessionStateOf(live(task({ taskId: "d", unreadAt: 3 }), "completedSuccess")), "done");
  assert.equal(zaicodeSessionStateOf(task({ taskId: "g", status: "completed", target: { status: "active", objective: "cc all" } as never })), "interrupted", "goal still active");
  assert.equal(zaicodeSessionStateOf(task({ taskId: "e", status: "error" })), "failed");
  const facts = zaicodeSessionBriefOf(crashed, "k", { workspacePath: "C:/p/a" });
  assert.equal(facts.interrupted, true);
  assert.equal(facts.crashCut, true, "no live phase + running = the process died");
  const stopped = zaicodeSessionBriefOf(live(task({ taskId: "s", status: "completed" }), "completedInterrupted"), "k", { workspacePath: "C:/p/a" });
  assert.equal(stopped.interrupted, true);
  assert.equal(stopped.crashCut, false, "a Stop is the operator's, never auto-continued");
  const reloaded = zaicodeSessionBriefOf(live(task({ taskId: "r", status: "running" }), "completedInterrupted"), "k", { workspacePath: "C:/p/a" });
  assert.equal(reloaded.crashCut, true, "the CLI reloaded the dead turn as interrupted, tasks-index still says running");
  assert.equal(zaicodeSessionStateOf(live(task({ taskId: "x", status: "running", unreadAt: 1 }), "completedSuccess")), "interrupted");
});

test("DONE skips interrupted sessions; CONTINUE ALL continues them with cc", () => {
  const sessions = [
    brief({ sessionId: "done", projectKey: "a", unreadAt: 10 }),
    brief({ sessionId: "cut", projectKey: "a", unreadAt: 5, interrupted: true }),
  ];
  assert.deepEqual(zaicodeDoneUnseen(sessions).map((session) => session.sessionId), ["done"]);
  const plan = planZaicodeContinueAll([{ key: "a", name: "a", disabled: false, hasSaipen: true, state: "done", mainSessionId: null }], sessions);
  assert.deepEqual(
    plan.steps.map((step) => (step.kind === "session" ? `${step.sessionId}:${step.command.kind === "text" ? step.command.text : ""}:${step.why}` : "")),
    ["cut:cc:cut off mid-turn"],
  );
});

// --- ▶ START continues instead of piling up sessions (SRC-044) ---------------------

test("project START: MAIN continues in place, a cut-off session becomes MAIN, fresh only with nothing to continue", () => {
  assert.deepEqual(decideZaicodeProjectStart("m", [brief({ sessionId: "m", projectKey: "a", running: true })]), {
    action: "open",
    sessionId: "m",
    why: "MAIN is already working",
  });
  const cut = decideZaicodeProjectStart("m", [brief({ sessionId: "m", projectKey: "a", interrupted: true, goalStatus: "paused", goalObjective: "fix x" })]);
  assert.equal(cut.action, "send");
  assert.deepEqual(cut.action === "send" ? cut.command : null, { kind: "goal", objective: "fix x" }, "its own goal again");
  const idle = decideZaicodeProjectStart("m", [brief({ sessionId: "m", projectKey: "a" })]);
  assert.deepEqual(idle.action === "send" ? idle.command : null, { kind: "goal", objective: "cc all" });
  const unknownMain = decideZaicodeProjectStart("gone", []);
  assert.equal(unknownMain.action, "send", "MAIN not loaded: still continued by id");
  const adopt = decideZaicodeProjectStart(null, [brief({ sessionId: "new", projectKey: "a" }), brief({ sessionId: "old", projectKey: "a", interrupted: true })]);
  assert.equal(adopt.action === "send" ? `${adopt.sessionId}:${adopt.makeMain}` : "", "old:true");
  assert.equal(decideZaicodeProjectStart(null, [brief({ sessionId: "x", projectKey: "a", unreadAt: 1 })]).action, "fresh");
});

// --- auto-continue after a crash (SRC-044) -----------------------------------------

test("crash auto-continue: only crash-cut, recent, switched-on projects; oldest first; goal or cc", () => {
  const now = 10 * 3_600_000;
  const steps = planZaicodeCrashResume(
    [
      brief({ sessionId: "late", projectKey: "a", crashCut: true, updatedAt: now - 1000 }),
      brief({ sessionId: "early", projectKey: "a", crashCut: true, updatedAt: now - 5000, goalStatus: "active", goalObjective: "cc all" }),
      brief({ sessionId: "stale", projectKey: "a", crashCut: true, updatedAt: now - 20 * 3_600_000 }),
      brief({ sessionId: "stopped", projectKey: "a", interrupted: true, updatedAt: now }),
      brief({ sessionId: "off", projectKey: "off", crashCut: true, updatedAt: now }),
      brief({ sessionId: "plain", projectKey: "b", crashCut: true, updatedAt: now - 2000 }),
    ],
    (key) => (key === "off" ? { hasSaipen: true, disabled: true } : key === "b" ? { hasSaipen: false, disabled: false } : null),
    now,
    12,
  );
  assert.deepEqual(
    steps.map((step) => `${step.sessionId}:${step.command.kind === "goal" ? `goal ${step.command.objective}` : step.command.text}`),
    ["early:goal cc all", "plain:continue", "late:cc"],
  );
});

test("worker recovery list: bad entries dropped, placement kept", () => {
  assert.deepEqual(
    normalizeZaicodeAliveWorkers([{ accountId: "a", projectPath: "C:/p", prompt: "cc", placement: "window" }, { accountId: 1 }, null]),
    [{ accountId: "a", projectPath: "C:/p", prompt: "cc", placement: "window" }],
  );
});

// --- worker watch: limit + trust (SRC-046) --------------------------------------------

test("worker watch: the CLI's own limit line counts, prose about limits does not", () => {
  const claude = "Ran 1 shell command\n  ⎿ You've hit your session limit · resets 7:40pm (Europe/Tallinn)\n     Continuing automatically at 7:40pm";
  const signal = detectZaicodeWorkerSignals(claude).limit;
  assert.equal(signal?.window, "five_hour");
  assert.equal(signal?.resetText, "7:40pm (Europe/Tallinn)");
  assert.equal(detectZaicodeWorkerSignals("■ You've hit your usage limit. Upgrade to Pro or try again in 2 days").limit?.resetText, "2 days");
  assert.equal(detectZaicodeWorkerSignals("● Weekly limit reached · resets Mon 9:00").limit?.window, "weekly");
  assert.equal(detectZaicodeWorkerSignals("• Detector: when a worker says it hit your session limit we close it").limit, null, "prose");
  assert.equal(detectZaicodeWorkerSignals("nothing here").limit, null);
});

test("worker watch: first-run trust questions of Claude Code and Codex", () => {
  assert.equal(detectZaicodeWorkerSignals("│ Do you trust the files in this folder?\n│ ❯ 1. Yes, proceed").trust, true);
  assert.equal(detectZaicodeWorkerSignals(" Quick safety check: Is this a project you created or one you trust?\n ❯ 1. Yes, I trust this folder\n   2. No, exit").trust, true);
  assert.equal(detectZaicodeWorkerSignals("› 1. Yes, allow Codex to work in this folder without asking for approval").trust, true);
  assert.equal(detectZaicodeWorkerSignals("The operator said: a worker waits on Trust this folder? for 8 hours").trust, false, "prose");
  assert.equal(stripZaicodeAnsi("\u001b[1mYou've\u001b[1Chit\u001b[0m\r\nx"), "You've hit\nx");
});

// --- nearest resets column (SRC-046) ----------------------------------------------------

test("nearest resets: every reset ahead, soonest first, FastPrompter's window names", () => {
  const now = 1_000_000;
  const window = (key: string, label: string, remaining: number | null, inMs: number, group = "") => ({
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
    c1: { accountId: "c1", windows: [window("five_hour", "5h", 40, 600_000), window("weekly", "weekly", 90, 86_400_000)], plan: null, fetchedAt: now, checkedAt: now, error: null, source: "t" },
    ag: { accountId: "ag", windows: [window("five_hour", "5h", 100, 60_000, "Claude and GPT")], plan: null, fetchedAt: now, checkedAt: now, error: null, source: "t" },
  };
  const rows = zaicodeResetRows(
    [
      { id: "c1", short: "C1", label: "Claude 1", vendor: "claude" },
      { id: "ag", short: "AG", label: "Antigravity", vendor: "antigravity" },
    ],
    limits,
    now,
  );
  assert.deepEqual(rows.map((row) => `${row.accountShort}:${row.window}:${row.pool}`), ["AG:Session:Claude and GPT", "C1:Session:", "C1:Weekly:"]);
  assert.equal(zaicodeNextUsefulReset(rows)?.accountShort, "C1", "a full window is listed but not the timer's pick");
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
  const prefs = normalizeZaicodeWorkerPrefs({ panelDock: "right", panelWidth: 10, onLimit: "closeAndResume", autoTrust: false });
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
  const [job] = normalizeZaicodeAutostartJobs([{ id: "j", projectPath: "C:/p", engineId: "pool:start", prompt: audit }]);
  assert.equal(job!.prompt.length, 50_000, "the old 2 000-character cut is gone");
  assert.equal(job!.beforeRun, "none");
  assert.equal(job!.onlyWhenIdle, false);
  assert.equal(job!.order, "problems");
  assert.equal(job!.onlyMarked, false);
  const [custom] = normalizeZaicodeAutostartJobs([{ id: "j", projectPath: "C:/p", engineId: "c1", beforeRun: "stopWeaker", order: "list", onlyMarked: true }]);
  assert.deepEqual([custom!.beforeRun, custom!.order, custom!.onlyMarked], ["stopWeaker", "list", true]);
  assert.equal(zaicodeWorkerPromptNeedsFile(audit), true);
  assert.equal(zaicodeWorkerPromptNeedsFile("line one\nline two"), true);
  assert.equal(zaicodeWorkerPromptNeedsFile("cc"), false);
  assert.match(zaicodeWorkerFilePrompt("C:/x/p.md"), /Read the file "C:\/x\/p\.md"/);
});

test("section order: most blocked / open first, unknown last, ties keep the sidebar order", () => {
  const targets = ["calm", "burning", "none", "busy"].map((key) => ({ key, path: `C:/${key}`, name: key }));
  const rows = {
    calm: { openTickets: 1, blockedTickets: 0 },
    burning: { openTickets: 2, blockedTickets: 3 },
    busy: { openTickets: 11, blockedTickets: 0 },
  };
  assert.deepEqual(orderZaicodeScheduleTargets(targets, rows, "problems").map((target) => target.key), ["burning", "busy", "calm", "none"], "11 = 11: the blocked one first");
  const busier = { ...rows, busy: { openTickets: 12, blockedTickets: 0 } };
  assert.deepEqual(orderZaicodeScheduleTargets(targets, busier, "problems").map((target) => target.key), ["busy", "burning", "calm", "none"]);
  assert.deepEqual(orderZaicodeScheduleTargets(targets, rows, "list").map((target) => target.key), ["calm", "burning", "none", "busy"]);
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
      { sessionId: "free", title: "free", projectKey: "a", running: true, model: "new-provider/SAIFREN" },
      { sessionId: "opp", title: "opp", projectKey: "a", running: true, model: "new-provider/SAIOPP" },
      { sessionId: "other", title: "other", projectKey: "b", running: true, model: "new-provider/SAIFREN" },
    ],
    workers: [
      { id: "z", kind: "worker", vendor: "zcode", exitCode: null, projectPath: "C:/A", short: "ZC", projectName: "a" },
      { id: "c", kind: "worker", vendor: "claude", exitCode: null, projectPath: "C:/a", short: "C2", projectName: "a" },
      { id: "sh", kind: "shell", vendor: null, exitCode: null, projectPath: "C:/a", short: "PS", projectName: "a" },
    ],
  });
  assert.deepEqual(plan.sessions.map((session) => session.sessionId), ["free"]);
  assert.deepEqual(plan.workers.map((worker) => worker.id), ["z"]);
  const all = planZaicodeBeforeRun({ mode: "stopAll", runnerRank: 3, targets: [{ key: "a", path: "C:/a" }], sessions: [{ sessionId: "opp", title: "opp", projectKey: "a", running: true, model: null }], workers: [] });
  assert.deepEqual(all.sessions.map((session) => session.sessionId), ["opp"]);
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
      brief({ sessionId: "goal", projectKey: "a", interrupted: true, goalStatus: "active", goalObjective: "saiwiki" }),
      brief({ sessionId: "run", projectKey: "a", running: true }),
      brief({ sessionId: "ask", projectKey: "a", waiting: true }),
    ],
    new Set(["main"]),
    () => true,
  );
  assert.deepEqual(plan.archive.map((entry) => entry.sessionId), ["done"]);
  assert.deepEqual(
    plan.resume.map((entry) => `${entry.sessionId}:${entry.command.kind === "goal" ? entry.command.objective : entry.command.text}`),
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
  assert.equal("label" in (list.find((entry) => entry.id === "workers") ?? {}), false, "empty = the built-in name");
  const title = normalizeZaicodeHeaderTitlePrefs({ size: 99, align: "center", color: "project", font: "nope" });
  assert.equal(title.size, 40);
  assert.equal(title.align, "center");
  assert.equal(title.color, "project");
  assert.equal(title.font, "verdana");
  assert.equal(normalizeZaicodeHeaderTitlePrefs(null).showProject, true);
});
