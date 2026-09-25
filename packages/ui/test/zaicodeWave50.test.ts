import assert from "node:assert/strict";
import test from "node:test";
import {
  ZAICODE_HIT_AND_GO_PROMPT,
  createZaicodeAutostartJob,
  evaluateZaicodeAutostartJob,
  isZaicodeRawCommand,
  normalizeZaicodeAutostartJobs,
  pickZaicodeFallbackPool,
  zaicodeAutostartWatchedEngine,
  zaicodeJobTaskText,
  zaicodeScheduleStopAt,
  type ZaicodeAutostartDecision,
  type ZaicodeAutostartJob,
  type ZaicodeLimitSnapshot,
  type ZaicodeLimitWindow,
} from "@zcode/shared";
import {
  ZAICODE_SCHEDULE_PRESETS,
  describeZaicodeSchedule,
  zaicodePreparedEngines,
  zaicodeRunsToStop,
  zaicodeScheduleTargets,
  zaicodeUpcomingSchedules,
} from "../src/zaicode/zaicodeScheduler.js";
import { ZAICODE_NAV_ITEMS, normalizeZaicodeLayoutList } from "../src/zaicode/zaicodeLayoutPrefs.js";

const NOW = new Date(2026, 8, 25, 10, 0, 0).getTime();

function windowOf(resetsAt: number, remaining = 0): ZaicodeLimitWindow {
  return {
    key: "five_hour",
    label: "5h",
    group: "",
    groupLabel: "",
    remainingPercent: remaining,
    resetsAt,
    durationMinutes: 300,
    gatedBy: null,
  } as ZaicodeLimitWindow;
}

function snapshot(windows: ZaicodeLimitWindow[]): ZaicodeLimitSnapshot {
  return { accountId: "claude:a1", windows, plan: null, fetchedAt: NOW, checkedAt: NOW, error: null, source: "" };
}

test("hit and go: an empty task is /goal cc all; slash commands and bare shortcuts are commands", () => {
  assert.equal(ZAICODE_HIT_AND_GO_PROMPT, "/goal cc all");
  assert.equal(zaicodeJobTaskText("   "), "/goal cc all");
  assert.equal(zaicodeJobTaskText("fix the login"), "fix the login");
  for (const command of ["/goal cc all", "cc", "сс", "saiwiki", "saipen crew", " /review "]) {
    assert.equal(isZaicodeRawCommand(command), true, command);
  }
  for (const text of ["fix all", "clean up the cc parser", "// not a command", ""]) {
    assert.equal(isZaicodeRawCommand(text), false, text);
  }
});

test("an agent without a pool borrows SAIFREN on SAIRoute, then SAIOPP; nothing -> null", () => {
  const providers = [
    { providerId: "other", providerName: "Other", models: [{ modelId: "SAIFREN" }] },
    { providerId: "sr", providerName: "SAIRoute", models: [{ modelId: "SAIOPP" }, { modelId: "SAIFREN" }] },
  ];
  assert.deepEqual(pickZaicodeFallbackPool(providers), { providerId: "sr", modelId: "SAIFREN" });
  assert.deepEqual(pickZaicodeFallbackPool([{ providerId: "x", providerName: null, models: [{ modelId: "SAIOPP" }] }]), {
    providerId: "x",
    modelId: "SAIOPP",
  });
  assert.equal(pickZaicodeFallbackPool([{ providerId: "x", models: [{ modelId: "gpt" }] }]), null);
});

test("schedules keep older records working and read the new fields safely", () => {
  const [old] = normalizeZaicodeAutostartJobs([{ id: "a", projectPath: "P", engineId: "claude:a1" }]);
  assert.equal(old!.targetKind, "project");
  assert.equal(old!.section, "MAIN0");
  assert.equal(old!.watchEngineId, "");
  assert.equal(old!.stopAt, "");
  assert.deepEqual(old!.runs, []);
  const [fresh] = normalizeZaicodeAutostartJobs([
    { id: "b", projectPath: "P", engineId: "agent:x", targetKind: "section", section: "MAIN1", stopAt: "7:05", runs: [{ jobId: "j", workspaceKey: "k", at: 1 }, { bad: true }] },
  ]);
  assert.equal(fresh!.targetKind, "section");
  assert.equal(fresh!.section, "MAIN1");
  assert.equal(fresh!.stopAt, "7:05");
  assert.equal(fresh!.runs.length, 1);
  const [bad] = normalizeZaicodeAutostartJobs([{ id: "c", projectPath: "P", engineId: "pool:start", stopAt: "soon" }]);
  assert.equal(bad!.stopAt, "");
});

test("watched engine: a subscription watches itself; an agent or pool watches only what you pick", () => {
  assert.equal(zaicodeAutostartWatchedEngine({ engineId: "claude:a1", watchEngineId: "" }), "claude:a1");
  assert.equal(zaicodeAutostartWatchedEngine({ engineId: "agent:x", watchEngineId: "" }), null);
  assert.equal(zaicodeAutostartWatchedEngine({ engineId: "pool:start", watchEngineId: "codex:c1" }), "codex:c1");
});

test("an agent schedule fires after the watched subscription's reset, and waits while it has no quota", () => {
  const resetsAt = NOW + 10 * 60_000;
  const job = createZaicodeAutostartJob(
    { id: "s", projectPath: "P", engineId: "agent:auto", watchEngineId: "claude:a1", trigger: "everyReset", window: "five_hour", safetyDelaySeconds: 0 },
    NOW,
  );
  assert.equal(evaluateZaicodeAutostartJob(job, snapshot([windowOf(resetsAt)]), NOW).state, "waiting-reset");
  assert.equal(evaluateZaicodeAutostartJob(job, snapshot([windowOf(resetsAt, 100)]), resetsAt + 1000).state, "due");
  // Daily agent schedule gated by the watched engine: out of quota -> waits.
  const daily = createZaicodeAutostartJob(
    { id: "d", projectPath: "P", engineId: "agent:auto", watchEngineId: "claude:a1", trigger: "daily", dailyTime: "10:00" },
    NOW - 3_600_000,
  );
  const blocked = snapshot([windowOf(NOW + 3_600_000, 0)]);
  assert.equal(evaluateZaicodeAutostartJob(daily, blocked, NOW + 1000).state, "waiting-quota");
  // Nothing watched: an agent schedule never waits for quota.
  const unwatched = { ...daily, watchEngineId: "" };
  assert.equal(evaluateZaicodeAutostartJob(unwatched, undefined, NOW + 1000).state, "due");
});

test("stop time: the same day after the start, else the next day; runs past it are stopped", () => {
  const started = new Date(2026, 8, 25, 2, 0, 0).getTime();
  assert.equal(zaicodeScheduleStopAt("07:00", started), new Date(2026, 8, 25, 7, 0, 0).getTime());
  assert.equal(zaicodeScheduleStopAt("01:00", started), new Date(2026, 8, 26, 1, 0, 0).getTime());
  assert.equal(zaicodeScheduleStopAt("nope", started), null);
  const job = { stopAt: "07:00", runs: [{ jobId: "early", workspaceKey: "k", at: started }, { jobId: "late", workspaceKey: "k", at: new Date(2026, 8, 25, 6, 59).getTime() }] };
  assert.deepEqual(zaicodeRunsToStop(job, new Date(2026, 8, 25, 6, 0).getTime(), zaicodeScheduleStopAt), []);
  assert.deepEqual(zaicodeRunsToStop(job, new Date(2026, 8, 25, 7, 0, 1).getTime(), zaicodeScheduleStopAt), ["early", "late"]);
  assert.deepEqual(zaicodeRunsToStop({ ...job, stopAt: "" }, Number.MAX_SAFE_INTEGER, zaicodeScheduleStopAt), []);
});

test("section target: every project in that sidebar section (default slot for unassigned ones)", () => {
  const projects = [
    { path: "V:/a", key: "V:/a", name: "a" },
    { path: "V:/b", key: "V:/b", name: "b" },
    { path: "V:/c", key: "V:/c", name: "c" },
  ];
  const groups = { "V:/a": "MAIN1", "V:/b": "MAIN0" };
  const section = createZaicodeAutostartJob({ id: "x", projectPath: "", engineId: "pool:start", targetKind: "section", section: "MAIN0" });
  assert.deepEqual(zaicodeScheduleTargets(section, projects, groups, "MAIN0").map((project) => project.name), ["b", "c"]);
  const one = createZaicodeAutostartJob({ id: "y", projectPath: "v:/A", engineId: "pool:start" });
  assert.deepEqual(zaicodeScheduleTargets(one, projects, groups, "MAIN0").map((project) => project.name), ["a"]);
});

test("next up, prepared meters and plain-words description", () => {
  const decisions: Record<string, ZaicodeAutostartDecision> = {
    soon: { state: "waiting-time", dueAt: NOW + 60_000, eventId: "e1", reason: "" },
    later: { state: "waiting-time", dueAt: NOW + 3_600_000, eventId: "e2", reason: "" },
    reset: { state: "waiting-reset", dueAt: null, eventId: "", reason: "" },
    off: { state: "disabled", dueAt: null, eventId: "", reason: "" },
  };
  const make = (id: string, patch: Partial<ZaicodeAutostartJob>) =>
    createZaicodeAutostartJob({ id, projectPath: "V:/proj", engineId: "claude:a1", ...patch });
  const jobs = [
    make("later", { trigger: "daily" }),
    make("reset", { trigger: "everyReset" }),
    make("soon", { trigger: "interval" }),
    make("off", { enabled: false }),
  ];
  const decide = (job: ZaicodeAutostartJob) => decisions[job.id]!;
  assert.deepEqual(zaicodeUpcomingSchedules(jobs, decide).map((item) => item.job.id), ["soon", "later", "reset"]);
  const prepared = zaicodePreparedEngines(jobs, decide);
  assert.deepEqual([...prepared.keys()], ["claude:a1"]);
  assert.deepEqual(prepared.get("claude:a1")!.map((item) => item.job.id), ["reset"]);
  assert.match(describeZaicodeSchedule(jobs[1]!, "A1"), /^\/goal cc all · proj · A1 · after every 5h reset$/);
});

test("presets are valid schedules; SCHEDULER sits right after ZAICODE even for an older stored menu", () => {
  for (const preset of ZAICODE_SCHEDULE_PRESETS) {
    const [job] = normalizeZaicodeAutostartJobs([{ id: preset.id, projectPath: "P", engineId: "pool:start", ...preset.patch }]);
    assert.ok(job, preset.id);
    assert.equal(job.trigger, preset.patch.trigger ?? "reset", preset.id);
  }
  const stored = [
    { id: "newTask", visible: true },
    { id: "zaicode", visible: true },
    { id: "search", visible: false },
    { id: "automations", visible: true },
  ];
  const menu = normalizeZaicodeLayoutList(stored, ZAICODE_NAV_ITEMS);
  // T-56: SAIHOME tops an older stored menu; T-51: SUBCHAT follows New task; SCHEDULER still follows ZAICODE.
  assert.deepEqual(menu.slice(0, 5).map((entry) => entry.id), ["saihome", "newTask", "subchat", "zaicode", "scheduler"]);
  assert.equal(menu.find((entry) => entry.id === "scheduler")!.visible, true);
  assert.equal(menu.some((entry) => (entry.id as string) === "automations"), false, "the upstream Automations line is gone");
});
