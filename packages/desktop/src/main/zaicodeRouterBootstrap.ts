import { app } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ZAICODE_FREE_POOL } from "@zcode/shared";
import {
  findZaicodeRouterPackage,
  getZaicodeRouterHostStatus,
  isZaicodeRouterHealthy,
  restartZaicodeRouterHost,
  startZaicodeRouterHost,
  type ZaicodeRouterHostStatus,
} from "./zaicodeRouterHost.js";
import { startZaicodeRouter } from "./zaicodeRouter.js";
import {
  addZaicodeFreeKeyProvider,
  ensureZaicodeFreePool,
  ensureZaicodeRouterKey,
  probeZaicodeRouterModel,
  readZaicodeRouterState,
  scanZaicodeFreeModels,
  type ZaicodeFreeScanMemory,
  type ZaicodeSetupStep,
} from "./zaicodeRouterSetup.js";
import { callZaicodeRouterInternal } from "./zaicodeRouterTransport.js";

/**
 * One call from "nothing configured" to "SAIFREN answers" (SRC-035, T-46),
 * and the Autotroubleshoot that repairs the same chain step by step. The
 * renderer only adds its half (the SAIRoute provider in the app's model list).
 */

export interface ZaicodeRouterBootstrapResult {
  ok: boolean;
  host: ZaicodeRouterHostStatus;
  /** ZAICODE's key for 9router's OpenAI endpoint (only when asked for). */
  apiKey: string | null;
  steps: ZaicodeSetupStep[];
  firstToken: { ok: boolean; detail: string; servedBy: string | null } | null;
}

const KEY_FILE = "zaicode-router-key.json";
const SCAN_FILE = "zaicode-free-scan.json";
const FETCH_TIMEOUT_MS = 20_000;
const SHARED_START_WAIT_MS = 20_000;

function readJson<T>(name: string, fallback: T): T {
  try {
    const path = join(app.getPath("userData"), name);
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(name: string, value: unknown): void {
  writeFileSync(join(app.getPath("userData"), name), JSON.stringify(value, null, 2));
}

async function ensureKey(url: string): Promise<{ key: string; created: boolean }> {
  const stored = readJson<Record<string, string>>(KEY_FILE, {});
  const result = await ensureZaicodeRouterKey(callZaicodeRouterInternal, stored[url] ?? null);
  if (result.created) writeJson(KEY_FILE, { ...stored, [url]: result.key });
  return result;
}

function scanMemory(): ZaicodeFreeScanMemory {
  const raw = readJson<Partial<ZaicodeFreeScanMemory>>(SCAN_FILE, {});
  return { added: Array.isArray(raw.added) ? raw.added.filter((id) => typeof id === "string") : [], lastScanAt: typeof raw.lastScanAt === "number" ? raw.lastScanAt : null };
}

async function waitHealthy(url: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await isZaicodeRouterHealthy(url)) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

/**
 * Router up, SAIFREN filled, (optionally) ZAICODE's key, first token. The
 * operator's own 9router (shared) is only topped up, never rebuilt.
 */
let inflight: Promise<ZaicodeRouterBootstrapResult> | null = null;
let inflightScan: Promise<{ added: { id: string; provider: string }[]; errors: string[]; lastScanAt: number }> | null = null;

/**
 * One setup at a time for the whole app: several windows starting together
 * share the run in progress (two parallel runs would add every free provider
 * twice). A caller that needs the key while a key-less run is going waits
 * for it and then runs once more.
 */
export async function bootstrapZaicodeRouter(options: { needKey: boolean }): Promise<ZaicodeRouterBootstrapResult> {
  while (inflight) {
    const running = await inflight.catch(() => null);
    if (running && (!options.needKey || running.apiKey)) return running;
  }
  inflight = runBootstrap(options).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function runBootstrap(options: { needKey: boolean }): Promise<ZaicodeRouterBootstrapResult> {
  const steps: ZaicodeSetupStep[] = [];
  const host = await startZaicodeRouterHost();
  if (host.mode === "shared" && !(await isZaicodeRouterHealthy(host.url))) {
    // The operator's own 9router is down: start it the way its tray does ("Start 9router"), then wait for it.
    startZaicodeRouter();
    if (await waitHealthy(host.url, SHARED_START_WAIT_MS)) {
      steps.push({ id: "router:start", label: "Router", status: "fixed", detail: "your 9router was not running: started it" });
    }
  }
  if (!(await isZaicodeRouterHealthy(host.url))) {
    steps.push({ id: "router", label: "Router", status: "failed", detail: host.lastError ?? `9router does not answer at ${host.url}` });
    return { ok: false, host, apiKey: null, steps, firstToken: null };
  }
  steps.push({ id: "router", label: "Router", status: "ok", detail: `${host.mode === "isolated" ? "ZAICODE's own" : "your"} 9router answers at ${host.url}` });
  try {
    const memory = scanMemory();
    const pool = await ensureZaicodeFreePool(callZaicodeRouterInternal, memory.added);
    steps.push(...pool.steps);
    if (pool.added.length > 0) writeJson(SCAN_FILE, { ...memory, added: [...new Set([...memory.added, ...pool.added])] });
  } catch (error) {
    steps.push({ id: "pool:free", label: ZAICODE_FREE_POOL, status: "failed", detail: error instanceof Error ? error.message : String(error) });
  }
  let apiKey: string | null = null;
  let firstToken: ZaicodeRouterBootstrapResult["firstToken"] = null;
  if (options.needKey) {
    try {
      apiKey = (await ensureKey(host.url)).key;
      const probe = await probeZaicodeRouterModel(host.url, apiKey, ZAICODE_FREE_POOL);
      firstToken = { ok: probe.ok, detail: probe.detail, servedBy: probe.servedBy };
      steps.push({ id: "token", label: "First token", status: probe.ok ? "ok" : "failed", detail: probe.ok ? `${probe.detail}${probe.servedBy ? ` by ${probe.servedBy}` : ""}` : probe.detail });
    } catch (error) {
      steps.push({ id: "key", label: "ZAICODE key", status: "failed", detail: error instanceof Error ? error.message : String(error) });
    }
  }
  return { ok: steps.every((step) => step.status !== "failed"), host: getZaicodeRouterHostStatus(), apiKey, steps, firstToken };
}

/**
 * Autotroubleshoot: every link of the chain checked in order and repaired
 * where a repair is safe (start / restart the router, recreate the pools,
 * a new ZAICODE key); what needs the operator is said plainly.
 */
export async function troubleshootZaicodeRouter(): Promise<ZaicodeRouterBootstrapResult> {
  const steps: ZaicodeSetupStep[] = [];
  let host = getZaicodeRouterHostStatus();
  if (host.mode === "isolated") {
    steps.push(
      host.packageDir
        ? { id: "package", label: "9router package", status: "ok", detail: host.packageDir }
        : { id: "package", label: "9router package", status: "failed", detail: "not found: reinstall ZAICODE (it ships the router)" },
    );
  }
  if (!(await isZaicodeRouterHealthy(host.url))) {
    if (host.mode === "isolated") {
      host = await restartZaicodeRouterHost();
    } else {
      startZaicodeRouter();
      await waitHealthy(host.url, SHARED_START_WAIT_MS);
    }
    const up = await isZaicodeRouterHealthy(host.url);
    steps.push({ id: "router", label: "Router", status: up ? "fixed" : "failed", detail: up ? `started, answers at ${host.url}` : host.lastError ?? `does not answer at ${host.url}` });
    if (!up) return { ok: false, host, apiKey: null, steps, firstToken: null };
  } else {
    steps.push({ id: "router", label: "Router", status: "ok", detail: `answers at ${host.url}` });
  }
  try {
    await readZaicodeRouterState(callZaicodeRouterInternal);
    steps.push({ id: "credential", label: "ZAICODE ↔ 9router", status: "ok", detail: "ZAICODE is allowed to manage it" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (host.mode === "isolated") {
      host = await restartZaicodeRouterHost();
      steps.push({ id: "credential", label: "ZAICODE ↔ 9router", status: "fixed", detail: "restarted with a fresh credential" });
    } else {
      steps.push({ id: "credential", label: "ZAICODE ↔ 9router", status: "failed", detail: `${message}: quit 9router from its tray icon and start it again once` });
      return { ok: false, host, apiKey: null, steps, firstToken: null };
    }
  }
  const result = await bootstrapZaicodeRouter({ needKey: true });
  const seen = new Set(steps.map((step) => step.id));
  steps.push(...result.steps.filter((step) => !seen.has(step.id)));
  if (result.firstToken && !result.firstToken.ok && result.apiKey) {
    // Which free provider is the broken link: one probe each.
    const state = await readZaicodeRouterState(callZaicodeRouterInternal);
    const pool = state.combos.find((combo) => combo.name === ZAICODE_FREE_POOL)?.models ?? [];
    for (const model of pool.slice(0, 6)) {
      const probe = await probeZaicodeRouterModel(host.url, result.apiKey, model);
      steps.push({ id: `probe:${model}`, label: model, status: probe.ok ? "ok" : "failed", detail: probe.detail });
    }
  }
  return { ...result, steps, ok: steps.every((step) => step.status !== "failed" || step.id.startsWith("probe:")) && Boolean(result.firstToken?.ok) };
}

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status} from ${new URL(url).host}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export function scanZaicodeFreeModelsNow(): Promise<{ added: { id: string; provider: string }[]; errors: string[]; lastScanAt: number }> {
  // One scan at a time (every window schedules its own check); the second caller gets the same answer.
  inflightScan ??= (async () => {
    const now = Date.now();
    const result = await scanZaicodeFreeModels(callZaicodeRouterInternal, fetchJson, scanMemory(), now);
    writeJson(SCAN_FILE, result.memory);
    return { added: result.added, errors: result.errors, lastScanAt: now };
  })().finally(() => {
    inflightScan = null;
  });
  return inflightScan;
}

export function readZaicodeFreeScanInfo(): { lastScanAt: number | null } {
  return { lastScanAt: scanMemory().lastScanAt };
}

export function addZaicodeFreeKey(providerId: string, apiKey: string) {
  return addZaicodeFreeKeyProvider(callZaicodeRouterInternal, providerId, apiKey);
}

export { findZaicodeRouterPackage };
