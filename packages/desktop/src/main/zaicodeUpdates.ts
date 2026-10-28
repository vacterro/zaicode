import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ZAICODE_UPDATE_COMPONENTS,
  mergeZaicodeUpdateComponents,
  normalizeZaicodeUpdateAuto,
  parseZaicodeUpdateReport,
  zaicodeUpdatesDue,
  type ZaicodeUpdateComponent,
  type ZaicodeUpdateComponentId,
  type ZaicodeUpdatesState,
} from "@zcode/shared";

/**
 * ZAICODE updates, the part without electron (T-134): where the install is,
 * how Update-ZAICODE.ps1 runs, and the controller that keeps the state, the
 * per-part "update by itself" switches and the schedule's decisions. The
 * electron half (IPC, timers, windows) is zaicodeUpdatesHost.ts. Tested with a
 * stand-in runner, so no test ever touches git or the network.
 */

export const ZAICODE_UPDATE_SCRIPT = join("install", "Update-ZAICODE.ps1");
const STATE_FILE = join("install", "install-state.json");
const CHECK_TIMEOUT_MS = 3 * 60 * 1000;
/** A new app build takes minutes; dependencies may be reinstalled first. */
const UPDATE_TIMEOUT_MS = 60 * 60 * 1000;

/** The folder holding install\Update-ZAICODE.ps1: the launcher says so, else it is found above the app. */
export function resolveZaicodeInstallRoot(input: { env: NodeJS.ProcessEnv; execPath: string; appPath?: string; exists?: (path: string) => boolean }): string | null {
  const exists = input.exists ?? existsSync;
  const has = (dir: string) => exists(join(dir, ZAICODE_UPDATE_SCRIPT));
  const fromEnv = input.env.ZAICODE_INSTALL_ROOT?.trim();
  if (fromEnv && has(fromEnv)) return fromEnv;
  for (const start of [input.execPath, input.appPath].filter((value): value is string => Boolean(value))) {
    let dir = dirname(start);
    for (let depth = 0; depth < 10; depth++) {
      if (has(dir)) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

export function isZaicodeManagedInstall(root: string | null, exists: (path: string) => boolean = existsSync): boolean {
  return Boolean(root && exists(join(root, STATE_FILE)));
}

export interface ZaicodeScriptResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type ZaicodeScriptRunner = (script: string, args: readonly string[], options: { cwd: string; timeoutMs: number }) => Promise<ZaicodeScriptResult>;

/** Windows PowerShell 5.1 (the one every Windows has) runs the script; a run past its time is stopped with its whole tree. */
export const zaicodePowershellRunner: ZaicodeScriptRunner = (script, args, options) =>
  new Promise((resolve) => {
    const system = process.env.SystemRoot ?? "C:\\Windows";
    const powershell = join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const child = spawn(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args], {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    const timer = setTimeout(() => {
      if (child.pid) spawn(join(system, "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    }, options.timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });

interface StoredUpdates {
  auto?: unknown;
  lastCheckAt?: unknown;
  lastUpdateAt?: unknown;
  components?: unknown;
}

export interface ZaicodeUpdatesControllerOptions {
  root: string | null;
  managed: boolean;
  runner: ZaicodeScriptRunner;
  /** userData\zaicode-updates.json */
  storePath: string;
  now?: () => number;
  onChange?: (state: ZaicodeUpdatesState) => void;
  log?: (message: string) => void;
}

export class ZaicodeUpdatesController {
  private current: ZaicodeUpdatesState;
  private readonly options: ZaicodeUpdatesControllerOptions;
  private running: Promise<ZaicodeUpdatesState> | null = null;

  constructor(options: ZaicodeUpdatesControllerOptions) {
    this.options = options;
    const stored = this.read();
    const components = Array.isArray(stored.components)
      ? (parseZaicodeUpdateReport(JSON.stringify({ components: stored.components }))?.components ?? [])
      : [];
    this.current = {
      installRoot: options.root,
      managed: options.managed,
      busy: null,
      busyComponents: [],
      lastCheckAt: typeof stored.lastCheckAt === "number" ? stored.lastCheckAt : null,
      lastUpdateAt: typeof stored.lastUpdateAt === "number" ? stored.lastUpdateAt : null,
      components,
      auto: normalizeZaicodeUpdateAuto(stored.auto, options.managed),
      error: options.root ? null : "This ZAICODE has no install folder with install\\Update-ZAICODE.ps1 (a build without the workspace).",
      log: null,
    };
  }

  state(): ZaicodeUpdatesState {
    return { ...this.current, components: [...this.current.components], busyComponents: [...this.current.busyComponents], auto: { ...this.current.auto } };
  }

  setAuto(component: ZaicodeUpdateComponentId, enabled: boolean): ZaicodeUpdatesState {
    this.current = { ...this.current, auto: { ...this.current.auto, [component]: enabled } };
    this.save();
    this.emit();
    return this.state();
  }

  /** Asks GitHub what is new for every part; changes nothing. */
  check(): Promise<ZaicodeUpdatesState> {
    return this.exclusive("check", [...ZAICODE_UPDATE_COMPONENTS], ["-Check", "-Json"], CHECK_TIMEOUT_MS);
  }

  /** Updates the named parts (empty = every part with something new). */
  apply(components: readonly ZaicodeUpdateComponentId[]): Promise<ZaicodeUpdatesState> {
    const wanted = components.length > 0 ? [...new Set(components)] : this.current.components.filter((entry) => entry.status === "available").map((entry) => entry.id);
    if (wanted.length === 0) return this.check();
    return this.exclusive("update", wanted, ["-Json", "-Component", wanted.join(",")], UPDATE_TIMEOUT_MS);
  }

  /** The schedule's turn: look, then update by itself what is set to. Returns the parts it updated. */
  async tick(): Promise<{ checked: boolean; updated: ZaicodeUpdateComponentId[] }> {
    if (!this.options.root || this.current.busy) return { checked: false, updated: [] };
    await this.check();
    const due = zaicodeUpdatesDue(this.current.auto, this.current.components);
    if (due.length === 0) return { checked: true, updated: [] };
    this.options.log?.(`updating by itself: ${due.join(", ")}`);
    await this.apply(due);
    return { checked: true, updated: due.filter((id) => this.current.components.find((entry) => entry.id === id)?.status === "updated") };
  }

  private exclusive(kind: "check" | "update", components: ZaicodeUpdateComponentId[], args: string[], timeoutMs: number): Promise<ZaicodeUpdatesState> {
    // One run at a time: a second request while one runs gets that run's answer.
    if (this.running) return this.running;
    const root = this.options.root;
    if (!root) return Promise.resolve(this.state());
    this.current = { ...this.current, busy: kind, busyComponents: components, error: null };
    this.emit();
    this.running = this.options
      .runner(join(root, ZAICODE_UPDATE_SCRIPT), args, { cwd: root, timeoutMs })
      .then((result) => this.finish(kind, result))
      .catch((error: unknown) => this.finish(kind, { code: null, stdout: "", stderr: error instanceof Error ? error.message : String(error) }))
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private finish(kind: "check" | "update", result: ZaicodeScriptResult): ZaicodeUpdatesState {
    const report = parseZaicodeUpdateReport(result.stdout);
    const now = (this.options.now ?? Date.now)();
    let components: ZaicodeUpdateComponent[] = this.current.components;
    let error: string | null = null;
    if (report) {
      components = mergeZaicodeUpdateComponents(components, report.components);
    } else {
      const tail = `${result.stderr}\n${result.stdout}`.trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 400);
      error = `Update-ZAICODE.ps1 gave no report (exit ${result.code ?? "none"})${tail ? `: ${tail}` : ""}`;
      this.options.log?.(error);
    }
    this.current = {
      ...this.current,
      busy: null,
      busyComponents: [],
      components,
      error,
      log: report?.log ?? this.current.log,
      lastCheckAt: now,
      lastUpdateAt: kind === "update" ? now : this.current.lastUpdateAt,
    };
    this.save();
    this.emit();
    return this.state();
  }

  private read(): StoredUpdates {
    try {
      return existsSync(this.options.storePath) ? (JSON.parse(readFileSync(this.options.storePath, "utf8")) as StoredUpdates) : {};
    } catch {
      return {};
    }
  }

  private save(): void {
    try {
      const { auto, lastCheckAt, lastUpdateAt, components } = this.current;
      writeFileSync(this.options.storePath, JSON.stringify({ auto, lastCheckAt, lastUpdateAt, components }, null, 2));
    } catch (error) {
      this.options.log?.(`updates state not saved: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private emit(): void {
    this.options.onChange?.(this.state());
  }
}
