// T-164 / SRC-116 —— 诊断快照的形状与脱敏。
//
// 快照是要交给外部的产物，所以真正要证明的不是"字段都在"，而是"该掉的一定掉了"。
import assert from "node:assert/strict";
import test from "node:test";

import {
  RUNTIME_HEALTH_MAX_STRING,
  RUNTIME_HEALTH_SNAPSHOT_VERSION,
  RUNTIME_HEALTH_TRUNCATED_SUFFIX,
  formatRuntimeHealthSnapshot,
  redactRuntimeHealthSnapshot,
  type RuntimeHealthSnapshot,
} from "@zcode/shared";
import { buildRuntimeHealthSnapshot } from "../src/lib/runtimeHealthSnapshot.js";

function baseSnapshot(over: Partial<RuntimeHealthSnapshot> = {}): RuntimeHealthSnapshot {
  return {
    version: RUNTIME_HEALTH_SNAPSHOT_VERSION,
    takenAt: "2026-10-01T00:00:00.000Z",
    app: { version: "1.2.3", platform: "Win32", uptimeSeconds: 3600 },
    memory: { rssBytes: 1_000, heapUsedBytes: 500, heapTotalBytes: 900 },
    eventLoopLagMs: 4.5,
    counters: { "sessionStore.workspaces": 3, "xterm.sessions": 2, "eventLoop.lagMs": 4.5 },
    quotaCircuits: [
      {
        providerId: "glm",
        openedAt: "2026-10-01T00:00:00.000Z",
        until: "2026-10-01T00:15:00.000Z",
        failures: 3,
        reason: "quota exhausted",
        resetSource: "vendor",
      },
    ],
    quotaWindows: [
      {
        key: "five_hour@gemini",
        label: "Gemini 5h",
        provider: "antigravity",
        remainingPercent: 42,
        resetsAt: "2026-10-01T05:00:00.000Z",
        waitingForFirstUse: false,
        gatedBy: null,
      },
    ],
    fallbackRoutes: [],
    continuationRuns: [],
    notes: [],
    ...over,
  };
}

test("a snapshot keeps the fields a degradation report needs", () => {
  const json = JSON.parse(formatRuntimeHealthSnapshot(baseSnapshot())) as RuntimeHealthSnapshot;
  assert.equal(json.version, RUNTIME_HEALTH_SNAPSHOT_VERSION);
  assert.equal(json.app.uptimeSeconds, 3600);
  assert.equal(json.memory.heapUsedBytes, 500);
  assert.equal(json.eventLoopLagMs, 4.5);
  assert.equal(json.counters["sessionStore.workspaces"], 3);
  assert.equal(json.quotaCircuits[0]?.providerId, "glm");
  assert.equal(json.quotaWindows[0]?.remainingPercent, 42);
});

test("a continuation run carries the hand-off: the spent runner, the vendor's reset, and the way back", () => {
  // 这就是 T-216 要人工观察并附上的那份产物。它必须能证明"换到了别处"和"按供应商的钟点回来"。
  const run = baseSnapshot({
    continuationRuns: [
      {
        projectPath: "V:/repo",
        occurrence: "daily@09:00#3",
        state: "waiting",
        runnerId: "C2",
        blocked: [
          { runnerId: "C1", window: "five_hour", resetHint: "resets 7:40pm (Europe/Tallinn)" },
        ],
        nextAt: "2026-10-01T00:20:00.000Z",
        preferredReadyAt: "2026-10-01T19:40:00.000Z",
        outcome: "Runner C1 spent; continuing on C2",
      },
    ],
  });
  const parsed = JSON.parse(formatRuntimeHealthSnapshot(run)) as RuntimeHealthSnapshot;
  const only = parsed.continuationRuns[0];
  // 换到了哪儿：当前 runner 不是被封的那一个。
  assert.equal(only.runnerId, "C2");
  assert.equal(only.blocked[0]?.runnerId, "C1");
  // 供应商自己的话没有被脱敏切掉（字段名刻意避开 "text"）。
  assert.equal(only.blocked[0]?.resetHint, "resets 7:40pm (Europe/Tallinn)");
  // 按供应商的钟点回来，而不是本地估算。
  assert.equal(only.preferredReadyAt, "2026-10-01T19:40:00.000Z");
  assert.ok((Date.parse(only.preferredReadyAt ?? "") - Date.parse(only.nextAt)) > 0);
});

test("a continuation run never exports the session it holds or the prompt it was given", () => {
  const leaky = baseSnapshot({
    continuationRuns: [
      {
        projectPath: "V:/repo",
        occurrence: "daily@09:00#3",
        state: "running",
        runnerId: "C1",
        blocked: [],
        nextAt: "2026-10-01T00:00:00.000Z",
        sessionId: "session-that-should-never-appear",
        prompt: "the kick prompt, verbatim",
      } as never,
    ],
  });
  const json = formatRuntimeHealthSnapshot(leaky);
  for (const secret of ["session-that-should-never-appear", "the kick prompt, verbatim"]) {
    assert.equal(json.includes(secret), false, `leaked: ${secret}`);
  }
  const parsed = JSON.parse(json) as RuntimeHealthSnapshot;
  assert.equal(parsed.continuationRuns[0]?.runnerId, "C1");
});

test("credential-shaped and message-shaped fields never survive redaction", () => {
  const leaky = baseSnapshot({
    app: {
      version: "1.2.3",
      uptimeSeconds: 10,
      apiKey: "sk-live-should-never-appear",
      authorization: "Bearer abc123",
      userPassword: "hunter2",
      accessToken: "tok_123",
    } as never,
    notes: ["all good"],
    quotaCircuits: [
      {
        providerId: "glm",
        openedAt: "2026-10-01T00:00:00.000Z",
        until: "2026-10-01T00:15:00.000Z",
        failures: 1,
        reason: "quota exhausted",
        resetSource: "vendor",
        privateKey: "-----BEGIN RSA PRIVATE KEY-----",
        chatMessageBody: "the user's last turn, verbatim",
      } as never,
    ],
  });
  const json = formatRuntimeHealthSnapshot(leaky);
  for (const secret of [
    "sk-live-should-never-appear",
    "abc123",
    "hunter2",
    "tok_123",
    "BEGIN RSA PRIVATE KEY",
    "last turn, verbatim",
  ]) {
    assert.equal(json.includes(secret), false, `leaked: ${secret}`);
  }
  // 脱敏是按 key 名的，所以快照结构本身仍然可用。
  const parsed = JSON.parse(json) as RuntimeHealthSnapshot;
  assert.equal(parsed.quotaCircuits[0]?.providerId, "glm");
});

test("a long string is truncated rather than exported whole", () => {
  const long = "x".repeat(RUNTIME_HEALTH_MAX_STRING + 500);
  const redacted = redactRuntimeHealthSnapshot(
    baseSnapshot({ notes: [long] }),
  ) as unknown as { notes: string[] };
  assert.equal(redacted.notes[0]?.endsWith(RUNTIME_HEALTH_TRUNCATED_SUFFIX), true);
  assert.ok((redacted.notes[0]?.length ?? 0) < long.length);
});

test("the live builder fills every source it is given and never throws on the missing ones", () => {
  const snapshot = buildRuntimeHealthSnapshot({
    now: 1_700_000_000_000,
    startedAt: 1_700_000_000_000 - 3_600_000,
    appVersion: "9.9.9",
    processMemory: { rssBytes: 42, heapUsedBytes: 21, heapTotalBytes: 30 },
    readCounters: () => ({ "sessionStore.taskUi": 12 }),
    readEventLoopLagMs: () => 7.25,
    readQuotaCircuits: () => [],
    readQuotaWindows: () => [],
    readFallbackRoutes: () => [],
  });
  assert.equal(snapshot.app.uptimeSeconds, 3600);
  assert.equal(snapshot.app.version, "9.9.9");
  assert.equal(snapshot.memory.rssBytes, 42);
  assert.equal(snapshot.eventLoopLagMs, 7.25);
  assert.equal(snapshot.counters["sessionStore.taskUi"], 12);
  // 直接读取的热点计数始终在，即使对应模块这次没被 import。
  assert.equal(typeof snapshot.counters["hot.queryKeys"], "number");
  assert.equal(typeof snapshot.counters["hot.toasts"], "number");
  assert.equal(typeof snapshot.counters["retry.maxAttempts"], "number");
  assert.deepEqual(snapshot.quotaCircuits, []);
});

test("a non-finite counter is dropped instead of serialising as null garbage", () => {
  const snapshot = buildRuntimeHealthSnapshot({
    readCounters: () => ({ good: 1, bad: Number.NaN }),
  });
  assert.equal(snapshot.counters.good, 1);
  assert.equal(snapshot.counters.bad, undefined);
});
