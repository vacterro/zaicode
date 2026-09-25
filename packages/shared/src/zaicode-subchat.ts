/* eslint-disable max-lines -- one owner module: the invocation, both vendor stream parsers and the transcript reducer change together when a vendor changes its stream. */
/**
 * ZAICODE subscription chat (T-51, SRC-038): a Claude Code or Codex
 * subscription answers inside ZAICODE's own chat view, with no worker
 * terminal. Each turn runs the vendor's official CLI headless in the project
 * folder (`claude -p --output-format stream-json`, `codex exec --json`) under
 * the account's own home (CLAUDE_CONFIG_DIR / CODEX_HOME), so A1 and A2 (or
 * C1..C3) stay separate accounts; the next turn resumes the same vendor
 * session. The prompt travels on stdin: no argument quoting, no command-line
 * length limit.
 *
 * This module is the pure half: who can chat, the exact invocation, the two
 * stream parsers and the transcript reducer. The desktop main process runs
 * the CLI; the renderer only renders the transcript.
 */

import type { ZaicodeEngineAccount, ZaicodeEngineVendor } from "./zaicode-engines.js";

export type ZaicodeSubchatVendor = "claude" | "codex";

export function isZaicodeSubchatVendor(vendor: ZaicodeEngineVendor): vendor is ZaicodeSubchatVendor {
  return vendor === "claude" || vendor === "codex";
}

type AccountFacts = Pick<ZaicodeEngineAccount, "vendor" | "label" | "status" | "statusDetail" | "cli">;

/** Why this account cannot chat inside ZAICODE right now, or null when it can. */
export function zaicodeSubchatUnavailableReason(account: AccountFacts): string | null {
  if (!isZaicodeSubchatVendor(account.vendor)) {
    return `${account.label} has no headless chat mode; it runs as a worker.`;
  }
  if (!account.cli || account.status === "cli-missing") {
    return account.statusDetail || `${account.label}: the CLI is not installed.`;
  }
  if (account.status !== "ready") return account.statusDetail || `${account.label} is not signed in.`;
  return null;
}

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

export interface ZaicodeSubchatInvocation {
  args: string[];
  /** Environment changes for the child: a string sets the variable, null removes it. */
  env: Record<string, string | null>;
  /** Written to the child's stdin, then stdin is closed. */
  stdin: string;
}

export interface ZaicodeSubchatTurnOptions {
  prompt: string;
  /** The vendor session to resume; null starts a new one. */
  sessionId: string | null;
  /** Skip the CLI's permission prompts (the Workers YOLO setting). A headless turn cannot ask. */
  yolo: boolean;
  model?: string | null;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** A resumable session id as the vendor printed it; anything else starts a new session. */
export function normalizeZaicodeSubchatSessionId(value: unknown): string | null {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value) ? value : null;
}

export function buildZaicodeSubchatInvocation(
  account: Pick<ZaicodeEngineAccount, "vendor" | "home" | "isDefaultHome">,
  options: ZaicodeSubchatTurnOptions,
): ZaicodeSubchatInvocation | null {
  const sessionId = normalizeZaicodeSubchatSessionId(options.sessionId);
  const model = options.model?.trim() || null;
  if (account.vendor === "claude") {
    return {
      args: [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        ...(sessionId ? ["--resume", sessionId] : []),
        ...(options.yolo ? ["--dangerously-skip-permissions"] : ["--permission-mode", "acceptEdits"]),
        ...(model ? ["--model", model] : []),
      ],
      env: {
        CLAUDE_CONFIG_DIR: account.isDefaultHome || !account.home ? null : account.home,
        // A turn started from inside a Claude Code shell must not look nested.
        CLAUDECODE: null,
        CLAUDE_CODE_ENTRYPOINT: null,
      },
      stdin: options.prompt,
    };
  }
  if (account.vendor === "codex") {
    const policy = options.yolo ? ["--dangerously-bypass-approvals-and-sandbox"] : ["-c", 'sandbox_mode="workspace-write"'];
    return {
      args: [
        "exec",
        ...(sessionId ? ["resume"] : []),
        "--json",
        "--skip-git-repo-check",
        ...policy,
        ...(model ? ["-m", model] : []),
        ...(sessionId ? [sessionId] : []),
        "-",
      ],
      env: account.home ? { CODEX_HOME: account.home } : {},
      stdin: options.prompt,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Stream parsers: one JSON line in, zero or more chat events out
// ---------------------------------------------------------------------------

export type ZaicodeSubchatEvent =
  | { type: "session"; sessionId: string; model: string | null }
  | { type: "text"; text: string }
  | { type: "tool"; name: string; detail: string }
  | { type: "usage"; input: number; output: number; cached: number }
  | { type: "error"; message: string }
  | { type: "result"; ok: boolean; message: string | null };

const DETAIL_MAX = 160;
/** Vendor error text keeps its tail: that is where the reset time is ("try again at ..."). */
const MESSAGE_MAX = 600;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function oneLine(value: string, max: number = DETAIL_MAX): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function messageLine(value: string): string {
  return oneLine(value, MESSAGE_MAX);
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return record(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

/** The one input field that says what a Claude tool call does. */
function claudeToolDetail(name: string, input: Record<string, unknown> | null): string {
  if (!input) return "";
  const pick = ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt", "skill"];
  for (const key of pick) {
    const value = text(input[key]);
    if (value) return oneLine(value);
  }
  if (name === "TodoWrite" && Array.isArray(input.todos)) return `${input.todos.length} todos`;
  const first = Object.values(input).find((value) => typeof value === "string");
  return typeof first === "string" ? oneLine(first) : "";
}

/** Claude Code `-p --output-format stream-json --verbose`. */
export function parseZaicodeClaudeStreamLine(line: string): ZaicodeSubchatEvent[] {
  const event = parseJsonLine(line);
  if (!event) return [];
  const type = text(event.type);
  if (type === "system" && text(event.subtype) === "init") {
    const sessionId = normalizeZaicodeSubchatSessionId(event.session_id);
    return sessionId ? [{ type: "session", sessionId, model: text(event.model) || null }] : [];
  }
  if (type === "assistant") {
    const content = record(event.message)?.content;
    if (!Array.isArray(content)) return [];
    const out: ZaicodeSubchatEvent[] = [];
    for (const raw of content) {
      const block = record(raw);
      if (!block) continue;
      if (block.type === "text" && text(block.text).trim()) out.push({ type: "text", text: text(block.text) });
      if (block.type === "tool_use") {
        const name = text(block.name) || "tool";
        out.push({ type: "tool", name, detail: claudeToolDetail(name, record(block.input)) });
      }
    }
    return out;
  }
  if (type === "result") {
    const usage = record(event.usage);
    const out: ZaicodeSubchatEvent[] = [];
    if (usage) {
      const cached = count(usage.cache_read_input_tokens);
      out.push({
        type: "usage",
        input: count(usage.input_tokens) + count(usage.cache_creation_input_tokens) + cached,
        output: count(usage.output_tokens),
        cached,
      });
    }
    const failed = event.is_error === true || (text(event.subtype) !== "" && text(event.subtype) !== "success");
    const message = failed ? messageLine(text(event.result) || text(event.subtype) || "the turn failed") : null;
    out.push({ type: "result", ok: !failed, message });
    return out;
  }
  return [];
}

/** Codex `codex exec --json` (thread / turn / item events). */
export function parseZaicodeCodexJsonLine(line: string): ZaicodeSubchatEvent[] {
  const event = parseJsonLine(line);
  if (!event) return [];
  const type = text(event.type);
  if (type === "thread.started") {
    const sessionId = normalizeZaicodeSubchatSessionId(event.thread_id);
    return sessionId ? [{ type: "session", sessionId, model: null }] : [];
  }
  const item = record(event.item);
  if (type === "item.started" && item) {
    if (item.type === "command_execution") return [{ type: "tool", name: "shell", detail: oneLine(text(item.command)) }];
    if (item.type === "mcp_tool_call") {
      return [{ type: "tool", name: [text(item.server), text(item.tool)].filter(Boolean).join(".") || "mcp", detail: "" }];
    }
    if (item.type === "web_search") return [{ type: "tool", name: "search", detail: oneLine(text(item.query)) }];
    return [];
  }
  if (type === "item.completed" && item) {
    if (item.type === "agent_message" && text(item.text).trim()) return [{ type: "text", text: text(item.text) }];
    if (item.type === "file_change" && Array.isArray(item.changes)) {
      const paths = item.changes.map((change) => text(record(change)?.path)).filter(Boolean);
      return [{ type: "tool", name: "edit", detail: oneLine(paths.join(", ")) }];
    }
    if (item.type === "error") return [{ type: "error", message: messageLine(text(item.message)) }];
    return [];
  }
  if (type === "turn.completed") {
    const usage = record(event.usage);
    const cached = count(usage?.cached_input_tokens);
    return [
      { type: "usage", input: count(usage?.input_tokens), output: count(usage?.output_tokens), cached },
      { type: "result", ok: true, message: null },
    ];
  }
  if (type === "turn.failed") {
    return [{ type: "result", ok: false, message: messageLine(text(record(event.error)?.message) || "the turn failed") }];
  }
  if (type === "error") return [{ type: "error", message: messageLine(text(event.message) || "error") }];
  return [];
}

export function parseZaicodeSubchatLine(vendor: ZaicodeSubchatVendor, line: string): ZaicodeSubchatEvent[] {
  return vendor === "claude" ? parseZaicodeClaudeStreamLine(line) : parseZaicodeCodexJsonLine(line);
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

export type ZaicodeSubchatRole = "user" | "assistant" | "tool" | "error" | "note";

export interface ZaicodeSubchatMessage {
  id: string;
  role: ZaicodeSubchatRole;
  text: string;
  at: number;
}

export type ZaicodeSubchatStatus = "idle" | "running" | "failed";

export interface ZaicodeSubchatConversation {
  id: string;
  accountId: string;
  vendor: ZaicodeSubchatVendor;
  /** Engine tile (A1, C2, ...) and label ("Claude 1") when the chat started. */
  short: string;
  label: string;
  projectPath: string;
  /** The vendor session the next turn resumes; null until the first turn reports one. */
  sessionId: string | null;
  model: string | null;
  title: string;
  createdAt: number;
  updatedAt: number;
  status: ZaicodeSubchatStatus;
  /** Tokens the vendor reported for this chat, summed over its turns. */
  usage: { input: number; output: number; cached: number };
  messages: ZaicodeSubchatMessage[];
}

export const ZAICODE_SUBCHAT_MAX_MESSAGES = 400;
export const ZAICODE_SUBCHAT_MAX_TEXT = 64_000;
export const ZAICODE_SUBCHAT_MAX_CONVERSATIONS = 60;
const TITLE_MAX = 60;

function clip(value: string): string {
  return value.length > ZAICODE_SUBCHAT_MAX_TEXT ? `${value.slice(0, ZAICODE_SUBCHAT_MAX_TEXT)}\n…` : value;
}

export function zaicodeSubchatTitle(prompt: string): string {
  const line = prompt.replace(/\s+/g, " ").trim();
  if (!line) return "New chat";
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

export function appendZaicodeSubchatMessage(
  conversation: ZaicodeSubchatConversation,
  message: Omit<ZaicodeSubchatMessage, "text"> & { text: string },
): ZaicodeSubchatConversation {
  const messages = [...conversation.messages, { ...message, text: clip(message.text) }];
  return {
    ...conversation,
    messages: messages.length > ZAICODE_SUBCHAT_MAX_MESSAGES ? messages.slice(-ZAICODE_SUBCHAT_MAX_MESSAGES) : messages,
    updatedAt: Math.max(conversation.updatedAt, message.at),
  };
}

/** Applies one stream event to the transcript. `id` names the message it may add. */
export function applyZaicodeSubchatEvent(
  conversation: ZaicodeSubchatConversation,
  event: ZaicodeSubchatEvent,
  at: number,
  id: string,
): ZaicodeSubchatConversation {
  switch (event.type) {
    case "session":
      return { ...conversation, sessionId: event.sessionId, model: event.model ?? conversation.model };
    case "text":
      return appendZaicodeSubchatMessage(conversation, { id, role: "assistant", text: event.text, at });
    case "tool":
      return appendZaicodeSubchatMessage(conversation, {
        id,
        role: "tool",
        text: event.detail ? `${event.name}: ${event.detail}` : event.name,
        at,
      });
    case "usage":
      return {
        ...conversation,
        usage: {
          input: conversation.usage.input + event.input,
          output: conversation.usage.output + event.output,
          cached: conversation.usage.cached + event.cached,
        },
      };
    case "error":
      return appendZaicodeSubchatMessage(conversation, { id, role: "error", text: event.message, at });
    case "result": {
      // ok + message = ended on purpose (Stop): a note, not an error.
      const next = { ...conversation, status: event.ok ? ("idle" as const) : ("failed" as const), updatedAt: at };
      if (!event.message) return next;
      // A failed turn often says it twice: Codex as an error event then turn.failed, Claude (a spent
      // limit) as its only text block then the result. Show it once, as the error it is.
      const last = next.messages.at(-1);
      if (!event.ok && last && (last.role === "error" || last.role === "assistant") && last.text.trim() === event.message) {
        return { ...next, messages: [...next.messages.slice(0, -1), { ...last, role: "error" }] };
      }
      return appendZaicodeSubchatMessage(next, { id, role: event.ok ? "note" : "error", text: event.message, at });
    }
    default:
      return conversation;
  }
}

// ---------------------------------------------------------------------------
// Persistence (renderer localStorage): accept only what this module wrote
// ---------------------------------------------------------------------------

const ROLES: readonly ZaicodeSubchatRole[] = ["user", "assistant", "tool", "error", "note"];

function normalizeMessage(raw: unknown): ZaicodeSubchatMessage | null {
  const value = record(raw);
  if (!value || typeof value.id !== "string" || !ROLES.includes(value.role as ZaicodeSubchatRole)) return null;
  return { id: value.id, role: value.role as ZaicodeSubchatRole, text: clip(text(value.text)), at: count(value.at) };
}

/**
 * Stored chats -> valid chats, newest first, bounded. A chat stored as
 * "running" belonged to a turn that died with the app: it becomes idle with a
 * note, so the operator can simply send again (the session still resumes).
 */
export function normalizeZaicodeSubchatConversations(raw: unknown, now: number = Date.now()): ZaicodeSubchatConversation[] {
  if (!Array.isArray(raw)) return [];
  const out: ZaicodeSubchatConversation[] = [];
  for (const entry of raw) {
    const value = record(entry);
    if (!value || typeof value.id !== "string" || typeof value.accountId !== "string" || typeof value.projectPath !== "string") continue;
    if (value.vendor !== "claude" && value.vendor !== "codex") continue;
    const usage = record(value.usage);
    let conversation: ZaicodeSubchatConversation = {
      id: value.id,
      accountId: value.accountId,
      vendor: value.vendor,
      short: text(value.short) || "?",
      label: text(value.label) || text(value.short) || "Subscription",
      projectPath: value.projectPath,
      sessionId: normalizeZaicodeSubchatSessionId(value.sessionId),
      model: text(value.model) || null,
      title: text(value.title) || "New chat",
      createdAt: count(value.createdAt),
      updatedAt: count(value.updatedAt),
      status: value.status === "failed" ? "failed" : "idle",
      usage: { input: count(usage?.input), output: count(usage?.output), cached: count(usage?.cached) },
      messages: (Array.isArray(value.messages) ? value.messages : [])
        .map(normalizeMessage)
        .filter((message): message is ZaicodeSubchatMessage => message !== null)
        .slice(-ZAICODE_SUBCHAT_MAX_MESSAGES),
    };
    if (value.status === "running") {
      conversation = appendZaicodeSubchatMessage(conversation, {
        id: `${conversation.id}:interrupted:${now}`,
        role: "note",
        text: "ZAICODE closed during this turn. Send again to continue the same session.",
        at: now,
      });
    }
    out.push(conversation);
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, ZAICODE_SUBCHAT_MAX_CONVERSATIONS);
}
