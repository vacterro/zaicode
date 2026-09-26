import assert from "node:assert/strict";
import test from "node:test";
import {
  applyZaicodeSubchatEvent,
  buildZaicodeSubchatInvocation,
  normalizeZaicodeEnginesConfig,
  normalizeZaicodeSubchatConversations,
  parseAntigravityUsage,
  parseZaicodeClaudeStreamLine,
  parseZaicodeCodexJsonLine,
  zaicodeSubchatAutoModel,
  zaicodeSubchatTitle,
  zaicodeSubchatUnavailableReason,
  ZAICODE_SUBCHAT_MAX_MESSAGES,
  type ZaicodeEngineAccount,
  type ZaicodeSubchatConversation,
  type ZaicodeSubchatEvent,
} from "@zcode/shared";
import { normalizeZaicodeLayoutList, ZAICODE_NAV_ITEMS } from "../src/zaicode/zaicodeLayoutPrefs.js";

// T-51 (SRC-038): Claude Code / Codex subscriptions answer in an in-app chat, no worker.

function account(patch: Partial<ZaicodeEngineAccount>): ZaicodeEngineAccount {
  return {
    id: "claude:C:/Users/me/.claude-account2",
    vendor: "claude",
    short: "A2",
    label: "Claude 2",
    source: "C:/Users/me/.claude-account2",
    home: "C:/Users/me/.claude-account2",
    isDefaultHome: false,
    cli: "C:/tools/claude.exe",
    status: "ready",
    statusDetail: "",
    fixCommand: null,
    ...patch,
  };
}

function conversation(patch: Partial<ZaicodeSubchatConversation> = {}): ZaicodeSubchatConversation {
  return {
    id: "chat-1",
    accountId: "codex:C:/Users/me/.codex-2",
    vendor: "codex",
    short: "C2",
    label: "Codex 2",
    projectPath: "V:/work/project",
    sessionId: null,
    model: null,
    title: "New chat",
    createdAt: 1000,
    updatedAt: 1000,
    status: "running",
    usage: { input: 0, output: 0, cached: 0 },
    messages: [],
    ...patch,
  };
}

test("every ready subscription login can chat in-app (SRC-048); the rest say why", () => {
  assert.equal(zaicodeSubchatUnavailableReason(account({})), null);
  assert.equal(zaicodeSubchatUnavailableReason(account({ vendor: "codex", short: "C1" })), null);
  assert.equal(zaicodeSubchatUnavailableReason(account({ vendor: "antigravity", label: "Antigravity" })), null);
  assert.equal(zaicodeSubchatUnavailableReason(account({ vendor: "zcode", label: "ZCode" })), null);
  assert.match(zaicodeSubchatUnavailableReason(account({ vendor: "freebuff", label: "Freebuff" })) ?? "", /limits only/);
  assert.equal(
    zaicodeSubchatUnavailableReason(account({ status: "login-required", statusDetail: "Sign in: claude /login" })),
    "Sign in: claude /login",
  );
  assert.match(zaicodeSubchatUnavailableReason(account({ cli: null, status: "cli-missing", statusDetail: "" })) ?? "", /not installed/);
});

test("Claude turn: headless stream-json in the account's own home, prompt on stdin, resume by session", () => {
  const first = buildZaicodeSubchatInvocation(account({}), { prompt: "hello\n\"quoted\" & more", sessionId: null, yolo: true });
  assert.deepEqual(first?.args, ["-p", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"]);
  assert.equal(first?.stdin, "hello\n\"quoted\" & more");
  assert.equal(first?.env.CLAUDE_CONFIG_DIR, "C:/Users/me/.claude-account2");
  assert.equal(first?.env.CLAUDECODE, null, "a nested-Claude marker never reaches the child");

  const next = buildZaicodeSubchatInvocation(account({ isDefaultHome: true }), {
    prompt: "again",
    sessionId: "3f2c8a8e-1b7c-4c3e-9d7a-0a1b2c3d4e5f",
    yolo: false,
  });
  assert.deepEqual(next?.args.slice(4), ["--resume", "3f2c8a8e-1b7c-4c3e-9d7a-0a1b2c3d4e5f", "--permission-mode", "acceptEdits"]);
  assert.equal(next?.env.CLAUDE_CONFIG_DIR, null, "the default account clears the override");

  const hostile = buildZaicodeSubchatInvocation(account({}), { prompt: "x", sessionId: "--dangerous; rm -rf", yolo: false });
  assert.ok(!hostile?.args.includes("--resume"), "a malformed session id starts a new session, never an argument");
});

test("Codex turn: exec --json, resume <id>, CODEX_HOME per account, sandbox unless YOLO", () => {
  const codex = account({ id: "codex:C:/Users/me/.codex-2", vendor: "codex", short: "C2", home: "C:/Users/me/.codex-2" });
  const first = buildZaicodeSubchatInvocation(codex, { prompt: "fix it", sessionId: null, yolo: false });
  assert.deepEqual(first?.args, ["exec", "--json", "--skip-git-repo-check", "-c", 'sandbox_mode="workspace-write"', "-"]);
  assert.deepEqual(first?.env, { CODEX_HOME: "C:/Users/me/.codex-2" });
  const next = buildZaicodeSubchatInvocation(codex, { prompt: "more", sessionId: "0199a213-81c0-7800-8aa1-bbab2a035a53", yolo: true });
  assert.deepEqual(next?.args, [
    "exec",
    "resume",
    "--json",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "0199a213-81c0-7800-8aa1-bbab2a035a53",
    "-",
  ]);
  assert.equal(buildZaicodeSubchatInvocation(account({ vendor: "freebuff" }), { prompt: "x", sessionId: null, yolo: true }), null);
});

test("Claude stream-json: session, text and tool lines, usage, success and failure", () => {
  const init = parseZaicodeClaudeStreamLine(
    JSON.stringify({ type: "system", subtype: "init", session_id: "abc-123", model: "claude-opus-5-5", tools: ["Bash"] }),
  );
  assert.deepEqual(init, [{ type: "session", sessionId: "abc-123", model: "claude-opus-5-5" }]);
  const assistant = parseZaicodeClaudeStreamLine(
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "Looking at the tests." },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "pnpm   test\n --run", description: "run" } },
          { type: "tool_use", id: "t2", name: "Read", input: { file_path: "src/a.ts" } },
        ],
      },
    }),
  );
  assert.deepEqual(assistant, [
    { type: "text", text: "Looking at the tests." },
    { type: "tool", name: "Bash", detail: "pnpm test --run" },
    { type: "tool", name: "Read", detail: "src/a.ts" },
  ]);
  assert.deepEqual(parseZaicodeClaudeStreamLine(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result" }] } })), []);
  const done = parseZaicodeClaudeStreamLine(
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "All green.",
      usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 42 },
    }),
  );
  assert.deepEqual(done, [
    { type: "usage", input: 115, output: 42, cached: 100 },
    { type: "result", ok: true, message: null },
  ]);
  const failed = parseZaicodeClaudeStreamLine(
    JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Invalid API key · Please run /login" }),
  );
  assert.deepEqual(failed.at(-1), { type: "result", ok: false, message: "Invalid API key · Please run /login" });
  assert.deepEqual(parseZaicodeClaudeStreamLine("not json at all"), []);
  assert.deepEqual(parseZaicodeClaudeStreamLine("{broken"), []);
});

test("Codex exec --json: thread id, commands once, edits, answer, usage, turn failure", () => {
  const lines = [
    { type: "thread.started", thread_id: "0199a213-81c0-7800-8aa1-bbab2a035a53" },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "item_0", type: "reasoning", text: "**Planning**" } },
    { type: "item.started", item: { id: "item_1", type: "command_execution", command: "bash -lc ls", status: "in_progress" } },
    { type: "item.completed", item: { id: "item_1", type: "command_execution", command: "bash -lc ls", exit_code: 0 } },
    { type: "item.completed", item: { id: "item_2", type: "file_change", changes: [{ path: "a.ts", kind: "update" }, { path: "b.ts", kind: "add" }] } },
    { type: "item.completed", item: { id: "item_3", type: "agent_message", text: "Done: two files." } },
    { type: "turn.completed", usage: { input_tokens: 2000, cached_input_tokens: 1500, output_tokens: 90 } },
  ];
  const events = lines.flatMap((line) => parseZaicodeCodexJsonLine(JSON.stringify(line)));
  assert.deepEqual(events, [
    { type: "session", sessionId: "0199a213-81c0-7800-8aa1-bbab2a035a53", model: null },
    { type: "tool", name: "shell", detail: "bash -lc ls" },
    { type: "tool", name: "edit", detail: "a.ts, b.ts" },
    { type: "text", text: "Done: two files." },
    { type: "usage", input: 2000, output: 90, cached: 1500 },
    { type: "result", ok: true, message: null },
  ]);
  assert.deepEqual(parseZaicodeCodexJsonLine(JSON.stringify({ type: "turn.failed", error: { message: "usage limit reached" } })), [
    { type: "result", ok: false, message: "usage limit reached" },
  ]);
  assert.deepEqual(parseZaicodeCodexJsonLine(JSON.stringify({ type: "error", message: "stream disconnected" })), [
    { type: "error", message: "stream disconnected" },
  ]);
});

test("transcript: events become messages, usage sums, a stop is a note and a failure an error", () => {
  const events: ZaicodeSubchatEvent[] = [
    { type: "session", sessionId: "s-1", model: "gpt-5" },
    { type: "tool", name: "shell", detail: "ls" },
    { type: "text", text: "Hi." },
    { type: "usage", input: 10, output: 2, cached: 5 },
    { type: "result", ok: true, message: null },
  ];
  let chat = conversation();
  events.forEach((event, index) => {
    chat = applyZaicodeSubchatEvent(chat, event, 2000 + index, `m${index}`);
  });
  assert.equal(chat.sessionId, "s-1");
  assert.equal(chat.model, "gpt-5");
  assert.equal(chat.status, "idle");
  assert.deepEqual(
    chat.messages.map((message) => [message.role, message.text]),
    [
      ["tool", "shell: ls"],
      ["assistant", "Hi."],
    ],
  );
  assert.deepEqual(chat.usage, { input: 10, output: 2, cached: 5 });
  const stopped = applyZaicodeSubchatEvent(conversation(), { type: "result", ok: true, message: "Stopped." }, 3000, "x");
  assert.equal(stopped.status, "idle");
  assert.equal(stopped.messages.at(-1)?.role, "note");
  const failed = applyZaicodeSubchatEvent(conversation(), { type: "result", ok: false, message: "usage limit reached" }, 3000, "y");
  assert.equal(failed.status, "failed");
  assert.equal(failed.messages.at(-1)?.role, "error");
  let long = conversation();
  for (let index = 0; index < ZAICODE_SUBCHAT_MAX_MESSAGES + 5; index += 1) {
    long = applyZaicodeSubchatEvent(long, { type: "text", text: `t${index}` }, 4000 + index, `k${index}`);
  }
  assert.equal(long.messages.length, ZAICODE_SUBCHAT_MAX_MESSAGES);
  assert.equal(long.messages[0]?.text, "t5", "the oldest messages go first");
});

test("stored chats: junk dropped, newest first, a turn that died with the app is idle with a note", () => {
  const stored = [
    conversation({ id: "old", status: "idle", updatedAt: 10 }),
    conversation({ id: "died", status: "running", updatedAt: 20, sessionId: "s-9" }),
    { id: "x", vendor: "freebuff", accountId: "a", projectPath: "p" },
    null,
    "junk",
  ];
  const chats = normalizeZaicodeSubchatConversations(JSON.parse(JSON.stringify(stored)), 99);
  assert.deepEqual(
    chats.map((chat) => chat.id),
    ["died", "old"],
  );
  assert.equal(chats[0]?.status, "idle");
  assert.equal(chats[0]?.sessionId, "s-9", "the vendor session survives, so Send continues it");
  assert.equal(chats[0]?.messages.at(-1)?.role, "note");
  assert.deepEqual(normalizeZaicodeSubchatConversations({ not: "a list" }), []);
});

test("titles, the setting default and the SUBCHAT menu line", () => {
  assert.equal(zaicodeSubchatTitle("  fix   the\nbuild  "), "fix the build");
  assert.equal(zaicodeSubchatTitle(""), "New chat");
  assert.equal(zaicodeSubchatTitle("x".repeat(100)).length, 60);
  assert.equal(normalizeZaicodeEnginesConfig(null).subscriptionPrompts, "chat", "the operator asked for chat, not WORKERS");
  assert.equal(normalizeZaicodeEnginesConfig({ subscriptionPrompts: "worker" }).subscriptionPrompts, "worker");
  assert.equal(normalizeZaicodeEnginesConfig({ subscriptionPrompts: "terminal" }).subscriptionPrompts, "chat");
  const stored = normalizeZaicodeLayoutList(
    [
      { id: "saihome", visible: true },
      { id: "newTask", visible: true },
      { id: "zaicode", visible: true },
    ],
    ZAICODE_NAV_ITEMS,
  );
  const ids = stored.map((entry) => entry.id);
  assert.equal(ids.indexOf("subchat"), ids.indexOf("newTask") + 1, "an existing menu gains SUBCHAT right after New task");
  assert.equal(stored.find((entry) => entry.id === "subchat")?.visible, true);
});

test("a failed turn that says it twice shows one error, with the vendor's reset time intact", () => {
  // Real streams (2026-09-25): Claude A1 at its session limit, Codex C2 at its usage limit.
  const limit = "You've hit your session limit · resets 10pm (Europe/Tallinn)";
  let claude = conversation({ vendor: "claude", short: "A1" });
  for (const line of [
    { type: "system", subtype: "init", session_id: "ad2440f7-6a91-4275-b3e8-9a2503b2f4b6", model: "claude-opus-5-5" },
    { type: "assistant", message: { content: [{ type: "text", text: limit }] } },
    { type: "result", subtype: "success", is_error: true, result: limit, usage: { input_tokens: 0, output_tokens: 0 } },
  ]) {
    for (const event of parseZaicodeClaudeStreamLine(JSON.stringify(line))) claude = applyZaicodeSubchatEvent(claude, event, 5000, `c${claude.messages.length}`);
  }
  assert.equal(claude.status, "failed");
  assert.deepEqual(
    claude.messages.map((message) => [message.role, message.text]),
    [["error", limit]],
  );

  const codexLimit =
    "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 30th, 2026 2:21 AM.";
  let codex = conversation();
  for (const line of [
    { type: "thread.started", thread_id: "01a0d984-8c83-7d93-b96e-1fd57924c26f" },
    { type: "turn.started" },
    { type: "error", message: codexLimit },
    { type: "turn.failed", error: { message: codexLimit } },
  ]) {
    for (const event of parseZaicodeCodexJsonLine(JSON.stringify(line))) codex = applyZaicodeSubchatEvent(codex, event, 5000, `x${codex.messages.length}`);
  }
  assert.equal(codex.messages.length, 1);
  assert.equal(codex.messages[0]?.role, "error");
  assert.match(codex.messages[0]?.text ?? "", /try again at Sep 30th, 2026 2:21 AM\.$/);
});

test("Antigravity asks for the pool that still has quota (SRC-048): Gemini spent -> Claude & GPT", () => {
  const now = Date.UTC(2026, 8, 26, 3, 0);
  const pools = (gemini: number, claude: number) =>
    parseAntigravityUsage({
      command: {
        data: {
          groups: [
            { name: "Gemini Models", buckets: [{ window: "weekly", remaining_fraction: gemini, reset_time: "2026-09-30T09:41:00Z" }] },
            {
              name: "Claude and GPT models",
              buckets: [
                { window: "5h", remaining_fraction: claude, reset_time: "2026-09-26T08:00:00Z" },
                { window: "weekly", remaining_fraction: 1, reset_time: "2026-10-02T19:16:00Z" },
              ],
            },
          ],
        },
      },
    });
  assert.equal(zaicodeSubchatAutoModel("antigravity", pools(0, 1), now), "claude-sonnet-4-6", "the screenshot: Gemini 0 %, Claude & GPT 100 %");
  assert.equal(zaicodeSubchatAutoModel("antigravity", pools(0.4, 1), now), null, "the CLI's default pool while it has quota");
  assert.equal(zaicodeSubchatAutoModel("antigravity", pools(0, 0), now), null, "everything spent: the CLI's default and its own error");
  assert.equal(zaicodeSubchatAutoModel("antigravity", [], now), null, "no limits read yet");
  assert.equal(zaicodeSubchatAutoModel("claude", pools(0, 1), now), null, "one pool per login elsewhere");
  const agy = account({ vendor: "antigravity", short: "AG", home: null });
  const args = buildZaicodeSubchatInvocation(agy, { prompt: "hi", sessionId: null, yolo: false, model: "claude-sonnet-4-6" })?.args ?? [];
  assert.deepEqual(args.slice(-2), ["--model", "claude-sonnet-4-6"]);
});
