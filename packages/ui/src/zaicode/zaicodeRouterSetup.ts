import { create } from "zustand";

/**
 * Renderer half of the zero-setup router (SRC-035, T-46): what the main
 * process reports about the router ZAICODE uses (shared / isolated), the last
 * bootstrap or Autotroubleshoot run, the free-model scan and free keys.
 */

export type ZaicodeRouterMode = "auto" | "shared" | "isolated";

export interface ZaicodeRouterHostInfo {
  requestedMode: ZaicodeRouterMode;
  mode: "shared" | "isolated";
  url: string;
  dataDir: string;
  packageDir: string | null;
  managed: boolean;
  running: boolean;
  pid: number | null;
  restarts: number;
  lastError: string | null;
  startedAt: number | null;
  logFile: string | null;
}

export interface ZaicodeRouterSetupStep {
  id: string;
  label: string;
  status: "ok" | "fixed" | "failed" | "skipped";
  detail: string;
}

export interface ZaicodeRouterBootstrapResult {
  ok: boolean;
  host: ZaicodeRouterHostInfo;
  apiKey: string | null;
  steps: ZaicodeRouterSetupStep[];
  firstToken: { ok: boolean; detail: string; servedBy: string | null } | null;
}

export interface ZaicodeFreeScanResult {
  added: { id: string; provider: string }[];
  errors: string[];
  lastScanAt: number;
}

interface ZaicodeRouterSetupBridge {
  getZaicodeRouterHost?(): Promise<ZaicodeRouterHostInfo>;
  setZaicodeRouterMode?(mode: ZaicodeRouterMode): Promise<ZaicodeRouterHostInfo>;
  bootstrapZaicodeRouter?(options: { needKey: boolean }): Promise<ZaicodeRouterBootstrapResult>;
  troubleshootZaicodeRouter?(): Promise<ZaicodeRouterBootstrapResult>;
  scanZaicodeFreeModels?(): Promise<ZaicodeFreeScanResult>;
  getZaicodeFreeScanInfo?(): Promise<{ lastScanAt: number | null }>;
  addZaicodeFreeKey?(input: { providerId: string; apiKey: string }): Promise<{ ok: boolean; message: string; added: number }>;
}

export function getZaicodeRouterSetupBridge(): ZaicodeRouterSetupBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = (window as unknown as { zcode?: ZaicodeRouterSetupBridge }).zcode;
  return bridge?.bootstrapZaicodeRouter ? bridge : null;
}

interface ZaicodeRouterSetupState {
  host: ZaicodeRouterHostInfo | null;
  /** Last bootstrap / Autotroubleshoot result, newest first in `steps`. */
  last: ZaicodeRouterBootstrapResult | null;
  lastKind: "setup" | "troubleshoot" | null;
  busy: "setup" | "troubleshoot" | "scan" | "mode" | "key" | null;
  scan: ZaicodeFreeScanResult | null;
  lastScanAt: number | null;
  /** App-side step (the SAIRoute provider in the model list), set by the auto setup. */
  appStep: ZaicodeRouterSetupStep | null;
}

export const useZaicodeRouterSetup = create<ZaicodeRouterSetupState>(() => ({
  host: null,
  last: null,
  lastKind: null,
  busy: null,
  scan: null,
  lastScanAt: null,
  appStep: null,
}));

export async function refreshZaicodeRouterHost(): Promise<ZaicodeRouterHostInfo | null> {
  const bridge = getZaicodeRouterSetupBridge();
  if (!bridge?.getZaicodeRouterHost) return null;
  const host = await bridge.getZaicodeRouterHost();
  const scan = await bridge.getZaicodeFreeScanInfo?.().catch(() => null);
  useZaicodeRouterSetup.setState({ host, ...(scan ? { lastScanAt: scan.lastScanAt } : {}) });
  return host;
}

export async function setZaicodeRouterModeFromUi(mode: ZaicodeRouterMode): Promise<void> {
  const bridge = getZaicodeRouterSetupBridge();
  if (!bridge?.setZaicodeRouterMode) return;
  useZaicodeRouterSetup.setState({ busy: "mode" });
  try {
    useZaicodeRouterSetup.setState({ host: await bridge.setZaicodeRouterMode(mode) });
  } finally {
    useZaicodeRouterSetup.setState({ busy: null });
  }
}

export async function scanZaicodeFreeModelsFromUi(): Promise<ZaicodeFreeScanResult | null> {
  const bridge = getZaicodeRouterSetupBridge();
  if (!bridge?.scanZaicodeFreeModels) return null;
  useZaicodeRouterSetup.setState({ busy: "scan" });
  try {
    const scan = await bridge.scanZaicodeFreeModels();
    useZaicodeRouterSetup.setState({ scan, lastScanAt: scan.lastScanAt });
    return scan;
  } finally {
    useZaicodeRouterSetup.setState({ busy: null });
  }
}

export async function addZaicodeFreeKeyFromUi(providerId: string, apiKey: string) {
  const bridge = getZaicodeRouterSetupBridge();
  if (!bridge?.addZaicodeFreeKey) return { ok: false, message: "Only in the desktop app.", added: 0 };
  useZaicodeRouterSetup.setState({ busy: "key" });
  try {
    return await bridge.addZaicodeFreeKey({ providerId, apiKey });
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error), added: 0 };
  } finally {
    useZaicodeRouterSetup.setState({ busy: null });
  }
}

/** "Today free model X added to SAIFREN" (one card for a batch). */
export function describeZaicodeFreeModelsAdded(added: readonly { id: string; provider: string }[]): { title: string; body: string } | null {
  if (added.length === 0) return null;
  const first = added[0]!;
  return {
    title: added.length === 1 ? `Today free model ${first.id} added to SAIFREN` : `Today ${added.length} free models added to SAIFREN`,
    body: added
      .slice(0, 6)
      .map((entry) => `${entry.id} (${entry.provider})`)
      .join(", ")
      .concat(added.length > 6 ? `, +${added.length - 6} more` : ""),
  };
}

/**
 * SRC-038: a pool is many models behind one name, several with 1M-token windows;
 * 128k was an artificial ceiling. The router falls over to the next model when
 * one of them cannot take a request that long.
 */
export const ZAICODE_POOL_CONTEXT_WINDOW = 1_000_000;
export const ZAICODE_POOL_MAX_OUTPUT = 131_072;
/** The ceiling ZAICODE itself wrote before SRC-038; only that exact value is raised. */
const LEGACY_POOL_CONTEXT_WINDOW = 128_000;

/** Model settings of a SAIROUTE pool: 1M context, 131k output (SRC-038 "1kk/131k"). */
export function zaicodePoolModelConfig() {
  return {
    enabled: true,
    properties: { contextWindow: ZAICODE_POOL_CONTEXT_WINDOW },
    optionSpecs: { maxOutputTokens: { max: ZAICODE_POOL_MAX_OUTPUT } },
  };
}

/**
 * Whether a pool model still carries the 128k ceiling ZAICODE wrote earlier.
 * A value the operator typed (anything else) is theirs and stays.
 */
export function zaicodePoolNeedsRaise(personalConfig: unknown): boolean {
  const properties = (personalConfig as { properties?: { contextWindow?: unknown } } | null)?.properties;
  return properties?.contextWindow === LEGACY_POOL_CONTEXT_WINDOW;
}
