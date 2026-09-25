import {
  ZAICODE_FREE_POOL,
  ZAICODE_FREE_PROVIDERS,
  ZAICODE_KEYLESS_API_KEY,
  ZAICODE_OWN_POOL,
  findZaicodeFreeProvider,
  planZaicodeFreePool,
  zaicodeFreeModelsFromListing,
  zaicodeNewFreeModels,
  zaicodePoolModelId,
  type ZaicodeFreeProvider,
  type ZaicodeRouterCall,
  type ZaicodeRouterResponse,
} from "@zcode/shared";

/**
 * Router setup without the operator (SRC-035, T-46), Electron-free so it runs
 * against a real or fake 9router in tests: SAIFREN filled from the keyless
 * free providers, SAIOPP present, ZAICODE's own API key, a first-token probe,
 * the daily free-model scan and one-step free-key providers.
 */

export type ZaicodeRouterCaller = (call: ZaicodeRouterCall) => Promise<ZaicodeRouterResponse>;

export interface ZaicodeSetupStep {
  id: string;
  label: string;
  status: "ok" | "fixed" | "failed" | "skipped";
  detail: string;
}

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
}

export interface ZaicodeRouterState {
  nodes: RouterNode[];
  connections: RouterConnection[];
  combos: RouterCombo[];
}

const PROBE_TIMEOUT_MS = 60_000;

function list<T>(data: unknown, key: string): T[] {
  const value = (data as Record<string, unknown> | null)?.[key];
  return Array.isArray(value) ? (value as T[]) : [];
}

export async function readZaicodeRouterState(call: ZaicodeRouterCaller): Promise<ZaicodeRouterState> {
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

async function createNode(call: ZaicodeRouterCaller, provider: ZaicodeFreeProvider): Promise<string> {
  const created = await call({
    method: "POST",
    path: "/api/provider-nodes",
    body: { type: "openai-compatible", name: provider.name, prefix: provider.prefix, baseUrl: provider.baseUrl, apiType: "chat" },
  });
  const id = (created.data as { node?: { id?: string } } | null)?.node?.id;
  if (!created.ok || !id) throw new Error(`${provider.name}: ${created.message || "9router returned no node"}`);
  return id;
}

async function createConnection(call: ZaicodeRouterCaller, nodeId: string, name: string, apiKey: string): Promise<string> {
  const created = await call({ method: "POST", path: "/api/providers", body: { provider: nodeId, apiKey, name } });
  const id = (created.data as { connection?: { id?: string } } | null)?.connection?.id;
  if (!created.ok || !id) throw new Error(`${name}: ${created.message || "9router returned no connection"}`);
  return id;
}

async function setPoolModels(call: ZaicodeRouterCaller, pool: RouterCombo, models: string[]): Promise<void> {
  const saved = await call({ method: "PUT", path: `/api/combos/${pool.id}`, body: { models } });
  if (!saved.ok) throw new Error(`${pool.name}: ${saved.message}`);
}

/**
 * SAIFREN answers with no setup: keyless providers wired in, pool created or
 * topped up with their checked models (after the operator's own, never
 * reordered), SAIOPP present for the operator's own best. Idempotent.
 */
export async function ensureZaicodeFreePool(
  call: ZaicodeRouterCaller,
  previouslyAdded: readonly string[] = [],
): Promise<{ steps: ZaicodeSetupStep[]; added: string[] }> {
  const steps: ZaicodeSetupStep[] = [];
  const added: string[] = [];
  let state = await readZaicodeRouterState(call);
  const pool = () => state.combos.find((combo) => combo.name === ZAICODE_FREE_POOL) ?? null;
  const plan = planZaicodeFreePool({ nodes: state.nodes, connections: state.connections, pool: pool()?.models ?? null });
  const createdNodes = new Map<string, string>();
  for (const step of plan) {
    if (step.kind === "create-node") {
      createdNodes.set(step.provider.id, await createNode(call, step.provider));
      steps.push({ id: `node:${step.provider.id}`, label: step.provider.name, status: "fixed", detail: "added to 9router (no key needed)" });
    } else if (step.kind === "create-connection") {
      const nodeId = step.nodeId ?? createdNodes.get(step.provider.id);
      if (!nodeId) continue;
      await createConnection(call, nodeId, step.provider.name, ZAICODE_KEYLESS_API_KEY);
      if (step.nodeId) steps.push({ id: `conn:${step.provider.id}`, label: step.provider.name, status: "fixed", detail: "connection restored" });
    } else if (step.kind === "create-pool") {
      const created = await call({ method: "POST", path: "/api/combos", body: { name: ZAICODE_FREE_POOL, models: step.models } });
      if (!created.ok) throw new Error(`${ZAICODE_FREE_POOL}: ${created.message}`);
      added.push(...step.models);
      steps.push({ id: "pool:free", label: ZAICODE_FREE_POOL, status: "fixed", detail: `created with ${step.models.length} free models` });
    } else if (step.kind === "add-models") {
      // A starter the operator took out of the pool stays out.
      const current = pool();
      const models = current ? step.models.filter((model) => !previouslyAdded.includes(model) || current.models.includes(model)) : [];
      if (current && models.length > 0) {
        await setPoolModels(call, current, [...current.models, ...models]);
        added.push(...models);
        steps.push({ id: "pool:free", label: ZAICODE_FREE_POOL, status: "fixed", detail: `${models.length} free model(s) added` });
      }
    }
  }
  if (!steps.some((step) => step.id === "pool:free")) steps.push({ id: "pool:free", label: ZAICODE_FREE_POOL, status: "ok", detail: "free providers and pool in place" });
  state = await readZaicodeRouterState(call);
  if (!state.combos.some((combo) => combo.name === ZAICODE_OWN_POOL)) {
    const created = await call({ method: "POST", path: "/api/combos", body: { name: ZAICODE_OWN_POOL, models: [] } });
    steps.push({
      id: "pool:own",
      label: ZAICODE_OWN_POOL,
      status: created.ok ? "fixed" : "failed",
      detail: created.ok ? "created (empty: add your subscriptions and best keys)" : created.message,
    });
  }
  return { steps, added };
}

/** ZAICODE's own key for 9router's OpenAI endpoint: the stored one while 9router still has it, else a new one. */
export async function ensureZaicodeRouterKey(call: ZaicodeRouterCaller, stored: string | null): Promise<{ key: string; created: boolean }> {
  const keys = await call({ method: "GET", path: "/api/keys" });
  if (!keys.ok) throw new Error(`9router keys: ${keys.message}`);
  const existing = list<{ key?: string; isActive?: boolean }>(keys.data, "keys");
  if (stored && existing.some((entry) => entry.key === stored && entry.isActive !== false)) return { key: stored, created: false };
  const created = await call({ method: "POST", path: "/api/keys", body: { name: "ZAICODE" } });
  const key = (created.data as { key?: string } | null)?.key;
  if (!created.ok || typeof key !== "string") throw new Error(`9router key: ${created.message || "no key returned"}`);
  return { key, created: true };
}

/** One tiny request through a pool (or a single `<prefix>/<model>`): the first-token check. */
export async function probeZaicodeRouterModel(
  url: string,
  key: string,
  model: string,
): Promise<{ ok: boolean; ms: number; detail: string; servedBy: string | null }> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with: OK" }], max_tokens: 16, stream: false }),
      signal: controller.signal,
    });
    const text = await response.text();
    let servedBy: string | null = null;
    try {
      servedBy = (JSON.parse(text) as { model?: string }).model ?? null;
    } catch {
      // not JSON: the detail below carries the text
    }
    return {
      ok: response.ok,
      ms: Date.now() - started,
      detail: response.ok ? `answered in ${((Date.now() - started) / 1000).toFixed(1)} s` : `${response.status}: ${text.slice(0, 200)}`,
      servedBy,
    };
  } catch (error) {
    return { ok: false, ms: Date.now() - started, detail: controller.signal.aborted ? "no answer in 60 s" : String(error), servedBy: null };
  } finally {
    clearTimeout(timer);
  }
}

export interface ZaicodeFreeScanMemory {
  /** Pool model ids the scanner added before (an operator removal is respected). */
  added: string[];
  lastScanAt: number | null;
}

export type ZaicodeJsonFetcher = (url: string) => Promise<unknown>;

/**
 * The free-model scan: every free provider wired into 9router lists its
 * models (keyless ones from their public list, keyed ones through 9router
 * with the operator's key); models the provider marks free and SAIFREN does
 * not have are appended. Returns what was added, for "free model X added".
 */
export async function scanZaicodeFreeModels(
  call: ZaicodeRouterCaller,
  fetchJson: ZaicodeJsonFetcher,
  memory: ZaicodeFreeScanMemory,
  now: number,
): Promise<{ added: { id: string; provider: string }[]; memory: ZaicodeFreeScanMemory; errors: string[] }> {
  const state = await readZaicodeRouterState(call);
  const pool = state.combos.find((combo) => combo.name === ZAICODE_FREE_POOL);
  if (!pool) return { added: [], memory: { ...memory, lastScanAt: now }, errors: [`${ZAICODE_FREE_POOL} does not exist yet`] };
  const errors: string[] = [];
  const found: { id: string; provider: string }[] = [];
  for (const provider of ZAICODE_FREE_PROVIDERS) {
    const node = state.nodes.find((candidate) => candidate.prefix === provider.prefix);
    const connection = node ? state.connections.find((candidate) => candidate.provider === node.id && candidate.isActive !== false) : undefined;
    if (!node || !connection) continue;
    try {
      const listing = provider.keyless
        ? await fetchJson(provider.modelsUrl)
        : ((await call({ method: "GET", path: `/api/providers/${connection.id}/models` })).data as { models?: unknown } | null)?.models;
      for (const model of zaicodeFreeModelsFromListing(provider.id, listing)) {
        found.push({ id: zaicodePoolModelId(node, model), provider: provider.name });
      }
    } catch (error) {
      errors.push(`${provider.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const removed = memory.added.filter((id) => !pool.models.includes(id));
  const fresh = zaicodeNewFreeModels(
    found.map((entry) => entry.id),
    pool.models,
    removed,
  );
  if (fresh.length > 0) await setPoolModels(call, pool, [...pool.models, ...fresh]);
  return {
    added: found.filter((entry) => fresh.includes(entry.id)),
    memory: { added: [...new Set([...memory.added, ...fresh])], lastScanAt: now },
    errors,
  };
}

/**
 * A free-key provider in one step: node (or the existing one), the key as a
 * connection (another key for an existing provider = key rotation), 9router's
 * connection test, then its free models appended to SAIFREN.
 */
export async function addZaicodeFreeKeyProvider(
  call: ZaicodeRouterCaller,
  providerId: string,
  apiKey: string,
): Promise<{ ok: boolean; message: string; added: number }> {
  const provider = findZaicodeFreeProvider(providerId);
  if (!provider) return { ok: false, message: `Unknown provider: ${providerId}`, added: 0 };
  const key = apiKey.trim();
  if (!key) return { ok: false, message: "Paste the key first.", added: 0 };
  const state = await readZaicodeRouterState(call);
  const node = state.nodes.find((candidate) => candidate.prefix === provider.prefix);
  const nodeId = node?.id ?? (await createNode(call, provider));
  const connectionId = await createConnection(call, nodeId, `${provider.name} key`, key);
  const test = await call({ method: "POST", path: `/api/providers/${connectionId}/test` });
  const valid = (test.data as { valid?: boolean; error?: string } | null)?.valid;
  if (test.ok && valid === false) {
    await call({ method: "DELETE", path: `/api/providers/${connectionId}` });
    return { ok: false, message: `${provider.name} refused the key: ${(test.data as { error?: string }).error ?? "invalid"}`, added: 0 };
  }
  const listing = ((await call({ method: "GET", path: `/api/providers/${connectionId}/models` })).data as { models?: unknown } | null)?.models;
  const models = zaicodeFreeModelsFromListing(provider.id, listing).map((model) => zaicodePoolModelId(provider, model));
  const pool = (await readZaicodeRouterState(call)).combos.find((combo) => combo.name === ZAICODE_FREE_POOL);
  const fresh = pool ? zaicodeNewFreeModels(models, pool.models) : [];
  if (pool && fresh.length > 0) await setPoolModels(call, pool, [...pool.models, ...fresh]);
  return { ok: true, message: `${provider.name}: key saved, ${fresh.length} free model(s) added to ${ZAICODE_FREE_POOL}`, added: fresh.length };
}
