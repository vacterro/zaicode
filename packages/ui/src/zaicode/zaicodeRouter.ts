import { create } from "zustand";
import {
  normalizeZaicodeRouterCombos,
  normalizeZaicodeRouterConnections,
  normalizeZaicodeRouterModels,
  normalizeZaicodeRouterNodes,
  type ZaicodeRouterCall,
  type ZaicodeRouterCombo,
  type ZaicodeRouterConnection,
  type ZaicodeRouterModel,
  type ZaicodeRouterNode,
  type ZaicodeRouterResponse,
} from "@zcode/shared";

/**
 * Renderer half of ZAICODE Router: one store with what 9router has
 * (connections, custom provider nodes, pools, models, today's usage) and
 * the calls that change it. Every change goes to 9router first and the
 * store re-reads afterwards, so what ZAICODE shows is what 9router holds.
 */

export interface ZaicodeRouterInfo {
  url: string;
  dataDir: string;
  installed: boolean;
  credential: boolean;
  extraUpdateScript: string | null;
}

interface RouterBridge {
  callZaicodeRouter?(call: ZaicodeRouterCall): Promise<ZaicodeRouterResponse>;
  getZaicodeRouterInfo?(): Promise<ZaicodeRouterInfo>;
  startZaicodeRouter?(): Promise<{ ok: boolean; message: string }>;
  openZaicodeRouterDashboard?(page: string): Promise<{ ok: boolean; message: string }>;
  runZaicodeRouterExtraUpdate?(): Promise<{ ok: boolean; message: string }>;
}

export function getZaicodeRouterBridge(): RouterBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { zcode?: RouterBridge }).zcode;
}

export interface ZaicodeRouterUsage {
  requests: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export type ZaicodeRouterStatus = "idle" | "loading" | "up" | "down" | "unavailable";

interface ZaicodeRouterState {
  status: ZaicodeRouterStatus;
  message: string;
  info: ZaicodeRouterInfo | null;
  version: string | null;
  latestVersion: string | null;
  connections: ZaicodeRouterConnection[];
  nodes: ZaicodeRouterNode[];
  combos: ZaicodeRouterCombo[];
  models: ZaicodeRouterModel[];
  settings: Record<string, unknown> | null;
  usage: ZaicodeRouterUsage | null;
  busy: string | null;
  /** Tab the Router page opens on next (set by entry points elsewhere, taken once). */
  requestedTab: string | null;
  requestTab: (tab: string | null) => void;
  refresh: () => Promise<void>;
  setBusy: (busy: string | null) => void;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 9router usage stats -> the three numbers the overview shows (field names vary by version). */
export function readZaicodeRouterUsage(raw: unknown): ZaicodeRouterUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const found = num(value[key]);
      if (found !== null) return found;
    }
    return null;
  };
  return {
    requests: pick("totalRequests", "requests", "requestCount"),
    inputTokens: pick("totalPromptTokens", "totalInputTokens", "promptTokens", "inputTokens"),
    outputTokens: pick("totalCompletionTokens", "totalOutputTokens", "completionTokens", "outputTokens"),
  };
}

export async function zaicodeRouterCall<T = unknown>(call: ZaicodeRouterCall): Promise<ZaicodeRouterResponse<T>> {
  const bridge = getZaicodeRouterBridge();
  if (!bridge?.callZaicodeRouter) {
    return { ok: false, status: 0, data: null, message: "The Router page needs the desktop app." };
  }
  return (await bridge.callZaicodeRouter(call)) as ZaicodeRouterResponse<T>;
}

export const useZaicodeRouter = create<ZaicodeRouterState>((set, get) => ({
  status: "idle",
  message: "",
  info: null,
  version: null,
  latestVersion: null,
  connections: [],
  nodes: [],
  combos: [],
  models: [],
  settings: null,
  usage: null,
  busy: null,
  requestedTab: null,
  requestTab: (requestedTab) => set({ requestedTab }),
  setBusy: (busy) => set({ busy }),
  refresh: async () => {
    const bridge = getZaicodeRouterBridge();
    if (!bridge?.callZaicodeRouter) {
      set({ status: "unavailable", message: "The Router page needs the desktop app." });
      return;
    }
    set({ status: get().status === "up" ? "up" : "loading" });
    const info = (await bridge.getZaicodeRouterInfo?.()) ?? null;
    const version = await zaicodeRouterCall<{ currentVersion?: string; latestVersion?: string }>({ method: "GET", path: "/api/version" });
    if (!version.ok) {
      set({ status: "down", message: version.message, info });
      return;
    }
    const [connections, nodes, combos, models, settings, usage] = await Promise.all([
      zaicodeRouterCall({ method: "GET", path: "/api/providers" }),
      zaicodeRouterCall({ method: "GET", path: "/api/provider-nodes" }),
      zaicodeRouterCall({ method: "GET", path: "/api/combos" }),
      zaicodeRouterCall({ method: "GET", path: "/api/models" }),
      zaicodeRouterCall<Record<string, unknown>>({ method: "GET", path: "/api/settings" }),
      zaicodeRouterCall({ method: "GET", path: "/api/usage/stats?period=today" }),
    ]);
    const failed = [connections, nodes, combos, models].find((response) => !response.ok);
    set({
      status: "up",
      message: failed ? failed.message : "",
      info,
      version: version.data?.currentVersion ?? null,
      latestVersion: version.data?.latestVersion ?? null,
      connections: normalizeZaicodeRouterConnections(connections.data),
      nodes: normalizeZaicodeRouterNodes(nodes.data),
      combos: normalizeZaicodeRouterCombos(combos.data, settings.data),
      models: normalizeZaicodeRouterModels(models.data),
      settings: settings.ok ? settings.data : null,
      usage: usage.ok ? readZaicodeRouterUsage(usage.data) : null,
    });
  },
}));

/** Runs a change, then re-reads 9router. Returns the change's own answer. */
export async function zaicodeRouterChange(label: string, call: ZaicodeRouterCall): Promise<ZaicodeRouterResponse> {
  const store = useZaicodeRouter.getState();
  store.setBusy(label);
  try {
    const result = await zaicodeRouterCall(call);
    await store.refresh();
    return result;
  } finally {
    useZaicodeRouter.getState().setBusy(null);
  }
}
