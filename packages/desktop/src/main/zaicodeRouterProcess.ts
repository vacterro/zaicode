import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

/**
 * One supervised 9router server process (T-46), Electron-free so crash and
 * restart behaviour is tested against the real server. The router host in
 * main decides WHICH router; this runs ZAICODE's isolated one: its own data
 * folder and CLI credential, a restart with backoff when it dies, a clean
 * stop that is never mistaken for a crash.
 */

export interface ZaicodeRouterProcessOptions {
  /** Executable that runs Node code: ZAICODE itself with ELECTRON_RUN_AS_NODE, or node. */
  execPath: string;
  packageDir: string;
  dataDir: string;
  port: number;
  logFile: string;
  /** Extra environment (ELECTRON_RUN_AS_NODE=1 for ZAICODE's own executable). */
  env?: NodeJS.ProcessEnv;
  /** Router host owns recovery when false; never run two recovery owners. */
  autoRestart?: boolean;
  startWaitMs?: number;
}

const HEALTH_TIMEOUT_MS = 3000;
const START_WAIT_MS = 30_000;
const MAX_BACKOFF_MS = 60_000;
const LOG_MAX_BYTES = 5 * 1024 * 1024;

export function zaicodeRouterServerScript(packageDir: string): string | null {
  for (const name of ["custom-server.js", "server.js"]) {
    const path = join(packageDir, "app", name);
    if (existsSync(path)) return path;
  }
  return null;
}

/** 9router's CLI credential files (machine id + secret); created once per data folder. */
export function ensureZaicodeRouterCredential(dataDir: string): void {
  mkdirSync(join(dataDir, "auth"), { recursive: true });
  const machineId = join(dataDir, "machine-id");
  if (!existsSync(machineId)) writeFileSync(machineId, randomBytes(16).toString("hex"));
  const secret = join(dataDir, "auth", "cli-secret");
  if (!existsSync(secret)) writeFileSync(secret, randomBytes(32).toString("hex"), { mode: 0o600 });
}

export async function isZaicodeRouterHealthy(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    return (await fetch(`${url}/api/health`, { signal: controller.signal })).ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export class ZaicodeRouterProcess {
  readonly url: string;
  #child: ChildProcess | null = null;
  #stopping = false;
  #timer: NodeJS.Timeout | null = null;
  #starting: Promise<boolean> | null = null;
  #generation = 0;
  restarts = 0;
  lastError: string | null = null;
  startedAt: number | null = null;

  constructor(private readonly options: ZaicodeRouterProcessOptions) {
    this.url = `http://127.0.0.1:${options.port}`;
  }

  get running(): boolean {
    return Boolean(this.#child && this.#child.exitCode === null);
  }

  get pid(): number | null {
    return this.#child?.pid ?? null;
  }

  /** Starts it (or adopts one already answering on its private port) and waits until it answers. */
  async start(): Promise<boolean> {
    if (this.#starting) return this.#starting;
    const generation = ++this.#generation;
    this.#stopping = false;
    const starting = this.#start(generation).finally(() => { if (this.#starting === starting) this.#starting = null; });
    this.#starting = starting;
    return starting;
  }

  async #start(generation: number): Promise<boolean> {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    ensureZaicodeRouterCredential(this.options.dataDir);
    const healthy = await isZaicodeRouterHealthy(this.url);
    // stop 可能发生在健康请求挂起期间；迟到的 start 不得在退出/换模式后再生进程。
    if (this.#stopping || generation !== this.#generation) return false;
    if (healthy) return true;
    // Already starting (another caller got here first): wait for the same process, never a second one.
    if (!this.running) this.#spawn();
    const deadline = Date.now() + (this.options.startWaitMs ?? START_WAIT_MS);
    while (Date.now() < deadline && this.running && generation === this.#generation && !this.#stopping) {
      const ready = await isZaicodeRouterHealthy(this.url);
      if (generation !== this.#generation || this.#stopping) return false;
      if (ready) return true;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (generation !== this.#generation || this.#stopping) return false;
    return isZaicodeRouterHealthy(this.url);
  }

  /** Clean stop: no restart follows. */
  stop(): void {
    this.#generation++;
    this.#starting = null;
    this.#stopping = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    const child = this.#child;
    this.#child = null;
    if (child && child.exitCode === null) child.kill();
  }

  async restart(): Promise<boolean> {
    this.stop();
    const generation = this.#generation;
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (generation !== this.#generation) return false;
    this.restarts = 0;
    return this.start();
  }

  #spawn(): void {
    const script = zaicodeRouterServerScript(this.options.packageDir);
    if (!script) {
      this.lastError = `No 9router server in ${this.options.packageDir}`;
      return;
    }
    mkdirSync(dirname(this.options.logFile), { recursive: true });
    try {
      if (statSync(this.options.logFile).size > LOG_MAX_BYTES) writeFileSync(this.options.logFile, "");
    } catch {
      // no log yet
    }
    const appDir = dirname(script);
    const log = openSync(this.options.logFile, "a");
    try {
      this.#child = spawn(this.options.execPath, ["--dns-result-order=ipv4first", script], {
        cwd: appDir,
        env: {
          ...process.env,
          ...this.options.env,
          DATA_DIR: this.options.dataDir,
          PORT: String(this.options.port),
          HOSTNAME: "127.0.0.1",
          NODE_PATH: [join(this.options.dataDir, "runtime", "node_modules"), join(appDir, "node_modules")].join(delimiter),
        },
        stdio: ["ignore", log, log],
        windowsHide: true,
      });
    } finally {
      closeSync(log);
    }
    this.startedAt = Date.now();
    this.lastError = null;
    const child = this.#child;
    child.on("error", (error) => {
      if (this.#child !== child) return;
      this.lastError = error.message;
    });
    child.on("exit", (code) => {
      // 被替换进程的迟到 exit 不能安排新进程再重启，否则出现重叠 owner。
      if (this.#child !== child) return;
      this.#child = null;
      if (this.#stopping) return;
      // It died on its own: back it comes, a little later each time (1 s, 2 s, 4 s … 60 s).
      this.lastError = `9router stopped (exit ${code ?? "signal"})`;
      this.restarts += 1;
      // 主机监督器持有预算时不再自启；独立使用此适配器也最多恢复十次。
      if (this.options.autoRestart === false || this.restarts > 10) return;
      const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** Math.min(this.restarts, 7));
      this.#timer = setTimeout(() => void this.start(), delay);
    });
  }
}
