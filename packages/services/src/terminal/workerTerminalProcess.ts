import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { workerTerminalConsoleCommand } from "./workerTerminalConsole.js";
import {
  readFrames,
  closeConnection,
  sendFrame,
  validSize,
  type WorkerFrame,
  type WorkerTerminalConfig,
} from "./workerTerminalProtocol.js";

export interface ExternalClientLaunch {
  configPath: string;
  lease: string;
  cwd: string;
}

export interface WorkerTerminalProcessOptions {
  entryPath?: URL;
  launchClient?: (launch: ExternalClientLaunch) => Promise<void>;
}

export interface WorkerTerminalProcess {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number }) => void): { dispose(): void };
  extractToPowerShell(): Promise<{ pid: number }>;
}

const quotePS = (value: string) => `'${value.replaceAll("'", "''")}'`;
const quoteArg = (value: string) =>
  `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;

export function externalClientCommand(launch: ExternalClientLaunch): string {
  return workerTerminalConsoleCommand(launch.configPath, launch.lease);
}

function runPowerShell(script: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        // console payload 已编码；再编码外层 launcher 会超过 Windows 命令行上限，实际打包交付无法启动。
        "-Command",
        `$ErrorActionPreference='Stop'; ${script}`,
      ],
      { env, windowsHide: true, stdio: ["ignore", "ignore", "pipe"], timeout: 15_000 },
    );
    let errorText = "";
    child.stderr.on("data", (data: Buffer) => {
      errorText = (errorText + data.toString()).slice(-4000);
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`PowerShell launch failed (${code}): ${errorText}`)),
    );
  });
}

async function resolveEntry(explicit?: URL): Promise<string> {
  const candidates = explicit
    ? [explicit]
    : [
        new URL("./workerTerminalBroker.js", import.meta.url),
        new URL("../host/workerTerminalBroker.js", import.meta.url),
        new URL("./workerTerminalBroker.ts", import.meta.url),
      ];
  for (const candidate of candidates) {
    try {
      const path = fileURLToPath(candidate);
      await access(path);
      return path;
    } catch {
      /* next known runtime layout */
    }
  }
  throw new Error("Worker terminal broker is unavailable in this runtime");
}

async function connect(pipe: string): Promise<Socket> {
  const deadline = Date.now() + 12_000;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = createConnection(pipe);
      const failed = (error: Error) => {
        socket.destroy();
        if (Date.now() >= deadline)
          reject(new Error(`Worker terminal broker did not start: ${error.message}`));
        else setTimeout(attempt, 50);
      };
      socket.once("error", failed);
      socket.once("connect", () => {
        socket.removeListener("error", failed);
        resolve(socket);
      });
    };
    attempt();
  });
}

export async function createWorkerTerminalProcess(
  params: { shell: string; cwd: string; cols: number; rows: number; env: NodeJS.ProcessEnv },
  options: WorkerTerminalProcessOptions = {},
): Promise<WorkerTerminalProcess> {
  if (process.platform !== "win32" || !validSize(params.cols) || !validSize(params.rows))
    throw new Error("External worker requires a Windows terminal");
  const entry = await resolveEntry(options.entryPath);
  const runtimeArgs = entry.endsWith(".ts")
    ? ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href]
    : [];
  const dir = await mkdtemp(join(tmpdir(), "zaicode-worker-"));
  const configPath = join(dir, "terminal.json");
  const token = randomBytes(32).toString("hex");
  const config: WorkerTerminalConfig = {
    pipe: `\\\\.\\pipe\\zaicode-worker-${token.slice(0, 24)}`,
    token,
    shell: params.shell,
    cwd: params.cwd,
    cols: params.cols,
    rows: params.rows,
  };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const launchBase = { configPath, cwd: params.cwd };
  let socket: Socket;
  try {
    const args = [...runtimeArgs, entry, "--server", configPath].map(quoteArg).join(" ");
    // detached 子进程仍属于 taskkill /T 的活进程树；短命 launcher 退出后 broker 才交付给 host。
    await runPowerShell(
      `Start-Process -FilePath ${quotePS(process.execPath)} -ArgumentList ${quotePS(args)} -WorkingDirectory ${quotePS(params.cwd)} -WindowStyle Hidden | Out-Null`,
      { ...params.env, ELECTRON_RUN_AS_NODE: "1" },
    );
    socket = await connect(config.pipe);
  } catch (error) {
    await rm(configPath, { force: true });
    await rm(dir, { recursive: true, force: true });
    throw error;
  }

  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(event: { exitCode: number }) => void>();
  const pending = new Map<
    number,
    { resolve(frame: WorkerFrame): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >();
  let sequence = 0;
  let pid = 0;
  let transferred = false;
  let closed = false;
  let exitReceived = false;
  let extraction: Promise<{ pid: number }> | undefined;
  let transferReady: (() => void) | undefined;
  let transferFailed: ((error: Error) => void) | undefined;
  let resolveReady: () => void;
  let rejectReady: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const readyTimer = setTimeout(() => {
    rejectReady(new Error("Worker terminal did not acknowledge attachment"));
    socket.destroy();
  }, 12_000);
  const request = (type: string, extra: Record<string, unknown> = {}) =>
    new Promise<WorkerFrame>((resolve, reject) => {
      if (closed) {
        reject(new Error("Worker terminal is closed"));
        return;
      }
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Worker terminal ${type} timed out`));
      }, 5000);
      pending.set(id, { resolve, reject, timer });
      sendFrame(socket, { type, id, ...extra });
    });
  readFrames(socket, (message) => {
    if (message.type === "welcome" && Number.isInteger(message.pid)) {
      pid = Number(message.pid);
      clearTimeout(readyTimer);
      resolveReady();
    } else if (message.type === "data" && typeof message.data === "string")
      for (const listener of dataListeners) listener(message.data);
    else if (message.type === "exit" && Number.isInteger(message.code)) {
      exitReceived = true;
      for (const listener of exitListeners) listener({ exitCode: Number(message.code) });
    } else if (message.type === "handoff" && message.pid === pid) {
      transferred = true;
      transferReady?.();
    } else if (message.type === "reply" && Number.isSafeInteger(message.id)) {
      const waiter = pending.get(Number(message.id));
      if (!waiter) return;
      clearTimeout(waiter.timer);
      pending.delete(Number(message.id));
      if (message.ok === true) waiter.resolve(message);
      else
        waiter.reject(
          new Error(
            typeof message.error === "string" ? message.error : "Worker terminal request failed",
          ),
        );
    } else throw new Error("Invalid worker terminal response");
  });
  socket.on("close", () => {
    closed = true;
    clearTimeout(readyTimer);
    const error = new Error("Worker terminal is closed");
    rejectReady(error);
    transferFailed?.(error);
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
    if (pid && !transferred && !exitReceived)
      for (const listener of exitListeners) listener({ exitCode: 1 });
  });
  sendFrame(socket, { type: "hello", role: "app", token });
  try {
    await ready;
  } catch (error) {
    socket.destroy();
    throw error;
  }

  const assertOwner = () => {
    if (transferred) throw new Error("Worker terminal transferred to PowerShell");
    if (closed) throw new Error("Worker terminal is closed");
  };
  return {
    pid,
    write: (data) => {
      assertOwner();
      sendFrame(socket, { type: "write", data });
    },
    resize: (cols, rows) => {
      assertOwner();
      sendFrame(socket, { type: "resize", cols, rows });
    },
    kill: () => {
      if (!transferred && !closed) sendFrame(socket, { type: "stop" });
      closeConnection(socket);
    },
    onData: (listener) => {
      dataListeners.add(listener);
      return { dispose: () => dataListeners.delete(listener) };
    },
    onExit: (listener) => {
      exitListeners.add(listener);
      return { dispose: () => exitListeners.delete(listener) };
    },
    extractToPowerShell: () => {
      if (extraction) return extraction;
      extraction = (async () => {
        assertOwner();
        const preparation = await request("prepare");
        if (typeof preparation.lease !== "string") throw new Error("Invalid handoff lease");
        let timer: NodeJS.Timeout | undefined;
        const committed = new Promise<void>((resolve, reject) => {
          transferReady = resolve;
          transferFailed = reject;
          timer = setTimeout(
            () => reject(new Error("PowerShell did not attach to the worker")),
            12_000,
          );
        });
        // Install the rejection handler before starting an asynchronous console launch.
        const outcome = committed.then(
          () => null,
          (error: unknown) => error,
        );
        try {
          const launch = { ...launchBase, lease: preparation.lease };
          if (options.launchClient) await options.launchClient(launch);
          else {
            const encoded = Buffer.from(externalClientCommand(launch), "utf16le").toString(
              "base64",
            );
            await runPowerShell(
              `Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoLogo -NoProfile -EncodedCommand ${encoded}' -WorkingDirectory ${quotePS(params.cwd)} | Out-Null`,
              process.env,
            );
          }
          const error = await outcome;
          if (error) throw error;
          return { pid };
        } catch (error) {
          const state = await request("abort", { lease: preparation.lease });
          if (state.state === "external") {
            transferred = true;
            return { pid };
          }
          throw error;
        } finally {
          clearTimeout(timer);
          transferReady = undefined;
          transferFailed = undefined;
        }
      })();
      const current = extraction;
      void current.catch(() => {
        if (extraction === current) extraction = undefined;
      });
      return current;
    },
  };
}
