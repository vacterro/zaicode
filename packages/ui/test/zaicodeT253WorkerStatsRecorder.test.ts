// T-253 — 服务缺席、拒绝与超长运行不能丢统计；持久化按稳定 id 去重，renderer 只保留尚需处理的状态。
import assert from "node:assert/strict";
import test from "node:test";
import type { ZaicodeStatsWorkerSession } from "@zcode/shared";
import {
  ZaicodeWorkerStatsRecorder,
  type WorkerStatsProjection,
  type WorkerStatsWriter,
} from "../src/zaicode/home/zaicodeWorkerStatsRecorder.js";

const worker = (id: string, patch: Partial<WorkerStatsProjection> = {}): WorkerStatsProjection => ({
  id,
  kind: "worker",
  short: "A1",
  projectPath: "C:/test/project",
  startedAt: 100,
  endedAt: 500,
  exitCode: 0,
  ...patch,
});
const expected = (id: string): ZaicodeStatsWorkerSession => ({
  id,
  startedAt: 100,
  endedAt: 500,
  project: "C:/test/project",
  engine: "A1",
  exitCode: 0,
});
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("T-253: service availability retries a completed/disappeared session with its original timestamp", async () => {
  const recorder = new ZaicodeWorkerStatsRecorder();
  recorder.observe([worker("offline", { endedAt: null })], 500);
  await recorder.flush();
  recorder.observe([], 900);
  await recorder.flush();
  const received: ZaicodeStatsWorkerSession[] = [];
  await recorder.flush(async (sessions) => {
    received.push(...sessions);
  });
  assert.deepEqual(received, [expected("offline")]);
  assert.equal(recorder.retainedWorkerCount, 0);
});

test("T-253: a rejected RPC retains the exact payload for the next existing refresh", async () => {
  const recorder = new ZaicodeWorkerStatsRecorder();
  recorder.observe([worker("retry", { endedAt: null })], 500);
  await recorder
    .flush(async () => {
      throw new Error("host unavailable");
    })
    .catch(() => undefined);
  recorder.observe([], 900);
  const received: ZaicodeStatsWorkerSession[] = [];
  await recorder.flush(async (sessions) => {
    received.push(...sessions);
  });
  assert.deepEqual(received, [expected("retry")]);
  assert.equal(recorder.retainedWorkerCount, 0);
});

test("T-253: an uncertain acknowledgement can replay without counting the same stable id twice", async () => {
  const recorder = new ZaicodeWorkerStatsRecorder();
  const durable = new Map<string, ZaicodeStatsWorkerSession>();
  let calls = 0;
  const write: WorkerStatsWriter = async (sessions) => {
    calls += 1;
    for (const session of sessions) if (!durable.has(session.id)) durable.set(session.id, session);
    if (calls === 1) throw new Error("reply lost after write");
  };
  recorder.observe([worker("uncertain")], 500);
  await recorder.flush(write).catch(() => undefined);
  await recorder.flush(write);
  assert.equal(calls, 2);
  assert.deepEqual([...durable.values()], [expected("uncertain")]);
});

test("T-253: a visible terminal worker is submitted once across unrelated array updates", async () => {
  const recorder = new ZaicodeWorkerStatsRecorder();
  let calls = 0;
  const write: WorkerStatsWriter = async () => {
    calls += 1;
  };
  for (let iteration = 0; iteration < 20; iteration += 1) {
    recorder.observe([worker("visible")], 500 + iteration);
    await recorder.flush(write);
  }
  assert.equal(calls, 1);
});

test("T-253: a disappeared running worker is recorded once as stopped", async () => {
  const recorder = new ZaicodeWorkerStatsRecorder();
  const received: ZaicodeStatsWorkerSession[] = [];
  const write: WorkerStatsWriter = async (sessions) => {
    received.push(...sessions);
  };
  recorder.observe([worker("stopped", { endedAt: null, exitCode: null })], 200);
  await recorder.flush(write);
  recorder.observe([], 500);
  await recorder.flush(write);
  recorder.observe([], 900);
  await recorder.flush(write);
  assert.deepEqual(received, [{ ...expected("stopped"), exitCode: null }]);
});

test("T-253: shell and fix terminals do not produce subscription statistics", async () => {
  const recorder = new ZaicodeWorkerStatsRecorder();
  let calls = 0;
  const write: WorkerStatsWriter = async () => {
    calls += 1;
  };
  recorder.observe([worker("shell", { kind: "shell" }), worker("fix", { kind: "fix" })], 500);
  await recorder.flush(write);
  recorder.observe([], 900);
  await recorder.flush(write);
  assert.equal(calls, 0);
});

test("T-253: overlapping flushes share acknowledgement instead of completing before the writer", async () => {
  const recorder = new ZaicodeWorkerStatsRecorder();
  const blocked = gate();
  let calls = 0;
  const write: WorkerStatsWriter = async () => {
    calls += 1;
    await blocked.promise;
  };
  recorder.observe([worker("shared")], 500);
  const first = recorder.flush(write);
  const second = recorder.flush(write);
  let settled = false;
  void second.then(() => {
    settled = true;
  });
  try {
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(calls, 1);
  } finally {
    blocked.release();
    await Promise.all([first, second]);
  }
});

test("T-253: a session arriving during a write drains serially after that batch", async () => {
  const recorder = new ZaicodeWorkerStatsRecorder();
  const entered = gate();
  const blocked = gate();
  const received: string[] = [];
  let calls = 0;
  const write: WorkerStatsWriter = async (sessions) => {
    calls += 1;
    if (calls === 1) {
      entered.release();
      await blocked.promise;
    }
    received.push(...sessions.map((session) => session.id));
  };
  recorder.observe([worker("first")], 500);
  const first = recorder.flush(write);
  await entered.promise;
  recorder.observe([worker("first"), worker("later")], 700);
  const second = recorder.flush(write);
  try {
    assert.equal(calls, 1);
  } finally {
    blocked.release();
    await Promise.all([first, second]);
  }
  assert.deepEqual(received, ["first", "later"]);
});

test("T-253: bursts cross the existing 200-session service boundary without losing the suffix", async () => {
  const recorder = new ZaicodeWorkerStatsRecorder();
  const sizes: number[] = [];
  const durable = new Set<string>();
  recorder.observe(
    Array.from({ length: 450 }, (_, index) => worker(`burst-${index}`)),
    500,
  );
  await recorder.flush(async (sessions) => {
    sizes.push(sessions.length);
    // 真实服务的现有上限；不能用无限接受的 stub 掩盖丢失的后缀。
    for (const session of sessions.slice(0, 200)) durable.add(session.id);
  });
  assert.equal(durable.size, 450);
  assert.deepEqual(sizes, [200, 200, 50]);
});

test("T-253: an arrival between the drain and promise cleanup is still delivered", async () => {
  const recorder = new ZaicodeWorkerStatsRecorder();
  const arrived = gate();
  const received: string[] = [];
  let later: Promise<void> | undefined;
  const write: WorkerStatsWriter = async (sessions) => {
    received.push(...sessions.map((session) => session.id));
    if (sessions[0]?.id === "cleanup-first") {
      queueMicrotask(() =>
        queueMicrotask(() => {
          recorder.observe([worker("cleanup-first"), worker("cleanup-later")], 700);
          later = recorder.flush(write);
          arrived.release();
        }),
      );
    }
  };
  recorder.observe([worker("cleanup-first")], 500);
  const first = recorder.flush(write);
  await arrived.promise;
  await first;
  await later;
  assert.deepEqual(received, ["cleanup-first", "cleanup-later"]);
});

test("T-253: 100000 completed/disappeared workers leave zero acknowledged history", async () => {
  const recorder = new ZaicodeWorkerStatsRecorder();
  let received = 0;
  const write: WorkerStatsWriter = async (sessions) => {
    received += sessions.length;
  };
  for (let offset = 0; offset < 100_000; offset += 100) {
    recorder.observe(
      Array.from({ length: 100 }, (_, index) => worker(`history-${offset + index}`)),
      500,
    );
    await recorder.flush(write);
    recorder.observe([], 900);
    await recorder.flush(write);
  }
  assert.equal(received, 100_000);
  assert.equal(recorder.retainedWorkerCount, 0);
});

test("T-253: an evicted old id may replay and durable deduplication stays authoritative", async () => {
  const recorder = new ZaicodeWorkerStatsRecorder();
  const durable = new Map<string, ZaicodeStatsWorkerSession>();
  let calls = 0;
  const write: WorkerStatsWriter = async (sessions) => {
    calls += 1;
    for (const session of sessions) if (!durable.has(session.id)) durable.set(session.id, session);
  };
  recorder.observe([worker("replayed")], 500);
  await recorder.flush(write);
  recorder.observe([], 900);
  await recorder.flush(write);
  recorder.observe([worker("replayed")], 500);
  await recorder.flush(write);
  assert.equal(calls, 2);
  assert.deepEqual([...durable.values()], [expected("replayed")]);
});
