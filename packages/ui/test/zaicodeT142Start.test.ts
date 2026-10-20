import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { planZaicodeStart, zaicodeStartCopy } from "../src/prompt-editor/zaicodeStartPlan.js";

/**
 * T-318 (SRC-230): the composer START button no longer opens a new session.
 * A plain click sends `/goal cc all` in the session that has focus, submitted
 * like any other command; Shift+click empties THAT session and sends the goal
 * once the clear is acknowledged -- never a fresh session, and never the goal
 * racing the wipe it was asked to follow.
 *
 * The gesture tests run the real `start` callback from the subject component
 * against deterministic owner ports, with the real planner, so the behavior is
 * checked where it lives instead of in a copy of it.
 * `ZAICODE_T142_START_SUBJECT` points the harness at another copy of the
 * component (the red control: HEAD of this file, before T-318).
 */
function harness({ engine = false, disabled = false, sessionId = "current" } = {}) {
  const source = readFileSync(
    process.env.ZAICODE_T142_START_SUBJECT ??
      new URL("../src/prompt-editor/ZaicodeSaipenControls.tsx", import.meta.url),
    "utf8",
  );
  const ast = ts.createSourceFile("controls.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let startCallback: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "start") startCallback = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(startCallback, "the START button has one handler");
  const calls: string[] = [];
  const script = `const start = (${startCallback.getText(ast)});\n({ start });`;
  const evaluated = runInNewContext(
    ts.transpileModule(script, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
    {
      planZaicodeStart,
      engineAccount: engine ? { id: "paid", short: "PAID", label: "Paid engine" } : null,
      disabled,
      sessionId,
      workspacePath: "project",
      workspaceIdentity: "identity",
      mainKey: "identity",
      ZAICODE_SAIPEN_START_COMMAND: "/goal cc all",
      sendWork: (command: string) => calls.push(`current:${command}`),
      onCommand: (command: string) => calls.push(`draft:${command}`),
      armMain: () => calls.push("arm-main"),
      openFreshSession: (_path: string, _identity: string, command: string) =>
        calls.push(`fresh:${command}`),
      requestClear: (sessionId: string, after?: string) => calls.push(`clear:${sessionId}:${after ?? "-"}`),
      routeZaicodeSubscriptionPrompt: () => calls.push("worker"),
    },
  ) as { start: (event?: { shiftKey: boolean }) => void };
  return { calls, start: evaluated.start };
}

/** The component under test, so the red control can swap in another copy of it. */
const subject = () =>
  readFileSync(
    process.env.ZAICODE_T142_START_SUBJECT ??
      new URL("../src/prompt-editor/ZaicodeSaipenControls.tsx", import.meta.url),
    "utf8",
  );

const src = (path: string) => readFileSync(join(import.meta.dirname, "..", "src", path), "utf8");

test("plain START sends the goal in THIS session, and the hotkey is the same gesture", () => {
  const plain = harness();
  plain.start({ shiftKey: false });
  assert.deepEqual(plain.calls, ["current:/goal cc all"], "no fresh session is opened any more");
  const hotkey = harness();
  hotkey.start();
  assert.deepEqual(hotkey.calls, plain.calls, "the hotkey keeps the default gesture");
  const draft = harness({ sessionId: "" });
  draft.start({ shiftKey: false });
  assert.deepEqual(draft.calls, ["current:/goal cc all"], "a draft sends here too");
});

test("Shift START empties THIS session and carries the goal into it afterwards", () => {
  const shifted = harness();
  shifted.start({ shiftKey: true });
  assert.deepEqual(shifted.calls, ["clear:current:/goal cc all"], "the wipe owns the command that follows");
  const draft = harness({ sessionId: "" });
  draft.start({ shiftKey: true });
  assert.deepEqual(draft.calls, ["current:/goal cc all"], "a draft has nothing to clear");
});

test("plain START keeps the subscription worker route and Shift keeps admission", () => {
  const worker = harness({ engine: true });
  worker.start();
  assert.deepEqual(worker.calls, ["worker"], "a picked engine still gets its worker on a plain click");
  const blocked = harness({ disabled: true });
  blocked.start({ shiftKey: true });
  assert.deepEqual(blocked.calls, [], "a composer that cannot submit does nothing");
});

test("the planner keeps admission, the worker route, and Shift meaning this session", () => {
  assert.equal(planZaicodeStart({ shiftKey: false, disabled: true, sessionId: "s", engineAccount: null }).kind, "skip");
  assert.equal(planZaicodeStart({ shiftKey: true, disabled: true, sessionId: "s", engineAccount: null }).kind, "skip");
  assert.equal(planZaicodeStart({ shiftKey: false, disabled: false, sessionId: "s", engineAccount: { id: "paid" } }).kind, "worker");
  assert.equal(planZaicodeStart({ shiftKey: false, disabled: false, sessionId: "s", engineAccount: null }).kind, "send");
  assert.equal(planZaicodeStart({ shiftKey: true, disabled: false, sessionId: "s", engineAccount: null }).kind, "clearThenSend");
  assert.equal(
    planZaicodeStart({ shiftKey: true, disabled: false, sessionId: "s", engineAccount: { id: "paid" } }).kind,
    "clearThenSend",
    "Shift always means this session, never the subscription worker",
  );
  assert.equal(planZaicodeStart({ shiftKey: true, disabled: false, sessionId: "", engineAccount: null }).kind, "send");
});

test("a refused clear never fires the goal into the session that was to be wiped", () => {
  const pane = src("v4/SessionPane.tsx");
  const dispatch = pane.indexOf('dispatchCommand("clearConversation"');
  assert.ok(dispatch > 0, "the pane owns the in-place clear");
  const chain = pane.slice(dispatch, pane.indexOf(".catch(", dispatch));
  const rejection = chain.indexOf('ack.status !== "accepted"');
  const bail = chain.indexOf("return;", rejection);
  const armed = chain.indexOf("armZaicodeAfterClear(sessionId, after)");
  assert.ok(rejection > 0, "the ack is inspected");
  assert.ok(bail > rejection, "a rejected clear bails out");
  assert.ok(armed > bail, "only an accepted clear arms the follow-up");
});

test("the follow-up is delivered to the composer that owns the session, not to the pane", () => {
  const strip = subject();
  assert.match(strip, /takeAfterClear\(sessionId\)/, "the composer submits it like any command");
  assert.match(strip, /afterClear\.sessionId !== sessionId/, "another session's follow-up is not stolen");
  assert.doesNotMatch(strip, /fresh MAIN session/, "the copy no longer promises a new session");
  const store = src("zaicode/zaicodeSaipen.ts");
  assert.match(store, /after\?: string;/, "the clear request can carry the command that follows it");
  assert.match(store, /export const useZaicodeAfterClear = create</, "the follow-up has its own channel");
  assert.match(store, /current\.sessionId !== sessionId/, "the channel is scoped to one session");
});

test("the button's words describe the gesture it performs", () => {
  const copy = zaicodeStartCopy(null);
  assert.match(copy.compact, /in THIS session/, "a plain click acts here");
  assert.match(copy.compact, /Shift\+click: clears this session first/, "Shift empties this session first");
  assert.match(copy.title, /no new one/, "the tooltip says no session is created");
  const worker = zaicodeStartCopy({ short: "PAID", label: "Paid engine" });
  assert.match(worker.aria, /as a worker/, "the worker route keeps its own words");
  assert.match(worker.title, /Shift\+click: empties THIS session/, "Shift is described for the worker route too");
});
