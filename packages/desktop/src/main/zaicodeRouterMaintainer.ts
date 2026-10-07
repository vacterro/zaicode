import { ZAICODE_FREE_POOL, zaicodeNewFreeModels } from "@zcode/shared";
import {
  discoverZaicodeRouterModels,
  type ZaicodeProviderModelCheck,
} from "./zaicodeRouterModelDiscovery.js";
import {
  list,
  readZaicodeRouterState,
  setPoolModels,
  type ZaicodeRouterCaller,
} from "./zaicodeRouterState.js";

export interface ZaicodeFreeScanMemory {
  /** Pool model ids the scanner added before (an operator removal is respected). */
  added: string[];
  lastScanAt: number | null;
  /** Consecutive successful provider listings in which an automatic model was absent. */
  missing?: Record<string, number>;
  /** Bounded direct-call evidence; failures lower a model without deleting it on a transient error. */
  health?: Record<
    string,
    {
      ok: number;
      failed: number;
      lastCheckedAt: number;
      lastMs: number | null;
      lastError: string | null;
    }
  >;
  /** Consecutive direct responses that explicitly say the model does not exist. */
  notFound?: Record<string, number>;
  /** A retired model is retried after this time, without re-adding it first. */
  retryAfter?: Record<string, number>;
  /** Provider-published context/tool capability, used only as a tie-breaker. */
  capability?: Record<string, number>;
  /** Scanner removal; unlike an operator removal, a future valid listing can restore it. */
  retired?: string[];
  /** Custom catalogue entries created by maintenance, distinct from user-owned entries. */
  catalogued?: string[];
}

export type ZaicodeJsonFetcher = (url: string) => Promise<unknown>;

export async function checkZaicodeRouterModels(
  call: ZaicodeRouterCaller,
  fetchJson: ZaicodeJsonFetcher,
  now: number,
) {
  const state = await readZaicodeRouterState(call);
  const discovery = await discoverZaicodeRouterModels(call, fetchJson, state);
  return {
    providers: discovery.providers,
    checked: discovery.providers.filter((provider) => provider.status === "reachable").length,
    errors: discovery.errors,
    checkedAt: now,
    tokensGenerated: 0 as const,
  };
}

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
): Promise<{
  added: { id: string; provider: string }[];
  removed: string[];
  checked: number;
  providers: ZaicodeProviderModelCheck[];
  memory: ZaicodeFreeScanMemory;
  errors: string[];
}> {
  const state = await readZaicodeRouterState(call);
  const discovery = await discoverZaicodeRouterModels(call, fetchJson, state);
  const errors = [...discovery.errors];
  const found: { id: string; provider: string }[] = [];
  const missing = { ...memory.missing };
  const retired = new Set(memory.retired ?? []);
  const catalogued = new Set(memory.catalogued ?? []);
  const confirmedAbsent = new Set<string>();
  const noLongerFree = new Set<string>();
  const knownCatalogue = await call({ method: "GET", path: "/api/models" });
  const knownRows = list<{ routedModel?: string; fullModel?: string }>(
    knownCatalogue.data,
    "models",
  );
  const knownIds = new Set(
    knownRows
      .map((row) => row.routedModel ?? row.fullModel)
      .filter((id): id is string => typeof id === "string"),
  );
  for (const listing of discovery.listings) {
    const listed = new Set(listing.supportedIds.map((id) => `${listing.prefix}/${id}`));
    const free = new Set(listing.free.map((id) => `${listing.prefix}/${id}`));
    for (const id of free) found.push({ id, provider: listing.provider });
    // 成功的完整目录才能累计缺失；429、鉴权失败和静态回退不是模型死亡证据。
    const chatCombos = state.combos.filter((combo) => !combo.kind || combo.kind === "llm");
    const candidates = new Set([...chatCombos.flatMap((combo) => combo.models), ...catalogued]);
    for (const model of [...candidates].filter((id) => id.startsWith(`${listing.prefix}/`))) {
      if (!listing.complete) continue;
      if (listed.has(model)) missing[model] = 0;
      else if (memory.lastScanAt !== now) {
        missing[model] = Math.min(3, (missing[model] ?? 0) + 1);
        if (missing[model] >= 2) confirmedAbsent.add(model);
      }
      const key = `free:${model}`;
      if (free.has(model)) missing[key] = 0;
      else if (memory.added.includes(model) && memory.lastScanAt !== now) {
        missing[key] = Math.min(3, (missing[key] ?? 0) + 1);
        if (missing[key] >= 2) noLongerFree.add(model);
      }
    }
    for (const row of listing.rows) {
      const id = `${listing.prefix}/${row.id}`;
      if (knownIds.has(id)) continue;
      const saved = await call({
        method: "POST",
        path: "/api/models/custom",
        body: {
          providerAlias: listing.prefix,
          id: row.id,
          type: "llm",
          name: typeof row.name === "string" ? row.name : row.id,
        },
      });
      if (saved.ok) {
        knownIds.add(id);
        catalogued.add(id);
      } else errors.push(`${id}: catalogue save failed (${saved.message || saved.status})`);
    }
  }
  // 发现期间外部编辑可能改变顺序/删除池：只能在当前池上应用增删差量，不能写旧快照。
  const latest = await readZaicodeRouterState(call);
  const pool = latest.combos.find((combo) => combo.name === ZAICODE_FREE_POOL);
  const initialPool = state.combos.find((combo) => combo.name === ZAICODE_FREE_POOL);
  const removedByOperator = memory.added.filter(
    (id) => !pool?.models.includes(id) && !retired.has(id),
  );
  const removedDuringScan = initialPool?.models.filter((id) => !pool?.models.includes(id)) ?? [];
  const fresh = pool
    ? zaicodeNewFreeModels(
        found.map((entry) => entry.id),
        pool.models,
        [...removedByOperator, ...removedDuringScan],
      )
    : [];
  const removed: string[] = [];
  for (const combo of latest.combos) {
    if (combo.kind && combo.kind !== "llm") continue;
    const shouldRemove = (id: string) =>
      confirmedAbsent.has(id) || (combo.name === ZAICODE_FREE_POOL && noLongerFree.has(id));
    const models = combo.models.filter((id) => !shouldRemove(id));
    if (combo.name === ZAICODE_FREE_POOL) models.push(...fresh.filter((id) => !shouldRemove(id)));
    if (
      models.length === combo.models.length &&
      models.every((id, index) => id === combo.models[index])
    )
      continue;
    await setPoolModels(call, combo, models);
    for (const id of combo.models.filter(shouldRemove)) {
      removed.push(id);
      retired.add(id);
    }
  }
  for (const id of confirmedAbsent) {
    if (!catalogued.has(id)) continue;
    const split = id.indexOf("/");
    const deleted = await call({
      method: "DELETE",
      path: `/api/models/custom?providerAlias=${encodeURIComponent(id.slice(0, split))}&id=${encodeURIComponent(id.slice(split + 1))}&type=llm`,
    });
    if (deleted.ok) catalogued.delete(id);
    else errors.push(`${id}: catalogue removal failed (${deleted.message || deleted.status})`);
  }
  for (const model of fresh) retired.delete(model);
  return {
    added: found.filter((entry) => fresh.includes(entry.id) && !confirmedAbsent.has(entry.id)),
    removed: [...new Set(removed)],
    checked: discovery.providers.filter((provider) => provider.status === "reachable").length,
    providers: discovery.providers,
    memory: {
      ...memory,
      added: [...new Set([...memory.added, ...fresh])],
      missing,
      retired: [...retired],
      catalogued: [...catalogued],
      lastScanAt: now,
    },
    errors,
  };
}
