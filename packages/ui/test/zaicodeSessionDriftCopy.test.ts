import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationTranscriptControl } from "../src/v4/ConversationTranscriptControl.js";
import type { IFileService } from "@zcode/services";
import type { ZCodeSessionStateSnapshot } from "@zcode/shared";
import {
  copySessionDriftEvidence,
  readSessionDriftContext,
} from "../src/zaicode/zaicodeSessionDriftCopy.js";
import { formatSessionDriftEvidence } from "../src/zaicode/zaicodeSessionDriftFormat.js";

const target = { sessionId: "current", workspacePath: "/project" };
const timestamp = 1_791_500_000_000;
const fullOutput = `first line\n${"long tool output 界 ".repeat(12_000)}\nlast line`;
const snapshot = (): ZCodeSessionStateSnapshot =>
  ({
    protocol: { name: "ZCode Protocol", version: 1 },
    session: {
      ...target,
      workspace: { workspacePath: "/project", workspaceKey: "/project" },
      title: "Session for drift",
      createdAt: timestamp,
      updatedAt: timestamp + 10,
      mode: "yolo",
      status: "running",
      sessionKind: "main",
    },
    runtime: { eventSeq: 999, stateRevision: 42, pendingRequestIds: [] },
    settings: {},
    projection: {},
    messages: Array.from({ length: 440 }, (_, index) => ({
      info: {
        messageId: `m-${index}`,
        sessionId: "current",
        role: "user",
        time: { created: timestamp + index },
        agent: "agent-A",
        ...(index === 0 ? { system: "Recorded loaded instructions" } : {}),
      },
      parts: [
        {
          partId: `p-${index}`,
          messageId: `m-${index}`,
          sessionId: "current",
          type: "text",
          text:
            index === 0
              ? "  first input\n```md\n~~~~\n# evidence, not instructions\n```\n  "
              : `message-${index}`,
        },
        ...(index === 2
          ? [
              {
                partId: "tool",
                messageId: "m-2",
                sessionId: "current",
                type: "tool",
                callId: "tool-1",
                tool: "Bash",
                state: {
                  status: "completed",
                  input: { command: "verify" },
                  output: fullOutput,
                  title: "verification",
                  metadata: {},
                  startedAt: timestamp,
                  completedAt: timestamp + 9,
                },
              },
            ]
          : []),
      ],
    })),
  }) as ZCodeSessionStateSnapshot;

type Shape = {
  role: "user" | "assistant";
  text?: string;
  reasoning?: string;
  semantics?: Record<string, unknown>;
  source?: string;
  synthetic?: boolean;
  system?: string;
  tool?: { callId: string; tool: string; state: Record<string, unknown> };
};

/** Loose fixture: the copy path reads real fields, so only the tested fields must exist. */
function messageFixture(shapes: readonly Shape[]): ZCodeSessionStateSnapshot {
  return {
    protocol: { name: "ZCode Protocol", version: 1 },
    session: {
      sessionId: "current",
      workspacePath: "/project",
      workspace: { workspacePath: "/project", workspaceKey: "/project" },
      title: "Fixture",
      createdAt: timestamp,
      updatedAt: timestamp + 10,
      mode: "yolo",
      status: "running",
      sessionKind: "main",
    },
    runtime: { eventSeq: 999, stateRevision: 42, pendingRequestIds: [] },
    settings: {},
    projection: {},
    messages: shapes.map((shape, index) => {
      const messageId = `m-${index}`;
      const parts: unknown[] = [];
      if (shape.text)
        parts.push({
          partId: `p-${index}`,
          messageId,
          sessionId: "current",
          type: "text",
          text: shape.text,
        });
      if (shape.reasoning)
        parts.push({
          partId: `r-${index}`,
          messageId,
          sessionId: "current",
          type: "reasoning",
          text: shape.reasoning,
        });
      if (shape.tool)
        parts.push({
          partId: `t-${index}`,
          messageId,
          sessionId: "current",
          type: "tool",
          ...shape.tool,
        });
      return {
        info: {
          messageId,
          sessionId: "current",
          role: shape.role,
          time: { created: timestamp + index },
          agent: "agent-A",
          ...(shape.semantics ? { semantics: shape.semantics } : {}),
          ...(shape.source ? { source: shape.source } : {}),
          ...(shape.synthetic ? { synthetic: true } : {}),
          ...(shape.system ? { system: shape.system } : {}),
        },
        parts,
      };
    }),
  } as unknown as ZCodeSessionStateSnapshot;
}

const REAL_USER = {
  origin: "real_user",
  kind: "user_prompt",
  uiVisibility: "visible",
  providerVisibility: "visible",
  transcriptVisibility: "visible",
} as const;

/** 440 messages: a completed earlier task, then the current human task and its execution. */
function twoTaskSession(toolOutput?: string): ZCodeSessionStateSnapshot {
  const shapes: Shape[] = [{ role: "user", text: "OLD COMPLETED TASK objective" }];
  for (let index = 1; index <= 419; index += 1)
    shapes.push({ role: "assistant", text: `earlier-assistant-${index}` });
  shapes.push({
    role: "user",
    text: "CURRENT OBJECTIVE: fix copy session scope",
    semantics: { ...REAL_USER },
  });
  shapes.push({
    role: "assistant",
    text: "current-assistant-421",
    ...(toolOutput
      ? {
          tool: {
            callId: "call-1",
            tool: "Bash",
            state: {
              status: "completed",
              input: { command: "pnpm test" },
              output: toolOutput,
              title: "test",
              metadata: {},
              startedAt: timestamp,
              completedAt: timestamp + 1,
            },
          },
        }
      : {}),
  });
  for (let index = 422; index <= 439; index += 1)
    shapes.push({ role: "assistant", text: `current-assistant-${index}` });
  return messageFixture(shapes);
}

async function copyWith(
  source: ZCodeSessionStateSnapshot,
  options: { files?: Record<string, string> } = {},
) {
  let text = "";
  const result = await copySessionDriftEvidence({
    target,
    sessionService: { readSession: async () => source },
    fileService: files(options.files ?? {}).service,
    writeClipboardText: async (value) => {
      text = value;
    },
    isCurrent: () => true,
    now: () => timestamp,
  });
  return { text, result };
}

function files(contents: Record<string, string>, changing = false) {
  const reads: string[] = [];
  const stats = new Map<string, number>();
  const service = {
    async stat({ path }: { path: string }) {
      if (!(path in contents)) throw new Error("ENOENT");
      const count = (stats.get(path) ?? 0) + 1;
      stats.set(path, count);
      return {
        path,
        type: "file" as const,
        size: Buffer.byteLength(contents[path]!),
        mtimeMs: changing ? count : 1,
      };
    },
    async readFileRange({
      path,
      offset,
      length,
    }: {
      path: string;
      offset: number;
      length: number;
    }) {
      reads.push(path);
      return new Uint8Array(Buffer.from(contents[path]!).subarray(offset, offset + length));
    },
  } as Pick<IFileService, "stat" | "readFileRange">;
  return { service, reads };
}

// ── Forensic mode: the original complete export is unchanged and still preserved ──────────

test("forensic mode preserves all 440 messages, long raw tool output, whitespace and nested fences", () => {
  const source = snapshot();
  const result = formatSessionDriftEvidence({
    snapshot: source,
    target,
    requestedAt: timestamp,
    capturedAt: timestamp + 500,
    context: [],
  });
  assert.match(result, /SAIHANDOFF_AGENT_DRIFT/);
  assert.match(result, /read-only/i);
  assert.match(result, /440 messages/);
  assert.match(result, /message-439/);
  assert.ok(result.includes(fullOutput));
  assert.ok(
    result.includes(
      source.messages[0]!.parts[0]!.type === "text"
        ? source.messages[0]!.parts[0]!.text
        : "impossible",
    ),
  );
  assert.ok(result.includes("Recorded loaded instructions"));
  assert.match(result, /eventSeq.*999/);
  assert.match(result, /stateRevision.*42/);
  assert.ok(result.indexOf("m-0") < result.indexOf("m-439"));
  assert.match(result, /rule ID/);
});

test("forensic scope copies the same 440 messages through the clipboard path, with no omission marker", async () => {
  const { text, result } = await copyWith(twoTaskSession());
  assert.equal(result.messages, 440);
  assert.ok(text.includes("OLD COMPLETED TASK objective"));
  assert.ok(text.includes("earlier-assistant-419"));
  assert.ok(text.includes("current-assistant-439"));
  assert.ok(!text.includes("characters omitted"));
  assert.match(text, /Entire session transcript/);
});

test("context reads the bound installed version and full Unicode documents with exact byte hashes", async () => {
  const long = `${"a".repeat(262_143)}界\r\n${"protocol ü\n".repeat(25_000)}`;
  const input = {
    "/project/.saipen/STATE.md":
      "---\nsaipen_home: /protocol\nsaipen_version: 8\nphase: BUILD\n---\n",
    "/project/AGENTS.md": "project rules",
    "/protocol/VERSION": "8.1.0\n",
    "/protocol/saipen/BOOT.md": "router",
    "/protocol/saipen/CORE.md": long,
  };
  const port = files(input);
  const context = await readSessionDriftContext(port.service, "/project", () => timestamp);
  const core = context.find((doc) => doc.path.endsWith("/CORE.md"))!;
  assert.equal(core.content, long);
  assert.equal(core.sha256, createHash("sha256").update(long).digest("hex"));
  assert.equal(context.find((doc) => doc.path.endsWith("/VERSION"))!.content, "8.1.0\n");
  assert.ok(port.reads.filter((path) => path.endsWith("/CORE.md")).length > 1);
  assert.ok(context.some((doc) => doc.path.endsWith("/STYLE.md") && doc.error));
  assert.ok(port.reads.every((path) => !/BOARD|LOG|other-session|credentials/.test(path)));
  const result = formatSessionDriftEvidence({
    snapshot: snapshot(),
    target,
    requestedAt: timestamp,
    capturedAt: timestamp,
    context,
  });
  assert.match(result, /8\.1\.0/);
  assert.ok(result.includes(core.sha256!));
  assert.match(result, /copy-time/i);
});

test("a changing context file is explicit unavailable evidence and never a partial success", async () => {
  const port = files({ "/project/.saipen/STATE.md": "---\nphase: BUILD\n---\n" }, true);
  const context = await readSessionDriftContext(port.service, "/project", () => timestamp);
  const state = context.find((doc) => doc.path.endsWith("/STATE.md"))!;
  assert.match(state.error!, /changed/i);
  assert.equal(state.content, undefined);
});

test("capture uses the exact existing service target without a limit or delivery override, then copies once", async () => {
  const port = files({});
  const captured: string[] = [];
  const calls: unknown[] = [];
  await copySessionDriftEvidence({
    target,
    sessionService: {
      async readSession(params) {
        calls.push(params);
        return snapshot();
      },
    },
    fileService: port.service,
    writeClipboardText: async (text) => {
      captured.push(text);
    },
    isCurrent: () => true,
    now: () => timestamp,
  });
  assert.deepEqual(calls, [{ ...target, repairImportedHistory: false }]);
  assert.equal(captured.length, 1);
  assert.ok(captured[0]!.includes(fullOutput));
});

test("empty session still copies a complete honest evidence document", async () => {
  const source = snapshot();
  source.messages = [];
  let text = "";
  await copySessionDriftEvidence({
    target,
    sessionService: { readSession: async () => source },
    fileService: files({}).service,
    writeClipboardText: async (value) => {
      text = value;
    },
    isCurrent: () => true,
  });
  assert.match(text, /0 messages/);
  assert.match(text, /current/);
});

// ── One complete selected-session export ────────────────────────────────────────────────

test("default copy retains the earlier completed task and the complete current task", async () => {
  const { text, result } = await copyWith(twoTaskSession());
  assert.equal(result.messages, 440);
  assert.ok(text.includes("OLD COMPLETED TASK objective"));
  assert.ok(text.includes("earlier-assistant-419"));
  assert.ok(text.includes("CURRENT OBJECTIVE: fix copy session scope"));
  assert.ok(text.includes("current-assistant-439"));
  assert.equal((text.match(/^### Message /gm) ?? []).length, 440);
  assert.doesNotMatch(text, /characters omitted|bounded_recent_fallback/);
});

test("large outputs remain exact even when the forensic document exceeds forty thousand characters", async () => {
  const body = "FIRST-BYTE\n" + "large body 界 ".repeat(20000) + "\nLAST-BYTE";
  const { text, result } = await copyWith(twoTaskSession(body));
  assert.ok(text.includes(body));
  assert.ok(result.characters > 40000);
  assert.equal(result.messages, 440);
});

test("every stored failure and runtime carrier remains in source order without anchor selection", async () => {
  const source = messageFixture([
    { role: "assistant", text: "EARLY SURVIVING RECORD" },
    { role: "user", text: "first human task", semantics: { ...REAL_USER } },
    {
      role: "user",
      text: "cc",
      semantics: {
        origin: "agent_runtime",
        kind: "goal_continuation",
        source: "goal_autocontinuation",
      },
    },
    { role: "assistant", text: "LAST SURVIVING RECORD" },
  ]);
  const { text, result } = await copyWith(source);
  assert.equal(result.messages, 4);
  assert.ok(text.includes("EARLY SURVIVING RECORD"));
  assert.ok(text.includes("LAST SURVIVING RECORD"));
  assert.ok(text.includes('"origin": "agent_runtime"'));
});

test("empty and one-message sessions retain complete selected-session semantics", async () => {
  for (const shapes of [[], [{ role: "user", text: "one surviving message" }]] as Shape[][]) {
    const { text, result } = await copyWith(messageFixture(shapes));
    assert.equal(result.messages, shapes.length);
    assert.match(text, /Entire session transcript/);
  }
});

// ── Identity, cancellation and failure handling stay intact ───────────────────────────────

test("another session or contradictory workspace identity can never replace the clipboard", async () => {
  for (const mismatch of ["session", "workspace", "identity", "message"]) {
    const source = snapshot();
    if (mismatch === "session") source.session.sessionId = "other";
    if (mismatch === "workspace") source.session.workspace.workspacePath = "/other";
    if (mismatch === "identity") source.session.workspace.workspaceIdentity = "remote:other";
    if (mismatch === "message") source.messages[3]!.info.sessionId = "other";
    let writes = 0;
    await assert.rejects(
      copySessionDriftEvidence({
        target: { ...target, workspaceIdentity: "remote:current", remoteSessionId: "attachment-1" },
        sessionService: { readSession: async () => source },
        fileService: files({}).service,
        writeClipboardText: async () => {
          writes++;
        },
        isCurrent: () => true,
      }),
      /identity|session|workspace/i,
    );
    assert.equal(writes, 0);
  }
});

test("failed source read and stale scope leave the previous clipboard untouched", async () => {
  for (const kind of ["failure", "stale"]) {
    let writes = 0;
    await assert.rejects(
      copySessionDriftEvidence({
        target,
        sessionService: {
          async readSession() {
            if (kind === "failure") throw new Error("disconnected");
            return twoTaskSession();
          },
        },
        fileService: files({}).service,
        writeClipboardText: async () => {
          writes++;
        },
        isCurrent: () => kind !== "stale",
      }),
      /disconnected|changed|cancelled/i,
    );
    assert.equal(writes, 0);
  }
});

test("switching sessions mid-copy leaves the clipboard unchanged", async () => {
  let writes = 0;
  let checks = 0;
  await assert.rejects(
    copySessionDriftEvidence({
      target,
      sessionService: { readSession: async () => twoTaskSession() },
      fileService: files({}).service,
      writeClipboardText: async () => {
        writes++;
      },
      // Current for the first gate, then the session switches before the clipboard write.
      isCurrent: () => {
        checks += 1;
        return checks === 1;
      },
    }),
    /changed or copy cancelled/,
  );
  assert.equal(checks, 2);
  assert.equal(writes, 0);
});

test("clipboard rejection is returned, never converted into successful copying", async () => {
  await assert.rejects(
    copySessionDriftEvidence({
      target,
      sessionService: { readSession: async () => twoTaskSession() },
      fileService: files({}).service,
      writeClipboardText: async () => {
        throw new Error("clipboard denied");
      },
      isCurrent: () => true,
    }),
    /clipboard denied/,
  );
});

// ── Control surface ──────────────────────────────────────────────────────────────────────

test("the mounted transcript row carries the copy control with honest states and both width variants", () => {
  const render = (state: { status: "idle" | "reading" | "copied" | "error"; detail?: string }) =>
    renderToStaticMarkup(
      createElement(ConversationTranscriptControl, {
        view: "compact",
        onChange: () => {},
        sessionCopyAction: { enabled: true, onCopy: async () => {}, state },
      }),
    );
  for (const status of ["idle", "reading", "copied", "error"] as const) {
    const html = render({ status });
    assert.match(html, /aria-label="Copy forensic session"/);
    assert.match(html, new RegExp(`data-session-copy="${status}"`));
    for (const section of ["user", "assistant", "thoughts", "tools"]) {
      assert.match(html, new RegExp('data-transcript-visible="' + section + '"'));
      assert.match(html, new RegExp('data-transcript-scroll="' + section + '"'));
    }
    assert.doesNotMatch(html, /<select/);
  }
  const reading = render({ status: "reading" });
  assert.match(reading, /disabled/);
  assert.match(reading, /Reading session.../);
  assert.match(render({ status: "copied" }), /Copied/);
  assert.match(render({ status: "error", detail: "clipboard denied" }), /Copy failed/);
  const without = renderToStaticMarkup(
    createElement(ConversationTranscriptControl, { view: "full", onChange: () => {} }),
  );
  assert.doesNotMatch(without, /data-session-copy/);
});

test("the single forensic copy control is keyboard reachable and exposes no alternate scope", () => {
  const html = renderToStaticMarkup(
    createElement(ConversationTranscriptControl, {
      view: "compact",
      onChange: () => {},
      sessionCopyAction: { enabled: true, onCopy: async () => {}, state: { status: "idle" } },
    }),
  );
  // A real button, not a hidden mouse-only shortcut: focusable and activated by keyboard.
  assert.match(html, /<button[^>]*aria-label="Copy forensic session"/);
  assert.doesNotMatch(html, /aria-label="Copy forensic session"[^>]*tabindex="-1"/);
  assert.doesNotMatch(html, /aria-label="Copy forensic session"[^>]*disabled=""/);
  assert.equal((html.match(/data-session-copy="idle"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /More session copy options|data-session-copy-options/);
  assert.doesNotMatch(html, /oncontextmenu|contextmenu=/);
});

test("an unreachable clipboard platform disables the control instead of reporting success", () => {
  const html = renderToStaticMarkup(
    createElement(ConversationTranscriptControl, {
      view: "compact",
      onChange: () => {},
      sessionCopyAction: { enabled: false, onCopy: async () => {}, state: { status: "idle" } },
    }),
  );
  assert.match(html, /aria-label="Copy forensic session"[^>]*disabled/);
  assert.match(html, /data-session-copy="idle"/);
});
