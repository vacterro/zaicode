/**
 * Stand-ins for the ZAICODE fault matrix (T-43): a 9router-shaped server that
 * can die and come back, a free local port, a subscription CLI that holds its
 * answer until a shared signal (so a dozen workers finish at one instant),
 * and the manual scenarios an agent cannot drive.
 */
import { createServer } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

/** 9router's shape as ZAICODE uses it: /api/health, /api/providers; PORT / HOSTNAME from the supervisor. */
const STUB_ROUTER = `
const http = require("node:http");
const started = Date.now();
http
  .createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/api/health") return send(200, { ok: true, pid: process.pid, started });
    if (req.url === "/api/providers") return send(200, { connections: [] });
    return send(404, { error: "not found" });
  })
  .listen(Number(process.env.PORT), process.env.HOSTNAME || "127.0.0.1");
`;

/** A package folder the router supervisor accepts (app/server.js). */
export async function writeStubRouterPackage(dir: string): Promise<string> {
  await mkdir(join(dir, "app"), { recursive: true });
  await writeFile(join(dir, "app", "server.js"), STUB_ROUTER);
  return dir;
}

/**
 * Codex-shaped CLI: announces its thread at once, then answers only when the
 * file named by ZAICODE_FAULT_GO exists, echoing its prompt, and exits.
 */
const WAITING_CLI = `
const { existsSync } = require("node:fs");
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (prompt += chunk));
process.stdin.on("end", () => {
  const out = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
  out({ type: "thread.started", thread_id: "thread-" + prompt.trim() });
  const timer = setInterval(() => {
    if (!existsSync(process.env.ZAICODE_FAULT_GO)) return;
    clearInterval(timer);
    out({ type: "item.completed", item: { type: "agent_message", text: "answer " + prompt.trim() } });
    out({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } });
    process.exit(0);
  }, 10);
});
`;

export async function writeWaitingCli(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, "waiting-cli.js");
  await writeFile(path, WAITING_CLI);
  return path;
}

export interface ManualScenario {
  id: string;
  scenario: string;
  why: string;
  steps: string;
  expected: string;
}

/** SRC-033's scenarios that need a real desktop session, a real OS or a real network. */
export const ZAICODE_MANUAL_FAULTS: readonly ManualScenario[] = [
  {
    id: "renderer-kill",
    scenario: "Kill the ZAICODE renderer",
    why: "the renderer is a Chromium process inside the running app",
    steps: "Task Manager -> Details -> end the ZAICODE process with --type=renderer while a session works.",
    expected: "The window reloads; sessions cut off show INTERRUPTED, never DONE; a window reload never auto-continues (crash resume skips reloads).",
  },
  {
    id: "app-kill",
    scenario: "Kill the whole ZAICODE",
    why: "needs the packaged app and its root launcher (agents inside ZAICODE are refused this on purpose)",
    steps: "Task Manager -> end the ZAICODE process tree under the launcher while two sessions and one worker run.",
    expected: "The launcher restarts it; cut-off sessions show INTERRUPTED; with After a crash on they continue ~30 s after start, oldest first; the worker starts again with the same engine, project and prompt.",
  },
  {
    id: "sleep-resume",
    scenario: "Windows sleep / resume",
    why: "needs the OS power state",
    steps: "Put Windows to sleep for 10 min with a SCHEDULER entry due during the sleep, then wake it.",
    expected: "Clocks and reset timers show the right time at once; quota is re-read within one sweep; the due entry fires once, or is MISSED when older than the catch-up window.",
  },
  {
    id: "network-loss",
    scenario: "Network disappears during a turn",
    why: "needs the machine's network adapter",
    steps: "Disable the network adapter for 60 s while a SAIFREN session answers, then enable it.",
    expected: "The turn fails with the provider's error or retries; the session is not DONE; SAIHOME Routing shows degraded, then healthy.",
  },
  {
    id: "worker-detach",
    scenario: "Worker terminal detached / reattached",
    why: "window placement is a GUI action",
    steps: "Start a worker, move it to its own window, minimize it, dock it back.",
    expected: "Same worker, same PTY (the CLI keeps its screen and PID); nothing restarts.",
  },
  {
    id: "saimail-kill-delivery",
    scenario: "Kill a worker during SAIMAIL delivery",
    why: "needs a real seat mid-send; SAIMAIL's own soak suite owns delivery atomicity",
    steps: "In a worker, start `saimail-local send` of a large telegram and kill the worker at once.",
    expected: "The telegram arrives once or not at all (never torn); the index tail is either complete or skipped by the reader.",
  },
];
