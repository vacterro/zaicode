import { spawn, type ChildProcess } from "node:child_process";
import {
  describeZaicodeResetOutcome,
  parseCodexConsumeOutcome,
  type ZaicodeResetConsumeResult,
} from "@zcode/shared";

/**
 * One request to a `codex app-server` (T-130): start it, say hello, ask, take the answer, end it. Electron-free so it can be
 * run against a stand-in server in a test. The quota read and the spending of a reset credit are the two callers; both ask one
 * question of a process that lives for that question only.
 */

export interface CodexRpcCommand {
  file: string;
  args: string[];
}

export interface CodexRpcOptions {
  command: CodexRpcCommand;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** The owner tracks live children so a quit can end them, and kills the process tree it started. */
  onChild?: (child: ChildProcess) => void;
  onChildDone?: (child: ChildProcess) => void;
  kill?: (child: ChildProcess) => void;
}

export type CodexRpcResult = { ok: true; result: unknown } | { ok: false; error: string };

const DEFAULT_TIMEOUT_MS = 30_000;

export function codexRpcCall(options: CodexRpcOptions, method: string, params?: unknown): Promise<CodexRpcResult> {
  return new Promise((resolvePromise) => {
    let child: ChildProcess;
    try {
      child = spawn(options.command.file, options.command.args, { env: options.env, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    } catch (error) {
      resolvePromise({ ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    options.onChild?.(child);
    let buffer = "";
    let settled = false;
    const finish = (outcome: CodexRpcResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdin?.end();
      } catch {
        // already closed
      }
      (options.kill ?? ((process_) => void process_.kill()))(child);
      options.onChildDone?.(child);
      resolvePromise(outcome);
    };
    const timer = setTimeout(() => finish({ ok: false, error: "timed out waiting for codex" }), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const send = (message: Record<string, unknown>) => {
      try {
        child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
      } catch {
        // the close handler reports it
      }
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;
        type RpcMessage = { id?: unknown; result?: unknown; error?: { message?: unknown } };
        let message: RpcMessage | null;
        try {
          message = JSON.parse(line) as RpcMessage | null;
        } catch {
          continue;
        }
        if (message?.id === 1) {
          if (message.error) {
            finish({ ok: false, error: `initialize: ${String(message.error.message ?? "error")}` });
            return;
          }
          send({ method: "initialized" });
          send(params === undefined ? { id: 2, method } : { id: 2, method, params });
        } else if (message?.id === 2) {
          finish(message.error ? { ok: false, error: String(message.error.message ?? "request error").slice(0, 160) } : { ok: true, result: message.result });
        }
      }
    });
    child.on("error", (error) => finish({ ok: false, error: error.message }));
    child.on("close", () => finish({ ok: false, error: "codex app-server exited" }));
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "zaicode", version: "1.0.0" }, capabilities: null } });
  });
}

/**
 * Spends one reset credit and says what came of it. `creditId` null lets the backend pick the next one. The idempotency key names
 * THIS attempt: a retry of the same attempt reuses it, so a reset can never be spent twice by a repeated request.
 */
export async function consumeCodexResetCredit(
  call: (method: string, params?: unknown) => Promise<CodexRpcResult>,
  accountLabel: string,
  creditId: string | null,
  idempotencyKey: string,
): Promise<ZaicodeResetConsumeResult> {
  const answer = await call("account/rateLimitResetCredit/consume", { creditId, idempotencyKey });
  if (!answer.ok) return { outcome: "unavailable", message: describeZaicodeResetOutcome(accountLabel, "unavailable", answer.error) };
  const outcome = parseCodexConsumeOutcome(answer.result);
  if (!outcome) return { outcome: "unavailable", message: describeZaicodeResetOutcome(accountLabel, "unavailable", "unexpected answer from codex") };
  return { outcome, message: describeZaicodeResetOutcome(accountLabel, outcome) };
}
