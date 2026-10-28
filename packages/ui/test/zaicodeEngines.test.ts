import assert from "node:assert/strict";
import test from "node:test";
import {
  createZaicodeAutostartJob,
  effectiveZaicodeWindows,
  evaluateZaicodeAutostartJob,
  formatZaicodeDuration,
  normalizeZaicodeAutostartJobs,
  normalizeZaicodeEnginesConfig,
  parseAntigravityUsage,
  parseClaudeUsageText,
  parseCodexRateLimits,
  parseZcodeQuota,
  zaicodeBottleneck,
  zaicodeEngineAvailability,
  zaicodeNextRefillAt,
  type ZaicodeLimitSnapshot,
} from "@zcode/shared";

const NOW = new Date(2026, 8, 24, 19, 0, 0).getTime();

// Claude prints resets in the zone it names ("(Europe/Tallinn)"): the oracle is the absolute instant,
// so this test gives the same answer whatever TZ the test process (or ZAICODE) runs with.
const CLAUDE_NOW = Date.UTC(2026, 8, 24, 19, 0, 0); // 22:00 in Tallinn (EEST, UTC+3)

test("claude /usage text parses session and weekly windows in the zone the CLI names", () => {
  const text = [
    "You are currently using your subscription to power your Claude Code usage",
    "",
    "Current session: 22% used · resets Sep 25, 12:29am (Europe/Tallinn)",
    "Current week (all models): 30% used · resets Sep 29, 4:59pm (Europe/Tallinn)",
    "Current week (Sonnet): 100% used · resets Sep 29, 5pm (Europe/Tallinn)",
    "  92% of your usage was at >150k context",
  ].join("\n");
  const windows = parseClaudeUsageText(text, CLAUDE_NOW);
  assert.deepEqual(
    windows.map((window) => [window.key, window.remainingPercent]),
    [
      ["five_hour", 78],
      ["weekly", 70],
      ["weekly_sonnet", 0],
    ],
  );
  // Sep 25 00:29 EEST = Sep 24 21:29 UTC; Sep 29 16:59 EEST = 13:59 UTC.
  assert.equal(windows[0]!.resetsAt, Date.UTC(2026, 8, 24, 21, 29));
  assert.equal(windows[1]!.resetsAt, Date.UTC(2026, 8, 29, 13, 59));
  // A spent per-model weekly never blocks the whole account.
  assert.equal(zaicodeBottleneck(windows, CLAUDE_NOW)?.key, "weekly");
});

test("a 5h window never reads 'resets in 6h 30m' (SRC-033: reset read in the wrong zone)", () => {
  // 02:21 in Tallinn (23:21 UTC). The CLI says the session resets at 5:51am Tallinn = 02:51 UTC, 3h30m
  // away. Read as local time in a process with TZ=UTC it became 05:51 UTC: "resets in 6h 30m".
  const now = Date.UTC(2026, 8, 24, 23, 21);
  const windows = parseClaudeUsageText("Current session: 100% used · resets Sep 25, 5:51am (Europe/Tallinn)", now);
  assert.equal(windows[0]!.resetsAt, Date.UTC(2026, 8, 25, 2, 51));
  assert.ok(windows[0]!.resetsAt! - now <= 5 * 3_600_000 + 15 * 60_000);
  // A reset further away than the window itself is dropped as a misread, not shown.
  const bogus = parseClaudeUsageText("Current session: 10% used · resets Sep 27, 8:51am (Europe/Tallinn)", now);
  assert.equal(bogus[0]!.resetsAt, null);
  // An unknown zone falls back to local time instead of failing.
  const unknownZone = parseClaudeUsageText("Current week (all models): 1% used · resets Sep 29, 5pm (Mars/Olympus)", now);
  assert.equal(unknownZone[0]!.resetsAt, new Date(2026, 8, 29, 17, 0).getTime());
});

test("codex rateLimits: plus account blocked by weekly, free account monthly", () => {
  const plus = parseCodexRateLimits({
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 34, windowDurationMins: 300, resetsAt: 1790275591 },
      secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1790724084 },
      planType: "plus",
    },
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        primary: { usedPercent: 34, windowDurationMins: 300, resetsAt: 1790275591 },
        secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1790724084 },
        planType: "plus",
      },
    },
  });
  assert.equal(plus.plan, "plus");
  assert.deepEqual(
    plus.windows.map((window) => [window.key, window.remainingPercent, window.resetsAt]),
    [
      ["five_hour", 66, 1790275591000],
      ["weekly", 0, 1790724084000],
    ],
  );
  const effective = effectiveZaicodeWindows(plus.windows, 1790270000000);
  assert.equal(effective[0]!.remainingPercent, 0);
  assert.equal(effective[0]!.gatedBy, "weekly");
  const snapshot: ZaicodeLimitSnapshot = {
    accountId: "codex:x",
    windows: plus.windows,
    plan: "plus",
    fetchedAt: 1,
    checkedAt: 1,
    error: null,
    source: "",
  };
  assert.equal(zaicodeEngineAvailability(snapshot, 1790270000000), "blocked");
  assert.equal(zaicodeNextRefillAt(snapshot, 1790270000000), 1790724084000);

  const free = parseCodexRateLimits({
    rateLimits: { primary: { usedPercent: 0, windowDurationMins: 43200, resetsAt: 1792860437 }, planType: "free" },
    rateLimitsByLimitId: {
      codex: { primary: { usedPercent: 0, windowDurationMins: 43200, resetsAt: 1792860437 }, planType: "free" },
    },
  });
  assert.equal(free.plan, "free");
  assert.deepEqual(free.windows.map((window) => [window.key, window.remainingPercent]), [["monthly", 100]]);
});

test("antigravity pools stay independent and a disabled 5h reads zero", () => {
  const windows = parseAntigravityUsage({
    command: {
      data: {
        groups: [
          {
            name: "Gemini Models",
            buckets: [
              { id: "gemini-weekly", window: "weekly", remaining_fraction: 0.0848, reset_time: "2026-09-30T06:41:21Z" },
              { id: "gemini-5h", window: "5h", remaining_fraction: 0.0404, reset_time: "2026-09-24T18:20:41Z" },
            ],
          },
          {
            name: "Claude and GPT models",
            buckets: [
              { id: "3p-weekly", window: "weekly", remaining_fraction: 0, reset_time: "2026-09-25T16:16:03Z" },
              { id: "3p-5h", window: "5h", disabled: true, remaining_fraction: 1 },
            ],
          },
        ],
      },
    },
  });
  assert.equal(windows.length, 4);
  const claude5h = windows.find((window) => window.key === "five_hour@claude_and_gpt_models");
  assert.equal(claude5h?.remainingPercent, 0);
  assert.equal(claude5h?.label, "Claude & GPT 5h");
  const now = Date.parse("2026-09-24T16:00:00Z");
  // Gemini still has quota: the engine is low, not blocked.
  assert.equal(zaicodeBottleneck(windows, now)?.group, "gemini_models");
  assert.equal(
    zaicodeEngineAvailability(
      { accountId: "a", windows, plan: null, fetchedAt: 1, checkedAt: 1, error: null, source: "" },
      now,
    ),
    "low",
  );
});

test("zcode quota: unit selects the window, currentValue + remaining is the total", () => {
  const parsed = parseZcodeQuota({
    code: 200,
    data: {
      level: "lite",
      limits: [
        { type: "CREDIT_LIMIT", unit: 3, number: 5, currentValue: 252, remaining: 1747, nextResetTime: 1788498595214 },
        { type: "CREDIT_LIMIT", unit: 6, number: 1, currentValue: 252, remaining: 9747, nextResetTime: 1789085298997 },
        { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 12 },
      ],
    },
  });
  assert.equal(parsed.level, "lite");
  assert.equal(parsed.error, null);
  assert.deepEqual(
    parsed.windows.map((window) => [window.key, Math.round(window.remainingPercent ?? -1)]),
    [
      ["five_hour", 87],
      ["weekly", 97],
    ],
  );
  assert.match(parseZcodeQuota({ code: 500, msg: "no coding plan" }).error ?? "", /no active Coding Plan/);
});

test("an elapsed window reads full until the next read", () => {
  const windows = parseClaudeUsageText("Current session: 100% used · resets Sep 24, 6pm (Europe/Tallinn)", NOW);
  const effective = effectiveZaicodeWindows(windows, NOW);
  assert.equal(effective[0]!.remainingPercent, 100);
  assert.equal(effective[0]!.assumedFull, true);
});

test("engines config normalizes unknown values to safe defaults", () => {
  const config = normalizeZaicodeEnginesConfig({ intervalMinutes: 7, hiddenAccounts: ["a", "a", 3], workerYolo: "x" });
  assert.equal(config.intervalMinutes, 5);
  assert.deepEqual(config.hiddenAccounts, ["a"]);
  assert.equal(config.workerYolo, true);
  assert.equal(config.workerPrompt, "saipen continue");
});

test("autostart: at-time job fires once, then is done; late start is missed", () => {
  const at = NOW + 60_000;
  const job = createZaicodeAutostartJob({ id: "j", projectPath: "P", engineId: "claude:x", trigger: "at", at }, NOW);
  assert.equal(evaluateZaicodeAutostartJob(job, undefined, NOW).state, "waiting-time");
  const due = evaluateZaicodeAutostartJob(job, undefined, at + 1000);
  assert.equal(due.state, "due");
  const fired = { ...job, firedEvents: [due.eventId] };
  assert.equal(evaluateZaicodeAutostartJob(fired, undefined, at + 2000).state, "done");
  assert.equal(evaluateZaicodeAutostartJob(job, undefined, at + 3_600_000).state, "missed");
});

test("autostart: reset trigger waits for the refill plus the safety delay, fires once per reset", () => {
  // 19:00 in Tallinn (the zone the CLI names), whatever TZ this process has.
  const now = Date.UTC(2026, 8, 24, 16, 0, 0);
  const resetsAt = now + 10 * 60_000;
  const snapshot: ZaicodeLimitSnapshot = {
    accountId: "codex:x",
    windows: parseClaudeUsageText("Current session: 100% used · resets Sep 24, 7:10pm (Europe/Tallinn)", now),
    plan: null,
    fetchedAt: now,
    checkedAt: now,
    error: null,
    source: "",
  };
  assert.equal(snapshot.windows[0]!.resetsAt, resetsAt);
  const job = createZaicodeAutostartJob(
    { id: "r", projectPath: "P", engineId: "claude:x", trigger: "everyReset", window: "five_hour", safetyDelaySeconds: 60 },
    now,
  );
  assert.equal(evaluateZaicodeAutostartJob(job, snapshot, now).state, "waiting-reset");
  assert.equal(evaluateZaicodeAutostartJob(job, snapshot, resetsAt + 30_000).state, "waiting-reset");
  const due = evaluateZaicodeAutostartJob(job, snapshot, resetsAt + 61_000);
  assert.equal(due.state, "due");
  const fired = { ...job, firedEvents: [due.eventId] };
  assert.equal(evaluateZaicodeAutostartJob(fired, snapshot, resetsAt + 62_000).state, "waiting-reset");
});

test("autostart: a blocked engine waits for quota instead of launching into a wall", () => {
  const windows = parseCodexRateLimits({
    rateLimits: {
      primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: (NOW + 3_600_000) / 1000 },
      secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: (NOW + 86_400_000) / 1000 },
    },
  }).windows;
  const snapshot: ZaicodeLimitSnapshot = { accountId: "c", windows, plan: null, fetchedAt: NOW, checkedAt: NOW, error: null, source: "" };
  const job = createZaicodeAutostartJob({ id: "q", projectPath: "P", engineId: "codex:c", trigger: "at", at: NOW - 1000 }, NOW);
  assert.equal(evaluateZaicodeAutostartJob(job, snapshot, NOW).state, "waiting-quota");
  assert.equal(evaluateZaicodeAutostartJob({ ...job, engineId: "pool:p/m" }, snapshot, NOW).state, "due");
});

test("autostart jobs normalize and drop malformed entries", () => {
  const jobs = normalizeZaicodeAutostartJobs([{ id: "a", projectPath: "P", engineId: "e", trigger: "bogus" }, { id: 3 }, null]);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.trigger, "reset");
  assert.equal(formatZaicodeDuration(3 * 3_600_000 + 5 * 60_000), "3h 05m");
});
