import assert from "node:assert/strict";
import test from "node:test";
import { registerTerminalControl, terminalControl } from "../src/terminal/terminalOutputTap.js";
import { extractZaicodeWorker } from "../src/zaicode/zaicodeWorkerExtraction.js";

test("the worker presentation is removed only after the terminal confirms handoff", async () => {
  let complete!: (value: { pid: number }) => void;
  let calls = 0;
  const unregister = registerTerminalControl("handoff-fixture", {
    write: () => {},
    redraw: () => {},
    extractToPowerShell: () => {
      calls++;
      return new Promise((resolve) => {
        complete = resolve;
      });
    },
  });
  const worker = { id: "handoff-fixture", generation: 1, exitCode: null };
  let removed = false;
  try {
    const dependencies = {
      read: () => [worker],
      remove: () => {
        removed = true;
      },
    };
    const first = extractZaicodeWorker(worker, dependencies);
    const second = extractZaicodeWorker(worker, dependencies);
    assert.equal(calls, 1);
    assert.equal(removed, false);
    complete({ pid: 42 });
    assert.deepEqual(await first, { pid: 42 });
    await second;
    assert.equal(removed, true);
  } finally {
    unregister();
  }
});

test("failed handoff and stale generations never remove the current worker", async () => {
  let removed = 0;
  const worker = { id: "failure-fixture", generation: 1, exitCode: null };
  let current = worker;
  const dependencies = {
    read: () => [current],
    remove: () => {
      removed++;
    },
  };
  let unregister = registerTerminalControl(worker.id, {
    write: () => {},
    redraw: () => {},
    extractToPowerShell: async () => {
      throw new Error("no console");
    },
  });
  await assert.rejects(extractZaicodeWorker(worker, dependencies), /no console/);
  assert.equal(removed, 0);
  unregister();
  unregister = registerTerminalControl(worker.id, {
    write: () => {},
    redraw: () => {},
    extractToPowerShell: async () => {
      current = { ...worker, generation: 2 };
      return { pid: 8 };
    },
  });
  await extractZaicodeWorker(worker, dependencies);
  assert.equal(removed, 0);
  unregister();
  assert.equal(terminalControl(worker.id), null);
  await assert.rejects(extractZaicodeWorker(worker, dependencies), /unavailable/);
  await assert.rejects(extractZaicodeWorker({ ...current, exitCode: 0 }, dependencies), /exited/);
});
