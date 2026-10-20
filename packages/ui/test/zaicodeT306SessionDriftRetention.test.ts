import assert from "node:assert/strict";
import test from "node:test";
import type { IFileService } from "@zcode/services";
import type { ZCodeSessionStateSnapshot } from "@zcode/shared";
import { copySessionDriftEvidence } from "../src/zaicode/zaicodeSessionDriftCopy.js";

// T-306: current-work export reliability. The fixtures reproduce the reported shape — a long
// session, twelve failed tool calls, a large inline image beside a real human instruction, and a
// strict character budget — and assert the retention priority, attachment reference handling and
// coverage disclosure. Source fields are read loosely; only the tested fields must exist.

const target = { sessionId: "current", workspacePath: "/project" };
const timestamp = 1_791_500_000_000;

/** Real operator input: the only provenance that starts/keeps a human instruction. */
const REAL_USER = {
  origin: "real_user",
  kind: "user_prompt",
  uiVisibility: "visible",
  providerVisibility: "visible",
  transcriptVisibility: "visible",
} as const;

/** Provider-context user carrier: role `user` but not human-authored (queued/system injected). */
const PROVIDER_CARRIER = {
  origin: "agent_runtime",
  kind: "user_prompt",
  source: "queued_system_notification",
  uiVisibility: "hidden",
  providerVisibility: "visible",
  transcriptVisibility: "hidden",
} as const;

// A 25,427-byte PNG is ~33,904 base64 characters: bigger than the whole text budget on its own.
const IMAGE_MARKER = "iVBORw0KGgoAAAANSUhEUg";
const IMAGE_URL = `data:image/png;base64,${IMAGE_MARKER}${"A".repeat(33_900)}`;

const OPERATOR_HEAD = "OPERATOR HEAD ";
const OPERATOR_TAIL = " OPERATOR-INSTRUCTION-TAIL-MARKER";
const OPERATOR_TEXT = `${OPERATOR_HEAD}${"context ".repeat(500)}${OPERATOR_TAIL}`;

type Shape = {
  role: "user" | "assistant";
  text?: string;
  semantics?: Record<string, unknown>;
  tool?: { callId: string; tool: string; state: Record<string, unknown> };
  file?: { mime: string; filename?: string; url: string };
};

function fixture(shapes: readonly Shape[]): ZCodeSessionStateSnapshot {
  return {
    protocol: { name: "ZCode Protocol", version: 1 },
    session: {
      sessionId: "current",
      workspacePath: "/project",
      workspace: { workspacePath: "/project", workspaceKey: "/project" },
      title: "T-306 fixture",
      createdAt: timestamp,
      updatedAt: timestamp + 10,
      mode: "yolo",
      status: "running",
      sessionKind: "main",
    },
    runtime: { eventSeq: 1, stateRevision: 1, pendingRequestIds: [] },
    settings: {},
    projection: {},
    messages: shapes.map((shape, index) => {
      const messageId = `m-${index}`;
      const parts: unknown[] = [];
      if (shape.text)
        parts.push({ partId: `p-${index}`, messageId, sessionId: "current", type: "text", text: shape.text });
      if (shape.tool)
        parts.push({ partId: `t-${index}`, messageId, sessionId: "current", type: "tool", ...shape.tool });
      if (shape.file)
        parts.push({ partId: `f-${index}`, messageId, sessionId: "current", type: "file", ...shape.file });
      return {
        info: {
          messageId,
          sessionId: "current",
          role: shape.role,
          time: { created: timestamp + index },
          agent: "agent-A",
          ...(shape.semantics ? { semantics: shape.semantics } : {}),
        },
        parts,
      };
    }),
  } as unknown as ZCodeSessionStateSnapshot;
}

const failedTool = (callId: string, body: string) => ({
  callId,
  tool: "Bash",
  state: {
    status: "error",
    input: { command: callId },
    error: `${callId} exited with code 1\n${body}`,
    title: callId,
    metadata: {},
    startedAt: timestamp,
    completedAt: timestamp + 1,
  },
});

const completedTool = (callId: string, output: string) => ({
  callId,
  tool: "Bash",
  state: {
    status: "completed",
    input: { command: callId },
    output,
    title: callId,
    metadata: {},
    startedAt: timestamp,
    completedAt: timestamp + 1,
  },
});

// Empty file service: no project/protocol documents are bound, so context is unavailable.
function emptyFiles(): Pick<IFileService, "stat" | "readFileRange"> {
  return {
    async stat() {
      throw new Error("ENOENT");
    },
    async readFileRange() {
      throw new Error("ENOENT");
    },
  } as Pick<IFileService, "stat" | "readFileRange">;
}

async function copyWith(
  source: ZCodeSessionStateSnapshot,
) {
  let text = "";
  const result = await copySessionDriftEvidence({
    target,
    sessionService: { readSession: async () => source },
    fileService: emptyFiles(),
    writeClipboardText: async (value) => {
      text = value;
    },
    isCurrent: () => true,
    now: () => timestamp,
  });
  return { text, result };
}

// ── Retention priority: the human instruction survives even the last reduction plan ─────────

test("T-306: a long operator instruction is never dropped or text-shortened", async () => {
  const shapes: Shape[] = [];
  for (let index = 0; index <= 9; index += 1) shapes.push({ role: "assistant", text: `pad-${index}` });
  // The recorded human task carries a large instruction; the bulk after it forces the ladder to
  // its smallest plan, where non-protected text is capped at 400 characters.
  shapes.push({ role: "user", text: `CURRENT OBJECTIVE: ${OPERATOR_TEXT}`, semantics: { ...REAL_USER } });
  for (let index = 11; index <= 19; index += 1) shapes.push({ role: "assistant", text: `pad-${index}` });
  for (let index = 20; index <= 31; index += 1)
    shapes.push({ role: "assistant", text: `fail-${index}`, tool: failedTool(`call-${index}`, `failure body ${index}`) });
  for (let index = 32; index <= 70; index += 1) shapes.push({ role: "assistant", text: `pad-${index}` });
  for (let index = 71; index <= 99; index += 1) shapes.push({ role: "assistant", text: `bulk-${index} `.repeat(400) });

  const { text, result } = await copyWith(fixture(shapes));
  assert.equal(result.messages, 100);
  assert.ok(text.includes(OPERATOR_TEXT), "the whole instruction survives");
  assert.ok(text.includes("pad-0"), "earlier surviving history is retained");
  assert.ok(text.includes("bulk-99"));
  assert.ok(result.characters > 40000, "no compact cap is applied");
  for (let i = 20; i <= 31; i++) assert.ok(text.includes('failure body ' + i));
});

// ── The reported 931-message shape: retention, attachments, provenance, honest coverage ────

function reportedShape(): ZCodeSessionStateSnapshot {
  const shapes: Shape[] = [];
  for (let index = 0; index <= 799; index += 1) shapes.push({ role: "assistant", text: `pad-${index}` });
  shapes.push({ role: "user", text: "CURRENT OBJECTIVE: audit the forensic export", semantics: { ...REAL_USER } });
  // Twelve recorded failures inside the window gap; their bodies alone exceed the text budget.
  for (let index = 801; index <= 812; index += 1)
    shapes.push({ role: "assistant", text: `fail-${index}`, tool: failedTool(`call-${index}`, "x".repeat(3_000)) });
  for (let index = 813; index <= 901; index += 1) shapes.push({ role: "assistant", text: `pad-${index}` });
  // Newest tail: a queued (non-human) user carrier, then volume, then an image attachment.
  shapes.push({ role: "user", text: "queued note 1", semantics: { ...PROVIDER_CARRIER } });
  for (let index = 903; index <= 912; index += 1)
    shapes.push({ role: "assistant", text: `noise-${index}`, tool: completedTool(`out-${index}`, `out-${index} `.repeat(500)) });
  for (let index = 913; index <= 919; index += 1) shapes.push({ role: "assistant", text: `pad-${index}` });
  shapes.push({ role: "assistant", text: "screenshot attached", file: { mime: "image/png", filename: "shot.png", url: IMAGE_URL } });
  for (let index = 921; index <= 930; index += 1) shapes.push({ role: "assistant", text: `tail-${index}` });
  return fixture(shapes);
}

test("T-306: the reported 931-message shape keeps every surviving record, provenance and attachment reference", async () => {
  const source = reportedShape();
  assert.equal(source.messages.length, 931);
  const { text, result } = await copyWith(source);
  assert.equal(result.messages, 931);
  assert.ok(text.includes("pad-0"));
  assert.ok(text.includes("tail-930"));
  assert.ok(text.includes("CURRENT OBJECTIVE: audit the forensic export"));
  for (let i = 801; i <= 812; i++) assert.ok(text.includes('call-' + i));
  assert.ok(text.includes('"origin": "agent_runtime"'));
  assert.ok(!text.includes(IMAGE_MARKER), "binary payload is still a reference");
  assert.ok(text.includes("Attachment reference (bytes not inlined)"));
  assert.equal((text.match(/^### Message /gm) ?? []).length, 931);
});

// ── The full forensic copy stays available and byte-honest ─────────────────────────────────

test("T-306: the full forensic copy keeps every message, references the attachment and inlines no base64", async () => {
  const source = reportedShape();
  const { text, result } = await copyWith(source);
  assert.equal(result.messages, 931);
  assert.ok(text.includes("Entire session transcript"));
  assert.ok(text.includes("pad-0"));
  assert.ok(text.includes("tail-930"));
  assert.ok(text.includes("CURRENT OBJECTIVE: audit the forensic export"));
  assert.ok(!text.includes(IMAGE_MARKER), "forensic copy keeps attachments as references");
  assert.ok(text.includes("Attachment reference (bytes not inlined)"));
});
