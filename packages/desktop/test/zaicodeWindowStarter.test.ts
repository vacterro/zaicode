import assert from "node:assert/strict";
import { test } from "node:test";
import {
  antigravityWindowStartArgs,
  claudeWindowStartArgs,
  codexWindowStartArgs,
  readAntigravityWindowStart,
  readClaudeWindowStart,
  readCodexWindowStart,
  readZcodeWindowStart,
  zcodeWindowStartRequest,
} from "../src/main/zaicodeWindowStarter.js";

/** T-136 (SRC-100): the smallest request that starts an idle 5h window. */

test("the Claude start has no tools, no MCP, no user hooks, the cheapest model, no saved session", () => {
  const args = claudeWindowStartArgs();
  const after = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(args[0], "-p");
  assert.equal(after("--model"), "haiku");
  assert.equal(after("--tools"), "");
  assert.equal(after("--setting-sources"), "project");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.ok(args.includes("--no-session-persistence"));
  assert.equal(after("--output-format"), "json");
  assert.ok(after("--system-prompt")!.length < 40);
});

test("the Codex start is read-only, low effort, ephemeral and outside any repository", () => {
  const args = codexWindowStartArgs();
  assert.equal(args[0], "exec");
  assert.ok(args.includes("--ephemeral"));
  assert.ok(args.includes("--skip-git-repo-check"));
  assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
  assert.ok(args.includes("model_reasoning_effort=low"));
  // The user's config.toml carries hooks and MCP servers: a window start runs none of them.
  assert.ok(args.includes("--ignore-user-config"));
  assert.ok(args.includes("--ignore-rules"));
});

test("a Claude answer that is not an error counts as started and names its tokens", () => {
  const outcome = readClaudeWindowStart(
    true,
    'noise {"type":"result","is_error":false,"result":"ok","usage":{"input_tokens":9,"output_tokens":2}}',
    "",
  );
  assert.equal(outcome.ok, true);
  assert.match(outcome.detail, /9 in \/ 2 out tokens/);
});

test("a refused or unreadable Claude start is a failure with the vendor's words", () => {
  const refused = readClaudeWindowStart(false, '{"is_error":true,"result":"Invalid API key \\u00b7 Please run /login"}', "");
  assert.equal(refused.ok, false);
  assert.match(refused.detail, /Invalid API key/);
  const silent = readClaudeWindowStart(false, "", "timed out");
  assert.deepEqual(silent, { ok: false, detail: "timed out" });
});

test("codex exec: exit 0 started, anything else is a failure", () => {
  assert.equal(readCodexWindowStart(true, "ok", "").ok, true);
  const failed = readCodexWindowStart(false, "", "You've hit your usage limit");
  assert.equal(failed.ok, false);
  assert.match(failed.detail, /usage limit/);
});

test("Antigravity starts with one sandboxed low-effort Flash request", () => {
  const args = antigravityWindowStartArgs();
  assert.equal(args[0], "-p");
  assert.equal(args[args.indexOf("--output-format") + 1], "json");
  assert.equal(args[args.indexOf("--model") + 1], "gemini-3.5-flash-medium");
  assert.equal(args[args.indexOf("--effort") + 1], "low");
  assert.ok(args.includes("--sandbox"));
  assert.ok(!args.includes("--dangerously-skip-permissions"));
  assert.equal(readAntigravityWindowStart(true, '{"status":"SUCCESS","response":"ok","usage":{"total_tokens":7}}', "").ok, true);
  assert.equal(readAntigravityWindowStart(true, '{"status":"ERROR","error":"model unavailable"}', "").ok, false);
});

test("ZCode start uses only the configured vendor's coding-only endpoint", () => {
  const request = zcodeWindowStartRequest("https://api.z.ai/api/coding/paas/v4");
  assert.equal(request?.url, "https://api.z.ai/api/coding/paas/v4/chat/completions");
  assert.equal(request?.body.model, "GLM-5.3-Flash");
  assert.equal(request?.body.max_tokens, 1);
  assert.equal(request?.body.stream, false);
  assert.equal(request?.body.messages.length, 1);
  assert.equal(zcodeWindowStartRequest("https://api.z.ai/api/paas/v4"), null, "never bill the general prepaid API");
  assert.equal(zcodeWindowStartRequest("https://untrusted.example/api/coding/paas/v4"), null);
});

test("ZCode accepts a real completion and redacts provider failure bodies", () => {
  const accepted = readZcodeWindowStart(200, '{"choices":[{"message":{"content":"ok"}}],"usage":{"total_tokens":2}}');
  assert.equal(accepted.ok, true);
  assert.match(accepted.detail, /2 tokens/);
  assert.deepEqual(readZcodeWindowStart(401, '{"message":"secret-key"}'), { ok: false, detail: "HTTP 401" });
  assert.equal(readZcodeWindowStart(200, '{"not_a_completion":true}').ok, false);
});
