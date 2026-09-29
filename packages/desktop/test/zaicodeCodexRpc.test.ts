import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import { parseCodexRateLimits, parseCodexResetCredits } from "@zcode/shared";
import { codexRpcCall, consumeCodexResetCredit, type CodexRpcOptions } from "../src/main/zaicodeCodexRpc.js";

// T-130 (SRC-093): Codex hands out reset credits; ZAICODE read the windows and dropped them. These tests run the real request
// code against a stand-in `codex app-server` (a node script that speaks the same JSON-RPC lines), so the read, the spending of
// one credit and every way the process can go wrong are exercised without touching an account.

const FAKE_SERVER = `
const fs = require("node:fs");
const mode = process.env.FAKE_MODE || "ok";
const log = (entry) => process.env.FAKE_LOG && fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(entry) + "\\n");
let buffer = "";
if (mode === "exit") process.exit(0);
const reply = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let at = buffer.indexOf("\\n");
  while (at >= 0) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    at = buffer.indexOf("\\n");
    if (!line) continue;
    const message = JSON.parse(line);
    log({ method: message.method, params: message.params });
    if (message.method === "initialize") {
      if (mode === "garbage") process.stdout.write("this is not json\\n{broken\\n");
      if (mode === "initError") reply({ id: message.id, error: { message: "not supported here" } });
      else reply({ id: message.id, result: {} });
    } else if (message.method === "account/rateLimits/read") {
      if (mode === "hang") continue;
      reply({
        id: message.id,
        result: {
          rateLimits: { planType: "plus", primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1790731765 }, secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1791066341 } },
          rateLimitResetCredits: { availableCount: 1, credits: [{ id: "credit-1", resetType: "codexRateLimits", status: "available", grantedAt: 1790707469, expiresAt: 1793299469, title: "Full reset (Weekly + 5 hr)", description: "Thanks for using Codex!" }] },
        },
      });
    } else if (message.method === "account/rateLimitResetCredit/consume") {
      if (mode === "rpcError") reply({ id: message.id, error: { message: "x".repeat(400) } });
      else if (mode === "noOutcome") reply({ id: message.id, result: { something: "else" } });
      else reply({ id: message.id, result: { outcome: process.env.FAKE_OUTCOME || "reset" } });
    }
  }
});
`;

function scratch(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "zaicode-codex-rpc-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, "fake-codex.cjs");
  writeFileSync(script, FAKE_SERVER);
  const logFile = join(dir, "calls.log");
  const children: ChildProcess[] = [];
  const done: ChildProcess[] = [];
  const options = (env: Record<string, string> = {}, timeoutMs = 10_000): CodexRpcOptions => ({
    command: { file: process.execPath, args: [script] },
    env: { ...process.env, FAKE_LOG: logFile, ...env },
    timeoutMs,
    onChild: (child) => children.push(child),
    onChildDone: (child) => done.push(child),
  });
  const calls = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { method: string; params?: Record<string, unknown> }) : []);
  return { options, calls, children, done };
}

test("R1 a quota read returns the windows AND the reset credits, and the credits come out as the person will see them", async (t) => {
  const { options, calls } = scratch(t);
  const answer = await codexRpcCall(options(), "account/rateLimits/read");
  assert.ok(answer.ok);
  const parsed = parseCodexRateLimits(answer.ok ? answer.result : null);
  assert.deepEqual(parsed.windows.map((window) => [window.key, window.remainingPercent]), [["five_hour", 100], ["weekly", 0]]);
  const credits = parseCodexResetCredits(answer.ok ? answer.result : null);
  assert.equal(credits?.availableCount, 1);
  assert.deepEqual(credits?.credits?.map((credit) => [credit.id, credit.title, credit.expiresAt, credit.status]), [["credit-1", "Full reset (Weekly + 5 hr)", 1793299469000, "available"]]);
  assert.deepEqual(calls().map((call) => call.method), ["initialize", "initialized", "account/rateLimits/read"], "a read asks nothing else and spends nothing");
});

test("R2 spending a credit sends the credit id and this attempt's key, once, and reports what the server said", async (t) => {
  const { options, calls } = scratch(t);
  const result = await consumeCodexResetCredit((method, params) => codexRpcCall(options(), method, params), "Codex 2", "credit-1", "attempt-1");
  assert.deepEqual(result, { outcome: "reset", message: "Codex 2: reset used. The spent windows are refilled." });
  const spends = calls().filter((call) => call.method === "account/rateLimitResetCredit/consume");
  assert.equal(spends.length, 1, "one request, one spend");
  assert.deepEqual(spends[0]!.params, { creditId: "credit-1", idempotencyKey: "attempt-1" });
});

test("R3 'use one' without a credit id lets the backend pick; every answer the server can give has its own sentence", async (t) => {
  const { options, calls } = scratch(t);
  await consumeCodexResetCredit((method, params) => codexRpcCall(options(), method, params), "Codex 2", null, "k");
  assert.deepEqual(calls().find((call) => call.method === "account/rateLimitResetCredit/consume")!.params, { creditId: null, idempotencyKey: "k" });
  const said = new Map<string, string>();
  for (const outcome of ["nothingToReset", "noCredit", "alreadyRedeemed"]) {
    const result = await consumeCodexResetCredit((method, params) => codexRpcCall(options({ FAKE_OUTCOME: outcome }), method, params), "Codex 2", "credit-1", "k2");
    assert.equal(result.outcome, outcome);
    said.set(outcome, result.message);
  }
  assert.match(said.get("nothingToReset")!, /nothing to reset right now .* the reset was kept/);
  assert.match(said.get("noCredit")!, /no reset credit is left/);
  assert.match(said.get("alreadyRedeemed")!, /already used a moment ago/);
});

test("R4 every way the process can go wrong is 'unavailable, nothing was spent', with the reason", async (t) => {
  const { options } = scratch(t);
  const spend = (env: Record<string, string>, timeoutMs?: number) =>
    consumeCodexResetCredit((method, params) => codexRpcCall(options(env, timeoutMs), method, params), "Codex 2", "credit-1", "k");
  const initError = await spend({ FAKE_MODE: "initError" });
  assert.equal(initError.outcome, "unavailable");
  assert.match(initError.message, /initialize: not supported here.*Nothing was spent/);
  const exited = await spend({ FAKE_MODE: "exit" });
  assert.match(exited.message, /codex app-server exited.*Nothing was spent/);
  const wrong = await spend({ FAKE_MODE: "noOutcome" });
  assert.match(wrong.message, /unexpected answer from codex.*Nothing was spent/);
  const rpc = await spend({ FAKE_MODE: "rpcError" });
  assert.equal(rpc.outcome, "unavailable");
  assert.ok(rpc.message.length < 260, "a huge error text is cut");
});

test("R5 a server that never answers is given up on at the deadline and its process is ended", async (t) => {
  const { options, children, done } = scratch(t);
  const started = Date.now();
  const answer = await codexRpcCall(options({ FAKE_MODE: "hang" }, 400), "account/rateLimits/read");
  assert.deepEqual(answer, { ok: false, error: "timed out waiting for codex" });
  assert.ok(Date.now() - started < 5000);
  assert.equal(children.length, 1);
  assert.deepEqual(done, children, "the owner is told the child is done");
  const pid = children[0]!.pid!;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.throws(() => process.kill(pid, 0), "the process is gone");
});

test("R6 noise before the answer is ignored; a missing program is an error, not a crash", async (t) => {
  const { options, calls } = scratch(t);
  const answer = await codexRpcCall(options({ FAKE_MODE: "garbage" }), "account/rateLimits/read");
  assert.ok(answer.ok);
  assert.equal(calls().filter((call) => call.method === "account/rateLimits/read").length, 1);
  const missing = await codexRpcCall({ command: { file: join(tmpdir(), "no-such-codex-program.exe"), args: [] }, env: process.env, timeoutMs: 3000 }, "account/rateLimits/read");
  assert.equal(missing.ok, false);
});
