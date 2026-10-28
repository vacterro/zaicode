import {
  ZAICODE_FREE_PROVIDERS,
  zaicodeFreeModelsFromListing,
  zaicodeRouterAliasOf,
} from "@zcode/shared";
import type { ZaicodeRouterCaller, ZaicodeRouterState } from "./zaicodeRouterState.js";

export interface ZaicodeProviderModelCheck {
  provider: string;
  prefix: string;
  name: string;
  status: "reachable" | "catalogue-only" | "unavailable" | "needs-connection";
  models: number;
  free: number;
  ms: number | null;
  detail: string;
}

export interface ZaicodeModelDiscovery {
  providers: ZaicodeProviderModelCheck[];
  listings: {
    prefix: string;
    provider: string;
    rows: Record<string, unknown>[];
    supportedIds: string[];
    free: string[];
    complete: boolean;
  }[];
  errors: string[];
}

type ZaicodeJsonFetcher = (url: string) => Promise<unknown>;

interface Target {
  provider: string;
  prefix: string;
  name: string;
  connections: string[];
  publicUrl?: string;
  freePolicy: string;
  catalogue: Record<string, unknown>[];
  custom?: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function modelRows(value: unknown): Record<string, unknown>[] | null {
  const root = record(value);
  const rows = Array.isArray(value) ? value : (root.data ?? root.models);
  if (!Array.isArray(rows)) return null;
  const result: Record<string, unknown>[] = [];
  for (const row of rows) {
    const entry = typeof row === "string" ? { id: row } : record(row);
    const id = entry.id ?? entry.model ?? entry.name;
    if (typeof id !== "string" || !id.trim()) return null;
    result.push({ ...entry, id });
  }
  return result;
}

const CHAT_ONLY =
  /whisper|tts|embed|bge-|stable-diffusion|guard|safety|lyria|image|vision-only|rerank|moderation|audio|speech/i;
const chatRows = (rows: Record<string, unknown>[]) =>
  rows.filter(
    (row) =>
      !CHAT_ONLY.test(String(row.id)) &&
      row.deprecated !== true &&
      row.is_deprecated !== true &&
      row.status !== "deprecated",
  );

/** One bounded metadata sweep; credentials and OAuth refresh remain owned by 9router. */
export async function discoverZaicodeRouterModels(
  call: ZaicodeRouterCaller,
  fetchJson: ZaicodeJsonFetcher,
  state: ZaicodeRouterState,
): Promise<ZaicodeModelDiscovery> {
  const response = await call({ method: "GET", path: "/api/models" });
  const catalogue = modelRows(response.data) ?? [];
  const errors: string[] = response.ok
    ? []
    : [`Router catalogue: ${response.message || response.status}`];
  const targets = new Map<string, Target>();
  for (const row of catalogue) {
    const provider = String(row.provider ?? "");
    const routed = String(row.routedModel ?? row.fullModel ?? "");
    const prefix = routed.includes("/") ? routed.slice(0, routed.indexOf("/")) : provider;
    if (!provider || !prefix) continue;
    // 原生名称和自定义目录的 alias 指向同一前缀，不能重复显示或扫描。
    const target = targets.get(provider) ??
      [...targets.values()].find((entry) => entry.prefix === prefix) ?? {
        provider,
        prefix,
        name: provider,
        connections: [],
        freePolicy: "unknown",
        catalogue: [],
      };
    target.catalogue.push(row);
    targets.set(target.provider, target);
  }
  for (const node of state.nodes) {
    const known = ZAICODE_FREE_PROVIDERS.find(
      (provider) =>
        provider.prefix === node.prefix &&
        node.baseUrl?.replace(/\/+$/, "") === provider.baseUrl.replace(/\/+$/, ""),
    );
    for (const [id, target] of targets) {
      if (target.prefix === node.prefix) targets.delete(id);
    }
    targets.set(node.id, {
      provider: node.id,
      prefix: node.prefix,
      name: node.name ?? node.prefix,
      connections: [],
      custom: true,
      freePolicy: known?.id ?? "unknown",
      ...(known?.keyless ? { publicUrl: known.modelsUrl } : {}),
      catalogue: catalogue.filter((row) =>
        String(row.routedModel ?? row.fullModel ?? "").startsWith(`${node.prefix}/`),
      ),
    });
  }
  for (const connection of state.connections) {
    if (connection.isActive === false) continue;
    const alias = zaicodeRouterAliasOf(connection.provider);
    const target = targets.get(connection.provider) ??
      targets.get(alias) ?? {
        provider: connection.provider,
        prefix: alias,
        name: connection.name ?? connection.provider,
        connections: [],
        freePolicy: "unknown",
        catalogue: [],
      };
    target.provider = connection.provider;
    target.connections.push(connection.id);
    if (alias !== connection.provider) targets.delete(alias);
    targets.set(connection.provider, target);
  }
  // 9router 原生 OpenCode Free 是无密钥 oc 路由；不能要求另建 zen 节点才扫描。
  const nativeOpenCode = targets.get("opencode") ?? targets.get("oc");
  if (nativeOpenCode && nativeOpenCode.prefix === "oc") {
    nativeOpenCode.name = "OpenCode Free";
    nativeOpenCode.publicUrl = "https://opencode.ai/zen/v1/models";
    nativeOpenCode.freePolicy = "opencode";
  }
  const ordered = [...targets.values()].sort(
    (a, b) => Number(Boolean(b.publicUrl)) - Number(Boolean(a.publicUrl)),
  );
  const results: {
    check: ZaicodeProviderModelCheck;
    listing?: ZaicodeModelDiscovery["listings"][number];
    error?: string;
  }[] = new Array(ordered.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, ordered.length) }, async () => {
      while (next < ordered.length) {
        const index = next++;
        const target = ordered[index]!;
        const base = {
          provider: target.provider,
          prefix: target.prefix,
          name: target.name,
          models: 0,
          free: 0,
          ms: null,
        };
        if (!target.publicUrl && !target.connections.length) {
          results[index] = {
            check: {
              ...base,
              status: "needs-connection",
              detail: "Connect this provider to check its model listing",
            },
          };
          continue;
        }
        const started = Date.now();
        try {
          let payload: unknown;
          if (target.publicUrl) payload = await fetchJson(target.publicUrl);
          else {
            let lastError = "No active account answered";
            for (const id of target.connections) {
              const listing = await call({
                method: "GET",
                path: `/api/providers/${encodeURIComponent(id)}/models`,
              });
              if (listing.ok) {
                payload = listing.data;
                break;
              }
              lastError = listing.message || `HTTP ${listing.status}`;
            }
            if (payload === undefined) throw new Error(lastError);
          }
          const raw = modelRows(payload);
          if (!raw) throw new Error("Invalid model listing; no complete model array");
          const root = record(payload);
          const warning = typeof root.warning === "string" ? root.warning : "";
          const complete =
            !warning &&
            !root.has_more &&
            !root.hasMore &&
            !root.next &&
            !root.next_page_token &&
            // 部分原生 OAuth resolver 在解析失败时返回空数组；空目录不能证明全部模型死亡。
            (raw.length > 0 || target.custom === true);
          const rows = chatRows(raw);
          const free = zaicodeFreeModelsFromListing(target.freePolicy, rows);
          const absenceConfirmed =
            complete && (Boolean(target.publicUrl) || target.connections.length === 1);
          results[index] = {
            check: {
              ...base,
              status: complete ? "reachable" : "catalogue-only",
              models: rows.length,
              free: free.length,
              ms: Date.now() - started,
              detail:
                warning ||
                (complete
                  ? "Live metadata listing; generation and quota not tested" +
                    (absenceConfirmed
                      ? ""
                      : "; other account catalogues not checked, absence unconfirmed")
                  : "Partial catalogue; absence is unconfirmed"),
            },
            ...(complete
              ? {
                  listing: {
                    prefix: target.prefix,
                    provider: target.name,
                    rows,
                    // 名称过滤只影响推荐，仍列出的图像/音频模型不能被误判为死亡。
                    supportedIds: raw.map((row) => String(row.id)),
                    free,
                    complete: absenceConfirmed,
                  },
                }
              : {}),
          };
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          results[index] = {
            check: { ...base, status: "unavailable", ms: Date.now() - started, detail },
            error: `${target.name}: ${detail}`,
          };
        }
      }
    }),
  );
  return {
    providers: results.map((result) => result.check),
    listings: results.flatMap((result) => (result.listing ? [result.listing] : [])),
    errors: [...errors, ...results.flatMap((result) => (result.error ? [result.error] : []))],
  };
}
