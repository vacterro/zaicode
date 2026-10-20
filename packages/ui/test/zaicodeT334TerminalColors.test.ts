import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as composedInput from "../src/terminal/terminalComposedInputFallback.js";
import * as dataTransform from "../src/terminal/terminalDataTransform.js";
import * as registryModule from "../src/terminal/sidePaneTerminalSessionRegistry.js";
import * as outputTap from "../src/terminal/terminalOutputTap.js";

const registry = registryModule.sidePaneTerminalSessionRegistry;
function compile(path: string) {
  return ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
}
const terminalCode = compile("../src/terminal/TerminalSession.tsx");
const workerCode = compile("../src/zaicode/ZaicodeWorkerParts.tsx");
const noop = () => undefined;
const disposable = () => ({ dispose() {} });
const jsx = (type: unknown, props: unknown) => ({ type, props });

class ElementPort {
  parentElement: ElementPort | null = null;
  className = "";
  clientWidth = 500;
  clientHeight = 300;
  style = { display: "" };
  appendChild(child: ElementPort) { child.parentElement = this; }
  getAttribute() { return null; }
  setAttribute() {}
  remove() { this.parentElement = null; }
}

async function fixture(suppress: boolean) {
  const key = "t334-" + suppress;
  const container = new ElementPort();
  const effects: (() => unknown)[] = [];
  const handlers = new Map<number, (data: string) => boolean>();
  const writes: string[] = [], fallbacks: string[] = [];
  let output: ((data: string) => void) | undefined, input: ((data: string) => void) | undefined;
  let exit: (() => void) | undefined, refCount = 0, pending = "";
  const terminal = {
    cols: 80, rows: 24, options: {}, loadAddon: noop, open: noop, focus: noop, refresh: noop,
    attachCustomKeyEventHandler: noop, registerLinkProvider: disposable, dispose: noop,
    parser: { registerOscHandler(id: number, handler: (data: string) => boolean) {
      handlers.set(id, handler);
      return { dispose() { handlers.delete(id); } };
    } },
    onData(listener: (data: string) => void) { input = listener; return disposable(); },
    write(data: string) {
      pending += data;
      // eslint-disable-next-line no-control-regex -- exact terminal protocol bytes in the parser port
      pending = pending.replace(/\x1b\](\d+);([^\x07\x1b]*)(?:\x07|\x1b\\)/g, (sequence, rawId, payload) => {
        const id = Number(rawId);
        if (!handlers.get(id)?.(payload)) {
          fallbacks.push(sequence);
          if ((id === 10 || id === 11) && payload === "?") input?.(`\x1b]${id};rgb:d4d4/c8c8/9a9a\x1b\\`);
        }
        return "";
      });
    },
  };
  class ObserverPort { observe() {} disconnect() {} }
  const documentPort = { createElement: () => new ElementPort(), documentElement: new ElementPort(), body: new ElementPort() };
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { value: documentPort, configurable: true });
  const modules: Record<string, unknown> = {
    react: { useCallback: (fn: unknown) => fn, useEffect: (fn: () => unknown) => effects.push(fn),
      useRef: (initial: unknown) => ({ current: refCount++ === 0 ? container : initial }) },
    "react/jsx-runtime": { jsx, jsxs: jsx }, "@xterm/xterm": { Terminal: function () { return terminal; } },
    "@xterm/addon-fit": { FitAddon: class { fit() {} } }, "@xterm/addon-clipboard": { ClipboardAddon: class {} },
    "lucide-react": {}, "@/i18n/IntlProvider.js": { useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }) },
    "@/logger.js": { logger: { info: noop, debug: noop, error: noop, warn: noop } },
    "@/components/ui/context-menu.js": {}, "@/terminal/terminalComposedInputFallback.js": composedInput,
    "@/terminal/terminalDataTransform.js": dataTransform, "@/terminal/terminalLinks.js": { getHttpLinksForTerminalBufferLine: () => [] },
    "@/terminal/terminalTheme.js": { mergeTerminalTheme: () => ({}) }, "@/terminal/terminalOutputTap.js": outputTap,
    "@/terminal/sidePaneTerminalSessionRegistry.js": registryModule,
  };
  const terminalService = {
    create: async () => ({ id: "native-" + key, shell: "pwsh" }),
    write: async ({ data }: { data: string }) => { writes.push(data); }, resize: async () => {}, dispose: async () => {},
    onDynamicData: () => (listener: (data: string) => void) => { output = listener; return disposable(); },
    onDynamicExit: () => (listener: () => void) => { exit = listener; return disposable(); },
  };
  const exports: Record<string, (props: unknown) => unknown> = {};
  runInNewContext(terminalCode, { exports, require: (name: string) => {
    assert.ok(name in modules, name); return modules[name];
  }, document: documentPort, window: { setTimeout: () => 1, clearTimeout: noop },
  setTimeout: () => 1, clearTimeout: noop, requestAnimationFrame: () => 1, cancelAnimationFrame: noop,
  performance, MutationObserver: ObserverPort, ResizeObserver: ObserverPort });
  exports.TerminalSession({ sessionId: key, persistentKey: key, services: { terminalService }, isVisible: true,
    isWindowsDesktop: false, suppressDynamicColorQueries: suppress, onShellLabelChange: noop, onOpenBrowserUrl: noop });
  const cleanups = effects.map(effect => effect()).filter(value => typeof value === "function") as (() => void)[];
  await Promise.resolve(); await Promise.resolve();
  assert.ok(output); assert.ok(input); assert.ok(exit);
  return { key, container, handlers, writes, fallbacks,
    output: (data: string) => output!(data), input: (data: string) => input!(data), exit: () => exit!(),
    cleanup() { registry.clearForTest(); cleanups.forEach(fn => fn());
      if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument); else Reflect.deleteProperty(globalThis, "document"); },
  };
}

test("only real Windows Codex workers opt out of dynamic default-color replies", () => {
  for (const [platform, vendor, kind, expected] of [
    ["Windows", "codex", "worker", true], ["Linux", "codex", "worker", false],
    ["Macintosh", "codex", "worker", false], ["Windows", "claude", "worker", false],
    ["Windows", "codex", "shell", false], ["Windows", "zcode", "worker", false],
  ] as const) {
    const TerminalSession = () => null;
    const modules: Record<string, unknown> = {
      "react/jsx-runtime": { jsx, jsxs: jsx }, "@/terminal/TerminalSession.js": { TerminalSession },
      "./zaicodeWorkerPrefs.js": { useZaicodeWorkerPrefs: () => ({ font: "profile" }), zaicodeWorkerFontFamily: () => undefined },
    };
    const exports: Record<string, (props: unknown) => unknown> = {};
    runInNewContext(workerCode, { exports, navigator: { userAgent: platform },
      require: (name: string) => modules[name] ?? {},
    });
    const tree = exports.ZaicodeWorkerTerminal({ worker: { id: "scope", vendor, kind }, services: {}, visible: true }) as { props: { children: { props: { children: { type: unknown; props: { suppressDynamicColorQueries?: boolean } } } }[] } };
    const child = tree.props.children[0].props.children;
    assert.equal(child.type, TerminalSession);
    assert.equal(Boolean(child.props.suppressDynamicColorQueries), expected, `${platform}/${vendor}/${kind}`);
  }
});

test("split and repeated OSC 10/11 queries produce no unsolicited native input", async () => {
  const f = await fixture(true);
  try {
    f.output("\x1b]10;"); f.output("?\x1b\\\x1b]11;?\x07");
    f.output("\x1b]10;?\x07\x1b]11;?\x1b\\");
    assert.deepEqual(f.writes, []);
    assert.equal(f.handlers.get(10)?.("?;?"), true);
  } finally { f.cleanup(); }
});

test("setters, mixed payloads and unrelated OSC remain with their existing handlers", async () => {
  const f = await fixture(true);
  try {
    for (const id of [10, 11]) {
      assert.equal(f.handlers.get(id)?.("rgb:1111/2222/3333"), false);
      assert.equal(f.handlers.get(id)?.("?;rgb:1111/2222/3333"), false);
    }
    f.output("\x1b]10;#d4c89a\x07\x1b]11;#1a1810\x07\x1b]2;title\x07");
    assert.equal(f.fallbacks.length, 3);
    assert.deepEqual(f.writes, []);
  } finally { f.cleanup(); }
});

test("detach retains parser policy and literal Escape/user/control input remains exact", async () => {
  const f = await fixture(true);
  try {
    const control = outputTap.terminalControl(f.key)!;
    registry.detachDom(f.key, f.container);
    f.output("\x1b]11;?\x1b\\"); f.input("\x1b"); f.input("pasted rgb:text"); control.write("cc\r");
    assert.deepEqual(f.writes, ["\x1b", "pasted rgb:text", "cc\r"]);
    f.exit(); f.input("stale"); control.write("stale");
    assert.equal(f.writes.length, 3);
    registry.release(f.key);
    assert.equal(f.handlers.size, 0);
  } finally { f.cleanup(); }
});

test("terminals without the policy retain their normal dynamic-color replies", async () => {
  const f = await fixture(false);
  try {
    f.output("\x1b]10;?\x1b\\\x1b]11;?\x07");
    assert.equal(f.handlers.size, 0);
    assert.equal(f.writes.length, 2);
    assert.ok(f.writes.every(data => data.includes("rgb:")));
  } finally { f.cleanup(); }
});
