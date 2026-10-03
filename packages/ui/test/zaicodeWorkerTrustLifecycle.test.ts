import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { emitTerminalOutput, registerTerminalControl } from "../src/terminal/terminalOutputTap.js";
import { startZaicodeWorkerWatch } from "../src/zaicode/zaicodeWorkerWatch.js";
import { launchZaicodeWorker, markZaicodeWorkerExited, removeZaicodeWorker } from "../src/zaicode/zaicodeWorkers.js";
import type { ZaicodeEngineAccount } from "@zcode/shared";

const menu = "\x1b[2JHooks need review\n> 1. Review hooks\n  2. Trust all and continue\n  3. Continue without trusting (hooks won't run)";
const account: ZaicodeEngineAccount = { id: "fixture-trust", short: "C1", label: "Codex fixture", vendor: "codex", source: "fixture", home: null, isDefaultHome: true, cli: "codex", status: "ready", statusDetail: "", fixCommand: null };

async function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000_000 });
  const saved = Object.getOwnPropertyDescriptor(globalThis, "window");
  const storage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
  const fakeWindow = Object.assign(new EventTarget(), { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, localStorage: storage, innerWidth: 1280, innerHeight: 800 });
  Object.defineProperty(globalThis, "window", { value: fakeWindow, configurable: true });
  const launched = await launchZaicodeWorker({ account, projectPath: "C:/trust-fixture", prompt: "", workerId: "trust-fixture-worker" });
  assert.equal(launched.ok, true);
  const id = launched.worker!.id;
  const writes: string[] = [];
  const controls: (() => void)[] = [];
  controls.push(registerTerminalControl(id, { write: (input) => writes.push(input), redraw: () => undefined }));
  const off = startZaicodeWorkerWatch();
  t.after(() => {
    off(); controls.forEach((close) => close()); removeZaicodeWorker(id);
    if (saved) Object.defineProperty(globalThis, "window", saved); else Reflect.deleteProperty(globalThis, "window");
    t.mock.timers.reset();
  });
  return { id, writes, controls, output: (data = menu) => emitTerminalOutput(id, data), scan: () => t.mock.timers.tick(400), reply: () => t.mock.timers.tick(600) };
}

test("the actual terminal watcher trusts hooks after five hours and after more than two prompts", async (t) => {
  const f = await fixture(t);
  t.mock.timers.tick(5 * 60 * 60 * 1000);
  for (let i = 0; i < 5; i++) { f.output(); f.scan(); f.reply(); }
  assert.deepEqual(f.writes, Array(5).fill("\x1b[B\r"));
});

test("a delayed reply cannot reach a transferred PTY, an exited run, or a replacement generation", async (t) => {
  const f = await fixture(t);
  f.output(); f.scan();
  const transferred: string[] = [];
  f.controls.push(registerTerminalControl(f.id, { write: (input) => transferred.push(input), redraw: () => undefined }));
  f.reply();
  assert.deepEqual(f.writes, []); assert.deepEqual(transferred, []);
  f.output(); f.scan(); markZaicodeWorkerExited(f.id, 0); f.reply();
  assert.deepEqual(transferred, []);
  removeZaicodeWorker(f.id);
  await launchZaicodeWorker({ account, projectPath: "C:/trust-fixture", prompt: "", workerId: f.id, generation: 2 });
  f.output(); f.scan();
  removeZaicodeWorker(f.id);
  await launchZaicodeWorker({ account, projectPath: "C:/trust-fixture", prompt: "", workerId: f.id, generation: 3 });
  f.reply();
  assert.deepEqual(transferred, []);
});

test("repainting to unrelated prose cancels trust input and unowned output is ignored", async (t) => {
  const f = await fixture(t);
  f.output(); f.scan();
  f.output("\x1b[2JWorking on the requested code. Trust all and continue is a quoted menu option.");
  f.reply();
  emitTerminalOutput("some-other-terminal", menu); f.scan(); f.reply();
  assert.deepEqual(f.writes, []);
});

test("worker dispatch rechecks cancellation after prompt preparation and rejects another owner's lease", async (t) => {
  const f = await fixture(t);
  const wrongOwner = await launchZaicodeWorker({ account: { ...account, id: "other-account" }, projectPath: "C:/trust-fixture", prompt: "", workerId: f.id });
  assert.equal(wrongOwner.ok, false);
  const cancelled = await launchZaicodeWorker({ account, projectPath: "C:/trust-fixture", prompt: "", workerId: "cancelled-fixture", canDispatch: () => false });
  assert.equal(cancelled.ok, false);
  assert.match(cancelled.message, /cancelled/);
});
