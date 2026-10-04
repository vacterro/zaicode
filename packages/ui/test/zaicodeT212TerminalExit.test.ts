import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as composedInput from "../src/terminal/terminalComposedInputFallback.js";
import * as dataTransform from "../src/terminal/terminalDataTransform.js";
import * as registryModule from "../src/terminal/sidePaneTerminalSessionRegistry.js";
import * as outputTap from "../src/terminal/terminalOutputTap.js";

const require = createRequire(import.meta.url);
const registry = registryModule.sidePaneTerminalSessionRegistry;
const source = readFileSync(new URL("../src/terminal/TerminalSession.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

class ElementPort {
  parentElement: ElementPort | null = null;
  className = "";
  value = "";
  clientWidth = 500;
  clientHeight = 300;
  style = { display: "" };
  listeners = new Map<string, (event: unknown) => void>();
  appendChild(child: ElementPort) { child.parentElement = this; }
  getAttribute() { return null; }
  setAttribute() {}
  addEventListener(name: string, listener: (event: unknown) => void) { this.listeners.set(name, listener); }
  removeEventListener(name: string) { this.listeners.delete(name); }
  remove() { this.parentElement = null; }
}

async function fixture(key: string, onExit?: () => void, initialInput?: string) {
  const container = new ElementPort(), textarea = new ElementPort();
  const effects: (() => unknown)[] = [], refs: { current: unknown }[] = [];
  const timers = new Map<number, () => void>();
  const writes: string[] = [], warnings: unknown[][] = [];
  let timerId = 0, data: ((text: string) => void) | undefined, exit: (() => void) | undefined;
  let nativeInput: ((text: string) => void) | undefined;
  let acknowledge: (() => void) | undefined;
  const dispose = () => ({ dispose() {} });
  const terminal = {
    cols: 80, rows: 24, options: {}, output: [] as string[],
    _core: { textarea }, loadAddon() {}, open() {}, focus() {}, refresh() {},
    attachCustomKeyEventHandler() {}, registerLinkProvider: dispose,
    onData(listener: (text: string) => void) { nativeInput = listener; return dispose(); },
    write(text: string) { this.output.push(text); }, dispose() {},
  };
  class ObserverPort { observe() {} disconnect() {} }
  const documentPort = { createElement: () => new ElementPort(), documentElement: new ElementPort(), body: new ElementPort() };
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { value: documentPort, configurable: true });
  const modules: Record<string, unknown> = {
    react: {
      useCallback: (fn: unknown) => fn,
      useEffect: (fn: () => unknown) => effects.push(fn),
      useRef: (initial: unknown) => { const ref = { current: refs.length === 0 ? container : initial }; refs.push(ref); return ref; },
    },
    "react/jsx-runtime": { jsx: () => null, jsxs: () => null },
    "@xterm/xterm": { Terminal: function () { return terminal; } },
    "@xterm/addon-fit": { FitAddon: class { fit() {} } },
    "@xterm/addon-clipboard": { ClipboardAddon: class {} },
    "lucide-react": { ClipboardPaste: () => null, Copy: () => null },
    "@/i18n/IntlProvider.js": { useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }) },
    "@/logger.js": { logger: { info() {}, debug() {}, error() {}, warn: (...args: unknown[]) => warnings.push(args) } },
    "@/components/ui/context-menu.js": {},
    "@/terminal/terminalComposedInputFallback.js": composedInput,
    "@/terminal/terminalDataTransform.js": dataTransform,
    "@/terminal/terminalLinks.js": { getHttpLinksForTerminalBufferLine: () => [] },
    "@/terminal/terminalTheme.js": { mergeTerminalTheme: () => ({}) },
    "@/terminal/terminalOutputTap.js": outputTap,
    "@/terminal/sidePaneTerminalSessionRegistry.js": registryModule,
  };
  const exports: Record<string, (props: unknown) => unknown> = {};
  const timeout = (fn: () => void) => { timers.set(++timerId, fn); return timerId; };
  const terminalService = {
    create: async () => ({ id: "native-" + key, shell: "pwsh", fontFamily: "fixture" }),
    write: ({ data: input }: { data: string }) => {
      writes.push(input);
      if (initialInput && input === initialInput + "\r") return new Promise<void>(resolve => { acknowledge = resolve; });
      return Promise.resolve();
    },
    resize: async () => {}, dispose: async () => {},
    onDynamicData: () => (listener: (text: string) => void) => { data = listener; return dispose(); },
    onDynamicExit: () => (listener: () => void) => { exit = listener; return dispose(); },
  };
  runInNewContext(compiled, {
    exports, require: (name: string) => name in modules ? modules[name] : require(name),
    document: documentPort, window: { setTimeout: timeout, clearTimeout: (id: number) => timers.delete(id) },
    setTimeout: timeout, clearTimeout: (id: number) => timers.delete(id),
    requestAnimationFrame: () => 1, cancelAnimationFrame() {}, performance,
    MutationObserver: ObserverPort, ResizeObserver: ObserverPort,
  });
  exports.TerminalSession({ sessionId: key, persistentKey: key, cwd: "fixture", isVisible: true,
    isWindowsDesktop: true, services: { terminalService }, onShellLabelChange() {},
    onOpenBrowserUrl() {}, onExit, initialInput,
  });
  const cleanups = effects.map(effect => effect()).filter(value => typeof value === "function") as (() => void)[];
  await Promise.resolve(); await Promise.resolve();
  assert.ok(registry.get(key)); assert.ok(nativeInput); assert.ok(exit);
  return {
    writes, warnings, terminal, container, textarea,
    input: (text: string) => nativeInput!(text), exit: () => exit!(),
    acknowledge: () => acknowledge!(),
    output: (text: string) => data!(text),
    flushTimers: () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } },
    ime: (text: string) => { textarea.value = text; textarea.listeners.get("input")!({ inputType: "insertText", data: text, composed: true }); },
    cleanup() {
      registry.clearForTest(); cleanups.forEach(fn => fn());
      if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument); else Reflect.deleteProperty(globalThis, "document");
    },
  };
}

test("native exit retires controls before notification and fences captured xterm input", async () => {
  const key = "t212-exit";
  let controlAtExit: unknown;
  const f = await fixture(key, () => { controlAtExit = outputTap.terminalControl(key); });
  try {
    const control = outputTap.terminalControl(key)!;
    f.input("live typing"); control.write("live automation");
    assert.deepEqual(f.writes, ["live typing", "live automation"]);
    f.output("final output"); f.exit();
    f.input("late terminal reply"); control.write("captured stale control");
    assert.equal(controlAtExit, null);
    assert.equal(outputTap.terminalControl(key), null);
    assert.deepEqual(f.writes, ["live typing", "live automation"]);
    assert.ok(registry.get(key), "final terminal history remains registered");
    assert.deepEqual(f.terminal.output, ["final output"]);
  } finally { f.cleanup(); }
});

test("exit fences an already scheduled IME fallback without destroying final history", async () => {
  const key = "t212-ime";
  const f = await fixture(key);
  try {
    f.ime("live IME"); f.flushTimers();
    assert.deepEqual(f.writes, ["live IME"]);
    f.ime("pending at exit"); f.exit(); f.flushTimers();
    assert.deepEqual(f.writes, ["live IME"]);
    assert.ok(registry.get(key));
    assert.ok(f.terminal.output.includes("\r\nterminal.exited\r\n"));
  } finally { f.cleanup(); }
});

test("detach preserves live input but release fences captured control and pending IME", async () => {
  const key = "t212-release";
  const f = await fixture(key);
  try {
    const control = outputTap.terminalControl(key)!;
    registry.detachDom(key, f.container); control.write("detached live");
    registry.attachDom(key, f.container); f.input("reattached live");
    assert.deepEqual(f.writes, ["detached live", "reattached live"]);
    f.ime("pending at release"); registry.release(key);
    control.write("stale release"); f.flushTimers();
    assert.deepEqual(f.writes, ["detached live", "reattached live"]);
    assert.equal(outputTap.terminalControl(key), null);
  } finally { f.cleanup(); }
});

test("a startup acknowledgement arriving after exit cannot publish a new dead control", async () => {
  const key = "t212-start-ack";
  const f = await fixture(key, undefined, "start fixture");
  try {
    f.flushTimers(); assert.deepEqual(f.writes, ["start fixture\r"]);
    f.exit(); f.acknowledge(); await Promise.resolve(); await Promise.resolve();
    assert.equal(outputTap.terminalControl(key), null);
    f.flushTimers(); assert.deepEqual(f.writes, ["start fixture\r"]);
  } finally { f.cleanup(); }
});
