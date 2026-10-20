import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

function fixture() {
  const children: Child[] = [];
  const timers = new Map<number, () => void>();
  const registered = new Set<Child>();
  const dispatched: unknown[] = [];
  let sequence = 0;
  class Child extends EventEmitter {
    pid = 1000 + children.length;
    messages: unknown[] = [];
    postMessage(message: unknown) {
      this.messages.push(message);
      if ((message as { type?: string }).type === "scheduler-dispose")
        queueMicrotask(() => this.emit("exit", 0));
    }
    kill() {
      this.emit("exit", 0);
    }
  }
  const source = readFileSync(
    new URL("../src/main/desktopCronScheduler.ts", import.meta.url),
    "utf8",
  );
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = {
    exports: {} as {
      spawnCronScheduler: (deps: unknown) => {
        wake: (id: string) => void;
        dispose: () => Promise<void>;
        handleCronRunResult: (result: unknown) => void;
      };
    },
  };
  const require = (id: string) => {
    if (id === "electron")
      return {
        utilityProcess: {
          fork: () => {
            const child = new Child();
            children.push(child);
            return child;
          },
        },
      };
    if (id === "@zcode/shared")
      return { HostMessageTypes: { CronRun: "CronRun", OffPeakRun: "OffPeakRun" } };
    if (id.includes("desktopRuntimeEnv"))
      return { buildHostProcessEnv: () => ({}), schedulerModulePath: "fixture" };
    if (id.includes("processResourceSelfHeapSource"))
      return { ingestSchedulerSelfResourceSample: () => {} };
    if (id.includes("resourceManagerWindow"))
      return {
        registerSchedulerProcess: (child: Child) => registered.add(child),
        unregisterSchedulerProcess: (child: Child) => registered.delete(child),
      };
    throw Error(`Unexpected dependency ${id}`);
  };
  new Function("require", "module", "exports", "setTimeout", "clearTimeout", code)(
    require,
    module,
    module.exports,
    (callback: () => void) => {
      timers.set(++sequence, callback);
      return sequence;
    },
    (timer: number) => timers.delete(timer),
  );
  const handle = module.exports.spawnCronScheduler({
    hostProcessLocalEnv: {},
    logger: { info() {}, warn() {}, error() {} },
    resolveDispatchHost: () => ({ postMessage: (message: unknown) => dispatched.push(message) }),
  });
  const advance = () => {
    const pending = [...timers.values()];
    timers.clear();
    for (const callback of pending) callback();
  };
  return { handle, children, timers, registered, dispatched, advance };
}

test("unexpected scheduler exit recovers one child without a workspace click", async () => {
  const f = fixture();
  f.children[0]!.emit("exit", 99);
  assert.equal(f.registered.size, 0);
  f.advance();
  assert.equal(f.children.length, 2, "the process owner must restore the dead scheduler");
  assert.equal(f.registered.size, 1);
  f.handle.wake("due-work");
  assert.deepEqual(f.children[1]!.messages.at(-1), {
    type: "scheduler-wake",
    automationId: "due-work",
  });
  await f.handle.dispose();
  f.advance();
  assert.equal(f.children.length, 2, "dispose must not restart the scheduler");
});

test("wake during restart and stale messages cannot create a second scheduler or dispatch", async () => {
  const f = fixture();
  const old = f.children[0]!;
  old.emit("exit", 99);
  f.handle.wake("wake-now");
  f.advance();
  assert.equal(f.children.length, 2, "wake and backoff share the same process owner");
  old.emit("message", { type: "cron-dispatch-request", runId: "retired", automationId: "job" });
  assert.equal(f.dispatched.length, 0, "retired generations cannot dispatch");
  f.children[1]!.emit("message", {
    type: "cron-dispatch-request",
    runId: "current",
    automationId: "job",
  });
  assert.equal(f.dispatched.length, 1, "the current generation can dispatch");
  await f.handle.dispose();
});

test("dispose while restart is pending cancels the pending child", async () => {
  const f = fixture();
  f.children[0]!.emit("exit", 99);
  await f.handle.dispose();
  f.advance();
  f.handle.wake("after-dispose");
  assert.equal(f.children.length, 1);
});
