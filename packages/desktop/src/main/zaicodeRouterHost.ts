import { app } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { ZAICODE_ROUTER_DEFAULT_URL } from "@zcode/shared";
import { setZaicodeRouterTarget } from "./zaicodeRouterTransport.js";
import { ZaicodeRouterProcess, zaicodeRouterServerScript } from "./zaicodeRouterProcess.js";

export { isZaicodeRouterHealthy } from "./zaicodeRouterProcess.js";

/**
 * ZAICODE's router host (SRC-035, T-46): which 9router ZAICODE uses and, for
 * its own isolated instance, running it.
 *
 * - shared:   the operator's own 9router (%APPDATA%\9router, port 20128);
 *             ZAICODE never starts or stops it on its own.
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
}

const CONFIG_FILE = "zaicode-router-host.json";
const ISOLATED_PORT = 20138;

interface HostConfig {
  mode: ZaicodeRouterMode;
  port: number;
}

let processHandle: ZaicodeRouterProcess | null = null;

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
    running: managed ? Boolean(processHandle?.running) : false,
    pid: managed ? (processHandle?.pid ?? null) : null,
    restarts: managed ? (processHandle?.restarts ?? 0) : 0,
    lastError: managed ? (processHandle?.lastError ?? null) : null,
    startedAt: managed ? (processHandle?.startedAt ?? null) : null,
    logFile: managed ? isolatedLogFile() : null,
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
  processHandle?.stop();
}

export async function setZaicodeRouterMode(mode: ZaicodeRouterMode): Promise<ZaicodeRouterHostStatus> {
  const config = readZaicodeRouterHostConfig();
  writeFileSync(configPath(), JSON.stringify({ ...config, mode }, null, 2));
  if (resolvedMode({ ...config, mode }) === "shared") stopZaicodeRouterHost();
  return startZaicodeRouterHost();
}

