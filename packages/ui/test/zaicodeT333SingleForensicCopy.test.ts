import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import type { ZCodeSessionStateSnapshot } from "@zcode/shared";
import { ConversationSessionCopyButton } from "../src/v4/ConversationSessionCopyButton.js";
import { copySessionDriftEvidence } from "../src/zaicode/zaicodeSessionDriftCopy.js";

const target = { sessionId: "selected-A", workspacePath: "/project", workspaceIdentity: "workspace-A", remoteSessionId: "remote-attachment-A" };
const stamp = 1_791_500_000_000;
const noFiles = { async stat() { throw new Error("ENOENT"); }, async readFileRange() { throw new Error("ENOENT"); } };
function snapshot(count = 2011): ZCodeSessionStateSnapshot {
  return {
    protocol: { name: "ZCode Protocol", version: 1 },
    session: { sessionId: target.sessionId, workspace: { workspacePath: target.workspacePath, workspaceKey: target.workspaceIdentity, workspaceIdentity: target.workspaceIdentity }, title: "shared title", createdAt: stamp, updatedAt: stamp + count, mode: "yolo", status: "running", sessionKind: "main" },
    runtime: { eventSeq: 9000, stateRevision: 40, pendingRequestIds: [] }, settings: {}, projection: {},
    messages: Array.from({ length: count }, (_, i) => ({
      info: { messageId: `A-${i}`, sessionId: target.sessionId, role: i % 10 === 0 ? "user" : "assistant", time: { created: stamp + i }, agent: "fixture",
        semantics: i === 10 ? { origin: "agent_runtime", kind: "goal_continuation", source: "goal_autocontinuation" } : undefined },
      parts: Array.from({ length: i < 444 ? 4 : 3 }, (_, p) => ({ partId: `A-${i}-${p}`, messageId: `A-${i}`, sessionId: target.sessionId, type: "text", text: `BODY-A-${i}-${p}` })),
    })),
  } as unknown as ZCodeSessionStateSnapshot;
}
async function capture(source: ZCodeSessionStateSnapshot, extras: Record<string, unknown> = {}) {
  const calls: unknown[] = [], texts: string[] = [];
  let forbiddenReads = 0;
  const sessionService = {
    async readSession(params: unknown) { calls.push(params); return source; },
    async listSessions() { forbiddenReads++; throw new Error("historical enumeration"); },
    async readSessionMessages() { forbiddenReads++; throw new Error("alternate transcript"); },
  };
  const result = await copySessionDriftEvidence({ target, sessionService, fileService: noFiles,
    writeClipboardText: async text => { texts.push(text); }, isCurrent: () => true, now: () => stamp,
    ...extras,
  });
  return { result, text: texts[0], texts, calls, forbiddenReads };
}

test("T-333: default action preserves 2011 messages/6477 parts from first through last", async () => {
  const source = snapshot();
  assert.equal(source.messages.reduce((n, row) => n + row.parts.length, 0), 6477);
  const { text, result, forbiddenReads } = await capture(source);
  assert.equal(result.messages, 2011);
  assert.equal(result.characters, text.length);
  assert.equal((text.match(/^### Message /gm) ?? []).length, 2011);
  assert.equal((text.match(/^#### Part /gm) ?? []).length, 6477);
  assert.ok(text.indexOf("BODY-A-0-0") < text.indexOf("BODY-A-2010-2"));
  for (let i = 0; i < 2011; i++) assert.ok(text.includes(`BODY-A-${i}-0`), String(i));
  assert.ok(text.includes('"origin": "agent_runtime"'));
  assert.ok(text.includes('"eventSeq": 9000'));
  assert.equal(forbiddenReads, 0);
  assert.doesNotMatch(text, /bounded_recent_fallback|over-budget|characters omitted/);
});

test("T-333: obsolete compact overrides expose no alternate scope or truncation path", async () => {
  const { text, result } = await capture(snapshot(), { scope: "current-work", budgets: { maxCharacters: 20, maxRecentMessages: 1 } });
  assert.equal(result.messages, 2011);
  assert.ok(text.length > 40_000);
  assert.equal("scope" in result, false);
  assert.equal("boundary" in result, false);
});

test("T-333: selected remote binding reaches one authoritative non-restoring read", async () => {
  const { calls, texts } = await capture(snapshot(1));
  assert.deepEqual(calls, [{ ...target, repairImportedHistory: false }]);
  assert.equal(texts.length, 1);
});

test("T-333: snapshot watermark survives source advancement while context is pending", async () => {
  const source = snapshot(1);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const operation = capture(source, { fileService: { async stat() { await pending; throw new Error("ENOENT"); }, readFileRange: noFiles.readFileRange } });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  (source.messages[0].parts[0] as { text: string }).text = "AFTER-WATERMARK-REPLACEMENT";
  source.runtime.eventSeq++;
  release();
  const { text } = await operation;
  assert.ok(text.includes("BODY-A-0-0"));
  assert.ok(text.includes('"eventSeq": 9000'));
  assert.doesNotMatch(text, /AFTER-WATERMARK-REPLACEMENT/);
});

test("T-333: full long tool outputs and original errors survive without a text cap", async () => {
  const source = snapshot(1);
  const body = `OUTPUT-HEAD\n${"long 界 ``` body ".repeat(20_000)}\nOUTPUT-TAIL`;
  source.messages[0].parts = [{ partId: "tool-A", messageId: "A-0", sessionId: target.sessionId, type: "tool", callId: "call-A", tool: "Bash", state: { status: "error", input: { command: "fixture" }, error: body, metadata: { childSessionId: "child-E" }, title: "fixture", startedAt: stamp, completedAt: stamp + 1 } }] as never;
  const { text } = await capture(source);
  assert.ok(text.includes(body));
  assert.ok(text.includes("child-E"));
  assert.doesNotMatch(text, /characters omitted|BODY-SECRET-DELETED-B|BODY-SECRET-ARCHIVED-C/);
});

test("T-333: binary attachments remain references without fetching or inlining payload", async () => {
  const source = snapshot(1);
  const marker = "BINARY-SECRET-PAYLOAD-".repeat(12_000);
  source.messages[0].parts = [{ partId: "file-A", messageId: "A-0", sessionId: target.sessionId, type: "file", mime: "image/png", filename: "fixture.png", url: "data:image/png;base64," + marker }] as never;
  const { text, forbiddenReads } = await capture(source);
  assert.ok(text.includes("Attachment reference (bytes not inlined)"));
  assert.ok(text.includes("fixture.png"));
  assert.doesNotMatch(text, /BINARY-SECRET-PAYLOAD/);
  assert.equal(forbiddenReads, 0);
});

for (const kind of ["session", "workspace", "identity", "message", "part-session", "part-message"] as const) {
  test(`T-333: ${kind} mismatch leaves clipboard unchanged`, async () => {
    const source = snapshot(1);
    if (kind === "session") source.session.sessionId = "deleted-B";
    if (kind === "workspace") source.session.workspace.workspacePath = "/other";
    if (kind === "identity") source.session.workspace.workspaceIdentity = "archived-C";
    if (kind === "message") source.messages[0].info.sessionId = "same-title-D";
    if (kind === "part-session") source.messages[0].parts[0].sessionId = "child-E";
    if (kind === "part-message") source.messages[0].parts[0].messageId = "detached-F";
    let writes = 0;
    await assert.rejects(capture(source, { writeClipboardText: async () => { writes++; } }), /identity|session|workspace/i);
    assert.equal(writes, 0);
  });
}

test("T-333: empty and single-message snapshots remain complete without another-session fallback", async () => {
  for (const count of [0, 1]) {
    const { result, text, forbiddenReads } = await capture(snapshot(count));
    assert.equal(result.messages, count);
    assert.ok(text.includes(`${count} messages`));
    assert.equal(forbiddenReads, 0);
  }
});

test("T-333: deleted/read-failed/stale selections and clipboard failure never succeed", async () => {
  for (const kind of ["deleted", "read-failure", "stale", "clipboard-failure"]) {
    let writes = 0;
    const extras: Record<string, unknown> = {
      isCurrent: () => kind !== "stale",
      writeClipboardText: async () => { writes++; if (kind === "clipboard-failure") throw new Error(kind); },
    };
    if (kind === "deleted" || kind === "read-failure") extras.sessionService = { async readSession() { throw new Error(kind); } };
    await assert.rejects(capture(snapshot(1), extras), /deleted|read-failure|changed|cancelled|clipboard-failure/);
    assert.equal(writes, kind === "clipboard-failure" ? 1 : 0);
  }
});

test("T-333: one accessible Copy forensic button has honest final/loading/error feedback", () => {
  for (const [status, label] of [["idle", "Copy forensic"], ["reading", "Reading session"], ["copied", "Copied forensic"], ["error", "Copy failed"]] as const) {
    const html = renderToStaticMarkup(createElement(ConversationSessionCopyButton, { action: { enabled: true, onCopy: async () => {}, state: { status, detail: status === "copied" ? "2011 messages copied (100000 characters)" : undefined } } }));
    assert.equal((html.match(/<button\b/g) ?? []).length, 1);
    assert.ok(html.includes(label));
    assert.match(html, /aria-label="Copy forensic session"/);
    assert.doesNotMatch(html, /aria-haspopup|More session copy options|Copy work/);
    if (status === "reading") assert.match(html, /disabled/);
  }
});

test("T-333: ordinary copy click carries no obsolete scope argument", async () => {
  const calls: unknown[][] = [];
  const element = ConversationSessionCopyButton({ action: { enabled: true, onCopy: async (...args: unknown[]) => { calls.push(args); }, state: { status: "idle" } } });
  const find = (node: any): any => !node || typeof node !== "object" ? undefined : node.type === "button" ? node : [node.props?.children].flat().map(find).find(Boolean);
  const button = find(element);
  assert.ok(button); button.props.onClick(); await Promise.resolve();
  assert.deepEqual(calls, [[]]);
});

test("T-333: non-restoring service read never invokes imported-history repair", async () => {
  const path = new URL("../../services/src/zcode-session/zcodeSessionService.ts", import.meta.url);
  const code = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  let repairs = 0, creates = 0;
  const source = snapshot(0);
  const exports: Record<string, any> = {};
  const modules: Record<string, unknown> = {
    "#src/logger/serviceLogger.js": { createServiceLogger: () => ({ info() {}, warn() {} }) },
    "#src/zcode-session/zcodeSessionApiRetry.js": { createZCodeSessionApiRetryRuntimeTracker: () => ({ withApiRetryRuntime: (value: unknown) => value }) },
    "#src/zcode-session/zcodeSessionDraftRegistry.js": { createZCodeDeferredDraftRegistry: () => ({}) },
    "#src/zcode-session/importedClaudeSessionRepair.js": { repairEmptyImportedClaudeSessionSnapshot: async ({ snapshot: value }: any) => { repairs++; return value; } },
  };
  runInNewContext(code, { exports, require: (name: string) => modules[name] ?? {} });
  const service = exports.createZCodeSessionService({ agentService: { readSession: async () => source, createSession: async () => { creates++; } } });
  await service.readSession({ ...target, repairImportedHistory: false });
  assert.equal(repairs, 0); assert.equal(creates, 0);
  await service.readSession(target);
  assert.equal(repairs, 1, "ordinary read preserves the existing default repair policy");
});

function hookFixture() {
  const code = ts.transpileModule(readFileSync(new URL("../src/zaicode/useZaicodeSessionDriftCopy.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const refs: { current: unknown }[] = [], writes: string[] = [], reads: unknown[] = [];
  let cursor = 0, view: any, deps: readonly unknown[] | undefined, cleanup: (() => void) | undefined;
  let resolve!: (value: ZCodeSessionStateSnapshot) => void;
  const pending = new Promise<ZCodeSessionStateSnapshot>(done => { resolve = done; });
  const services = { zcodeSessionService: { readSession: (params: unknown) => { reads.push(params); return pending; } }, fileService: noFiles };
  const platform = { writeClipboardText: async (text: string) => { writes.push(text); } };
  const modules: Record<string, unknown> = {
    react: {
      useCallback: (fn: unknown) => fn,
      useRef: (initial: unknown) => refs[cursor++] ?? (refs[cursor - 1] = { current: initial }),
      useState: (initial: unknown) => { view ??= initial; return [view, (next: unknown) => { view = next; }]; },
      useEffect: (fn: () => (() => void), next: readonly unknown[]) => {
        if (!deps || next.some((value, i) => value !== deps?.[i])) { cleanup?.(); deps = [...next]; cleanup = fn(); }
      },
    },
    "@zcode/shared": { ZCODE_VERSION: "fixture", ZCODE_COMMIT: "fixture", ZCODE_BUILD_TIME: "fixture" },
    "@/hooks/useServices.js": { useServices: () => services },
    "@/hooks/usePlatform.js": { useOptionalPlatform: () => platform },
    "./zaicodeSessionDriftCopy.js": { copySessionDriftEvidence },
  };
  const exports: Record<string, any> = {};
  runInNewContext(code, { exports, require: (name: string) => modules[name] ?? {} });
  return { writes, reads, resolve, state: () => view, unmount: () => cleanup?.(),
    render(selected = target, ready = true) { cursor = 0; return exports.useZaicodeSessionDriftCopy(selected, ready); },
  };
}

test("T-333: two rapid hook clicks make one read/write and report actual full counts", async () => {
  const f = hookFixture();
  const action = f.render();
  const first = action.onCopy(), second = action.onCopy();
  assert.equal(f.reads.length, 1);
  assert.equal(f.state().status, "reading");
  f.resolve(snapshot()); await Promise.all([first, second]);
  assert.equal(f.writes.length, 1);
  assert.equal(f.state().status, "copied");
  assert.match(f.state().detail, /2011 messages copied/);
  f.unmount();
});

test("T-333: pending copy is cancelled by session/workspace/remote change and unmount", async () => {
  for (const kind of ["session", "workspace", "remote", "unmount"]) {
    const f = hookFixture();
    const operation = f.render().onCopy();
    if (kind === "unmount") f.unmount();
    else f.render({ ...target, ...(kind === "session" ? { sessionId: "other" } : kind === "workspace" ? { workspaceIdentity: "other" } : { remoteSessionId: "other" }) });
    f.resolve(snapshot(1)); await operation;
    assert.equal(f.writes.length, 0, kind);
    assert.notEqual(f.state().status, "copied");
    f.unmount();
  }
});

test("T-333: malformed selected IDs fail before reading or replacing the clipboard", async () => {
  for (const malformed of [{ ...target, sessionId: " " }, { ...target, workspacePath: "" }]) {
    let reads = 0, writes = 0;
    await assert.rejects(capture(snapshot(1), { target: malformed, sessionService: { async readSession() { reads++; return snapshot(1); } }, writeClipboardText: async () => { writes++; } }), /identity/);
    assert.equal(reads, 0); assert.equal(writes, 0);
  }
});

test("T-333: lost snapshot readiness cancels pending copy and leaves controls usable", async () => {
  const f = hookFixture();
  const operation = f.render().onCopy();
  f.render(target, false);
  f.resolve(snapshot(1)); await operation;
  assert.equal(f.writes.length, 0, "an unavailable/deleted selected snapshot cannot publish an older capture");
  assert.equal(f.state().status, "idle", "cancelled read cannot leave a permanent Reading state");
  await f.render(target, true).onCopy();
  assert.equal(f.reads.length, 2);
  assert.equal(f.writes.length, 1, "a fresh available snapshot can be copied after cancellation");
  f.unmount();
});
