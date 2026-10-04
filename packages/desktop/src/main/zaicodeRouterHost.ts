import { app } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, writeFile, rename } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { ZAICODE_ROUTER_DEFAULT_URL } from "@zcode/shared";
import { callZaicodeRouterAt, setZaicodeRouterTarget } from "./zaicodeRouterTransport.js";
import { ZaicodeRouterProcess, zaicodeRouterServerScript, isZaicodeRouterHealthy } from "./zaicodeRouterProcess.js";
import { ZaicodeRouterSupervisor, type RouterSupervisorState } from "./zaicodeRouterSupervisor.js";
import { ZaicodeRouterHealthProbe, localRouterListenerPid } from "./zaicodeRouterHealth.js";
import { ensureZaicodeFreePool, ensureZaicodeRouterKey } from "./zaicodeRouterSetup.js";

export { isZaicodeRouterHealthy } from "./zaicodeRouterProcess.js";

/**
 * ZAICODE's router host (SRC-035, T-46): which 9router ZAICODE uses and, for
 * its own isolated instance, running it.
 *
 * - shared:   the operator's own 9router (%APPDATA%\9router, port 20128);
 *             bounded silent recovery, then internal fallback (T-217).
 * - isolated: ZAICODE's private 9router (data in ZAICODE's folder, its own
 *             port), run by ZAICODE's own executable as Node
 *             (ELECTRON_RUN_AS_NODE): no Node, npm or install on the machine.
 *             Supervised (`ZaicodeRouterProcess`): restarted with backoff
 *             when it dies, stopped when ZAICODE quits.
 * - auto:     shared when this machine already has a 9router, else isolated.
 */

export type ZaicodeRouterMode = "auto" | "shared" | "isolated";

export interface ZaicodeRouterHostStatus {
  requestedMode: ZaicodeRouterMode;
  mode: "shared" | "isolated";
  url: string;
  dataDir: string;
  packageDir: string | null;
  /** ZAICODE runs this router itself (isolated). */
  managed: boolean;
  running: boolean;
  pid: number | null;
  restarts: number;
  lastError: string | null;
  startedAt: number | null;
  logFile: string | null;
  supervisor?: Readonly<RouterSupervisorState>;
  effectiveUrl?: string;
}

const CONFIG_FILE = "zaicode-router-host.json";
const ISOLATED_PORT = 20138;

interface HostConfig {
  mode: ZaicodeRouterMode;
  port: number;
}

let processHandle: ZaicodeRouterProcess | null = null;
let sharedRecoveryProcess: ZaicodeRouterProcess | null = null;
let supervisor: ZaicodeRouterSupervisor | null = null;
let supervisorStarting: Promise<void> | null = null;
let supervisorTimer: NodeJS.Timeout | null = null;
let preferredKey: { url: string; key: string } | null = null;
let fallbackKey: string | null = null;
let fallbackStarting: Promise<boolean> | null = null;
let supervisorGeneration = 0;

function internalFallbackTarget() {
  const config = readZaicodeRouterHostConfig();
  const preferredPort = Number(new URL(currentTarget(config).url).port || 80);
  // 用户把首选端口设成默认隔离端口时，回退必须仍是独立可用的端点。
  const port = config.port === preferredPort ? (preferredPort === ISOLATED_PORT ? ISOLATED_PORT + 1 : ISOLATED_PORT) : config.port;
  return { url: `http://127.0.0.1:${port}`, dataDir: isolatedDataDir(), port };
}

/** The same isolated adapter used by explicit isolated mode; no second process supervisor. */
async function ensureInternalFallback(): Promise<boolean> {
  if (fallbackStarting) return fallbackStarting;
  const generation = supervisorGeneration;
  const starting = (async () => {
    const packageDir = findZaicodeRouterPackage();
    if (!packageDir) return false;
    const route = internalFallbackTarget();
    if (generation !== supervisorGeneration) return false;
    if (!processHandle || processHandle.url !== route.url) {
      processHandle?.stop();
      processHandle = new ZaicodeRouterProcess({ execPath: process.execPath, packageDir, dataDir: route.dataDir, port: route.port, logFile: isolatedLogFile(), env: { ELECTRON_RUN_AS_NODE: "1" }, autoRestart: false, startWaitMs: 4000 });
    }
    if (!await processHandle.start()) return false;
    if (generation !== supervisorGeneration) return false;
    if (!fallbackKey) {
      const call = (request: Parameters<typeof callZaicodeRouterAt>[0]) => callZaicodeRouterAt(request, route);
      const pool = await ensureZaicodeFreePool(call);
      if (generation !== supervisorGeneration) return false;
      if (pool.steps.some((step) => step.status === "failed")) return false;
      const key = (await ensureZaicodeRouterKey(call, null)).key;
      if (generation !== supervisorGeneration) return false;
      fallbackKey = key;
    }
    return Boolean(fallbackKey);
  })().catch(() => false).finally(() => { if (fallbackStarting === starting) fallbackStarting = null; });
  fallbackStarting = starting;
  return starting;
}

async function ensureSupervisor(): Promise<void> {
  if (supervisor) return;
  if (supervisorStarting) return supervisorStarting;
  const starting = (async () => {
    const generation = supervisorGeneration;
    const target = currentTarget();
    if (target.mode !== "shared" || !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(target.url)) return;
    const path = join(app.getPath("userData"), "zaicode-router-supervisor.json");
    let saved: RouterSupervisorState | undefined;
    try { const raw = JSON.parse(await readFile(path, "utf8")); if (raw.preferredUrl === target.url) saved = raw.state; } catch { /* first start */ }
    if (generation !== supervisorGeneration) return;
    const health = new ZaicodeRouterHealthProbe(target.url, () => localRouterListenerPid(target.url, [process.pid, ...(processHandle?.pid ? [processHandle.pid] : [])]), () => sharedRecoveryProcess?.pid ?? null);
    const current = () => { if (generation !== supervisorGeneration) throw new Error("Router configuration changed"); };
    const manager = new ZaicodeRouterSupervisor({
      probe: () => { current(); return health.probe(); },
      recover: async () => {
        // 已存在但 API 失效的用户进程只重连；不能十次再生十个竞争进程。
        current();
        if (await health.probe() !== "process-unavailable") return;
        current();
        const packageDir = findZaicodeRouterPackage();
        if (!packageDir) return;
        const port = Number(new URL(target.url).port || 80);
        sharedRecoveryProcess ??= new ZaicodeRouterProcess({ execPath: process.execPath, packageDir, dataDir: target.dataDir, port, logFile: join(app.getPath("userData"), "logs", "zaicode-shared-router-recovery.log"), env: { ELECTRON_RUN_AS_NODE: "1" }, autoRestart: false, startWaitMs: 4000 });
        await sharedRecoveryProcess.start();
      },
      fallback: () => { current(); return ensureInternalFallback(); },
      persist: async (state) => {
        current();
        const temporary = `${path}.${process.pid}.${generation}.tmp`;
        await writeFile(temporary, JSON.stringify({ preferredUrl: target.url, state }), "utf8");
        current();
        await rename(temporary, path);
      },
      now: Date.now, wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    }, saved);
    supervisor = manager;
    supervisorTimer = setInterval(() => { void manager.tick().catch(() => undefined); }, 15_000);
    supervisorTimer.unref();
  })().finally(() => { if (supervisorStarting === starting) supervisorStarting = null; });
  supervisorStarting = starting;
  return starting;
}

/** Called only at inference admission; the proxy keeps this route for the whole stream. */
export async function acquireZaicodeRouterRoute(): Promise<{ url: string; key: string; fallback: boolean } | null> {
  const generation = supervisorGeneration;
  await ensureSupervisor();
  let selected: "preferred" | "fallback" | null;
  try { selected = supervisor ? await supervisor.boundary() : "preferred"; }
  catch (error) { if (generation !== supervisorGeneration) return acquireZaicodeRouterRoute(); throw error; }
  if (generation !== supervisorGeneration) return acquireZaicodeRouterRoute();
  if (!selected) return null;
  if (selected === "fallback") return fallbackKey ? { url: internalFallbackTarget().url, key: fallbackKey, fallback: true } : null;
  const target = currentTarget();
  if (!await isZaicodeRouterHealthy(target.url)) return null;
  if (preferredKey?.url !== target.url) preferredKey = { url: target.url, key: (await ensureZaicodeRouterKey((call) => callZaicodeRouterAt(call, target), null)).key };
  return { url: target.url, key: preferredKey.key, fallback: false };
}

function configPath(): string {
  return join(app.getPath("userData"), CONFIG_FILE);
}

export function readZaicodeRouterHostConfig(): HostConfig {
  try {
    const raw = JSON.parse(readFileSync(configPath(), "utf8")) as Partial<HostConfig>;
    const mode = raw.mode === "shared" || raw.mode === "isolated" ? raw.mode : "auto";
    const port = typeof raw.port === "number" && raw.port > 1024 && raw.port < 65535 ? Math.round(raw.port) : ISOLATED_PORT;
    return { mode, port };
  } catch {
    return { mode: "auto", port: ISOLATED_PORT };
  }
}

function sharedDataDir(): string {
  const appData = process.env.APPDATA || join(process.env.USERPROFILE || "", "AppData", "Roaming");
  return join(appData, "9router");
}

function isolatedDataDir(): string {
  return join(app.getPath("userData"), "router");
}

function isolatedLogFile(): string {
  return join(app.getPath("userData"), "logs", "zaicode-router.log");
}

/** The operator already has a 9router here (its database exists). */
export function hasSharedZaicodeRouter(): boolean {
  return existsSync(join(sharedDataDir(), "db", "data.sqlite"));
}

function resolvedMode(config: HostConfig): "shared" | "isolated" {
  if (config.mode === "auto") return hasSharedZaicodeRouter() ? "shared" : "isolated";
  return config.mode;
}

/**
 * The patched 9router package: shipped with ZAICODE, else the one installed
 * on this machine (npm global), else ZAICODE_ROUTER_PACKAGE.
 */
export function findZaicodeRouterPackage(): string | null {
  const candidates = [
    process.env.ZAICODE_ROUTER_PACKAGE,
    process.resourcesPath ? join(process.resourcesPath, "router", "9router") : undefined,
    join(app.getAppPath(), "..", "router", "9router"),
    process.env.APPDATA ? join(process.env.APPDATA, "npm", "node_modules", "9router") : undefined,
    ...(process.env.PATH ?? "")
      .split(delimiter)
      .filter((dir) => dir && existsSync(join(dir, process.platform === "win32" ? "9router.cmd" : "9router")))
      .map((dir) => join(dir, "node_modules", "9router")),
  ];
  return candidates.find((candidate) => candidate && zaicodeRouterServerScript(candidate)) ?? null;
}

function currentTarget(config: HostConfig = readZaicodeRouterHostConfig()) {
  const mode = resolvedMode(config);
  return mode === "shared"
    ? { mode, url: process.env.ZAICODE_ROUTER_URL?.replace(/\/+$/, "") || ZAICODE_ROUTER_DEFAULT_URL, dataDir: sharedDataDir() }
    : { mode, url: `http://127.0.0.1:${config.port}`, dataDir: isolatedDataDir() };
}

export function getZaicodeRouterHostStatus(): ZaicodeRouterHostStatus {
  const config = readZaicodeRouterHostConfig();
  const target = currentTarget(config);
  const managed = target.mode === "isolated";
  return {
    requestedMode: config.mode,
    mode: target.mode,
    url: target.url,
    dataDir: target.dataDir,
    packageDir: findZaicodeRouterPackage(),
    managed,
    running: managed ? Boolean(processHandle?.running) : Boolean(supervisor && !supervisor.state.failure && supervisor.state.lastProbeAt > 0),
    pid: managed ? (processHandle?.pid ?? null) : null,
    restarts: managed ? (processHandle?.restarts ?? 0) : 0,
    lastError: managed ? (processHandle?.lastError ?? null) : null,
    startedAt: managed ? (processHandle?.startedAt ?? null) : null,
    logFile: managed ? isolatedLogFile() : null,
    ...(supervisor ? { supervisor: supervisor.state, effectiveUrl: supervisor.state.route === "fallback" ? internalFallbackTarget().url : target.url } : {}),
  };
}

/**
 * Makes the chosen router reachable: points the transport at it and, for the
 * isolated one, starts it (or adopts one already answering on its port).
 * Resolves once it answers or the wait is over.
 */
export async function startZaicodeRouterHost(): Promise<ZaicodeRouterHostStatus> {
  const config = readZaicodeRouterHostConfig();
  const target = currentTarget(config);
  setZaicodeRouterTarget({ url: target.url, dataDir: target.dataDir });
  if (target.mode === "shared") {
    await ensureSupervisor();
    await supervisor?.tick();
  }
  if (target.mode === "isolated") {
    const packageDir = findZaicodeRouterPackage();
    if (!packageDir) {
      processHandle = null;
      return { ...getZaicodeRouterHostStatus(), lastError: "The 9router package was not found (it ships with ZAICODE; reinstall, or set ZAICODE_ROUTER_PACKAGE)." };
    }
    if (!processHandle || processHandle.url !== target.url) {
      processHandle?.stop();
      processHandle = new ZaicodeRouterProcess({
        execPath: process.execPath,
        packageDir,
        dataDir: target.dataDir,
        port: config.port,
        logFile: isolatedLogFile(),
        // ZAICODE's own executable runs the router as plain Node: nothing to install.
        env: { ELECTRON_RUN_AS_NODE: "1" },
      });
    }
    await processHandle.start();
  }
  return getZaicodeRouterHostStatus();
}

export async function restartZaicodeRouterHost(): Promise<ZaicodeRouterHostStatus> {
  if (processHandle && resolvedMode(readZaicodeRouterHostConfig()) === "isolated") {
    await processHandle.restart();
    return getZaicodeRouterHostStatus();
  }
  return startZaicodeRouterHost();
}

/** Stops ZAICODE's own router (never the operator's shared one). */
export function stopZaicodeRouterHost(): void {
  supervisorGeneration++;
  supervisor = null;
  supervisorStarting = null;
  if (supervisorTimer) clearInterval(supervisorTimer);
  supervisorTimer = null;
  processHandle?.stop();
  fallbackStarting = null;
  fallbackKey = null;
}

export async function setZaicodeRouterMode(mode: ZaicodeRouterMode): Promise<ZaicodeRouterHostStatus> {
  const config = readZaicodeRouterHostConfig();
  writeFileSync(configPath(), JSON.stringify({ ...config, mode }, null, 2));
  supervisorGeneration++;
  supervisorStarting = null;
  if (supervisorTimer) clearInterval(supervisorTimer);
  supervisorTimer = null;
  supervisor = null;
  preferredKey = null;
  if (resolvedMode({ ...config, mode }) === "shared") stopZaicodeRouterHost();
  return startZaicodeRouterHost();
}

