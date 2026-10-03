import { randomBytes, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, rm, rmdir } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { dirname } from "node:path";
import type { IPty } from "node-pty";
import {
  readFrames,
  closeConnection,
  sendFrame,
  validSize,
  type WorkerTerminalConfig,
  type WorkerFrame,
} from "./workerTerminalProtocol.js";

function sameToken(value: unknown, expected: string): boolean {
  return (
    typeof value === "string" &&
    value.length === expected.length &&
    timingSafeEqual(Buffer.from(value), Buffer.from(expected))
  );
}

async function serve(config: WorkerTerminalConfig, configPath: string): Promise<void> {
  const peers = new Set<Socket>();
  let app: Socket | undefined;
  let external: Socket | undefined;
  let pty: IPty | undefined;
  let lease: string | undefined;
  let leaseTimer: NodeJS.Timeout | undefined;
  let closing = false;
  let replay = "";
  const nodePty = await import("node-pty");
  const stop = (kill = true) => {
    if (closing) return;
    closing = true;
    clearTimeout(startupTimer);
    clearTimeout(leaseTimer);
    const release = () => {
      for (const peer of peers) closeConnection(peer);
      server.close(() => {
        void rm(configPath, { force: true })
          .then(() => rmdir(dirname(configPath)))
          .catch(() => {})
          // node-pty 的读线程在自然退出后仍可保持 event loop；独立进程已经交付全部 exit 数据，可以结束。
          .finally(() => process.exit(0));
      });
    };
    if (kill && pty) {
      // 仅结束本 broker 所持有的 shell 子树；先完成 OS 终止，再释放 native PTY，避免后台 CLI 成为孤儿。
      execFile(
        "taskkill.exe",
        ["/PID", String(pty.pid), "/T", "/F"],
        { windowsHide: true, timeout: 5000 },
        () => {
          try {
            pty?.kill();
          } catch {
            /* process already exited */
          }
          release();
        },
      );
    } else release();
  };
  const reply = (peer: Socket, request: WorkerFrame, result: Record<string, unknown>) => {
    if (!Number.isSafeInteger(request.id)) throw new Error("request id");
    sendFrame(peer, { type: "reply", id: request.id, ...result });
  };
  const server = createServer((peer) => {
    peers.add(peer);
    let role: "app" | "external" | undefined;
    const authTimer = setTimeout(() => peer.destroy(), 5000);
    readFrames(peer, (message) => {
      if (!role) {
        if (message.type !== "hello" || !sameToken(message.token, config.token))
          throw new Error("auth");
        if (message.role === "app" && !app && !pty) {
          app = peer;
          role = "app";
          // 系统 ConPTY 会吞掉 PowerShell 的非 BMP 输入；同一 PSReadLine 下 bundled DLL 保留 emoji。
          // 独立 owner 已在 socket flush / server close 后退出，释放 DLL 的残留读取线程。
          pty = nodePty.spawn(config.shell, [], {
            name: "xterm-256color",
            cols: config.cols,
            rows: config.rows,
            cwd: config.cwd,
            env: process.env,
            encoding: "utf8",
            useConpty: true,
            useConptyDll: true,
          });
          clearTimeout(startupTimer);
          pty.onData((data) => {
            replay = (replay + data).slice(-64 * 1024);
            sendFrame(external ?? app!, { type: "data", data });
          });
          pty.onExit(({ exitCode }) => {
            for (const socket of [app, external])
              if (socket) sendFrame(socket, { type: "exit", code: exitCode });
            stop(false);
          });
        } else if (
          message.role === "external" &&
          app &&
          pty &&
          !external &&
          lease &&
          sameToken(message.lease, lease)
        ) {
          // 必须等外部控制台已准备输入/输出才交接；关闭旧 host 不再杀掉同一 ConPTY。
          external = peer;
          role = "external";
          lease = undefined;
          clearTimeout(leaseTimer);
          sendFrame(peer, { type: "welcome", pid: pty.pid });
          if (replay) sendFrame(peer, { type: "data", data: replay });
          sendFrame(app, { type: "handoff", pid: pty.pid });
        } else throw new Error("attachment unavailable");
        clearTimeout(authTimer);
        if (role === "app") sendFrame(peer, { type: "welcome", pid: pty!.pid });
        return;
      }
      if (role === "app" && message.type === "abort") {
        if (!external && sameToken(message.lease, lease ?? "")) {
          lease = undefined;
          clearTimeout(leaseTimer);
        }
        reply(peer, message, { ok: true, state: external ? "external" : "app", pid: pty!.pid });
        return;
      }
      if (role === "app" && message.type === "prepare") {
        if (external) {
          reply(peer, message, { ok: false, error: "Terminal already transferred" });
          return;
        }
        lease ??= randomBytes(32).toString("hex");
        clearTimeout(leaseTimer);
        leaseTimer = setTimeout(() => {
          lease = undefined;
        }, 15_000);
        reply(peer, message, { ok: true, lease });
        return;
      }
      if (peer !== (external ?? app)) throw new Error("Terminal transferred");
      if (
        message.type === "write" &&
        typeof message.data === "string" &&
        message.data.length <= 64 * 1024
      )
        pty!.write(message.data);
      else if (message.type === "resize" && validSize(message.cols) && validSize(message.rows)) {
        try {
          pty!.resize(message.cols, message.rows);
        } catch (error) {
          // node-pty 在 onExit 发布前已记录 OS 退出；此时 resize 的已退出错误不能被当作协议错误断开 pipe。
          // 保留连接等待原始 exit 事件，其他真实 resize 错误仍拒绝。
          if (
            !(error instanceof Error) ||
            error.message !== "Cannot resize a pty that has already exited"
          )
            throw error;
        }
      } else if (message.type === "stop") stop();
      else throw new Error("invalid operation");
    });
    peer.on("close", () => {
      clearTimeout(authTimer);
      peers.delete(peer);
      if (peer === external || (peer === app && !external)) stop();
    });
  });
  server.on("error", () => stop());
  const startupTimer = setTimeout(() => stop(), 15_000);
  server.listen(config.pipe);
}

const [mode, configPath] = process.argv.slice(2);
try {
  if (!configPath || mode !== "--server") throw new Error("Invalid terminal broker invocation");
  const config = JSON.parse(await readFile(configPath, "utf8")) as WorkerTerminalConfig;
  if (
    !config.pipe.startsWith("\\\\.\\pipe\\zaicode-worker-") ||
    !/^[a-f0-9]{64}$/.test(config.token) ||
    !validSize(config.cols) ||
    !validSize(config.rows) ||
    typeof config.shell !== "string" ||
    typeof config.cwd !== "string"
  )
    throw new Error("Invalid terminal broker configuration");
  await serve(config, configPath);
} catch (error) {
  process.stderr.write(
    `Worker terminal: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
