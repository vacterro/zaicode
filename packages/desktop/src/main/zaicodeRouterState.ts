import type { ZaicodeRouterCall, ZaicodeRouterResponse } from "@zcode/shared";

export type ZaicodeRouterCaller = (call: ZaicodeRouterCall) => Promise<ZaicodeRouterResponse>;

interface RouterNode {
  id: string;
  prefix: string;
  baseUrl?: string | null;
  name?: string;
}
interface RouterConnection {
  id: string;
  provider: string;
  name?: string;
  isActive?: boolean;
}
interface RouterCombo {
  id: string;
  name: string;
  models: string[];
  kind?: string;
}

export interface ZaicodeRouterState {
  nodes: RouterNode[];
  connections: RouterConnection[];
  combos: RouterCombo[];
}

export function list<T>(data: unknown, key: string): T[] {
  const value = (data as Record<string, unknown> | null)?.[key];
  return Array.isArray(value) ? (value as T[]) : [];
}

export async function readZaicodeRouterState(
  call: ZaicodeRouterCaller,
): Promise<ZaicodeRouterState> {
  const [nodes, providers, combos] = await Promise.all([
    call({ method: "GET", path: "/api/provider-nodes" }),
    call({ method: "GET", path: "/api/providers" }),
    call({ method: "GET", path: "/api/combos" }),
  ]);
  const failed = [nodes, providers, combos].find((response) => !response.ok);
  if (failed) throw new Error(failed.message || `9router answered ${failed.status}`);
  return {
    nodes: list<RouterNode>(nodes.data, "nodes").map((node) => ({
      ...node,
      baseUrl: node.baseUrl ?? (node as { data?: { baseUrl?: string } }).data?.baseUrl ?? null,
    })),
    connections: list<RouterConnection>(providers.data, "connections"),
    combos: list<RouterCombo>(combos.data, "combos"),
  };
}

export async function setPoolModels(
  call: ZaicodeRouterCaller,
  pool: RouterCombo,
  models: string[],
): Promise<void> {
  const saved = await call({ method: "PUT", path: `/api/combos/${pool.id}`, body: { models } });
  if (!saved.ok) throw new Error(`${pool.name}: ${saved.message}`);
}
