import { useMemo } from "react";
import { create } from "zustand";
import {
  isZaicodeSubscriptionPlanEmpty,
  normalizeZaicodeRouterConnections,
  normalizeZaicodeRouterModels,
  planZaicodeSubscriptionSync,
  zaicodeSubscriptionAccounts,
  zaicodeSubscriptionConnectionOf,
  zaicodeSubscriptionReadiness,
  type ZaicodeRouterConnection,
  type ZaicodeSubscriptionAccount,
  type ZaicodeSubscriptionProviderState,
  type ZaicodeSubscriptionReadiness,
} from "@zcode/shared";
import type { useServices } from "@/hooks/useServices.js";
import { projectProviderSettingsViewToFormProviders } from "@/lib/providerSettingsFormProjection.js";
import { logger } from "@/logger.js";
import { notifyZaicode } from "./zaicodeNotifications.js";
import { zaicodeRouterCall } from "./zaicodeRouter.js";

/**
 * Renderer half of subscriptions as models (SRC-061). Keeps one provider per
 * 9router subscription account in the model list ("Codex 1", "Claude 2",
 * ...), each pointing at the account proxy in main, with that vendor's
 * models and their real efforts. It runs after the router setup, every ten
 * minutes, and whenever the model menu opens, so new accounts and models show
 * up and retired ones leave without anyone asking. It also reads how much is
 * left on each account for the bars in the model menu.
 */

type ProviderSettingsService = ReturnType<typeof useServices>["providerSettingsService"];

interface ZaicodeAccountProxyBridge {
  getZaicodeSubscriptionProxy?(): Promise<{ url: string; token: string } | null>;
}

function proxyBridge(): ZaicodeAccountProxyBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = (window as unknown as { zcode?: ZaicodeAccountProxyBridge }).zcode;
  return bridge?.getZaicodeSubscriptionProxy ? bridge : null;
}

export interface ZaicodeSubscriptionSyncResult {
  status: "ok" | "changed" | "skipped" | "failed";
  detail: string;
}

interface ZaicodeSubscriptionState {
  accounts: ZaicodeSubscriptionAccount[];
  connections: ZaicodeRouterConnection[];
  /** providerId in the model list -> 9router connection id. */
  providerAccount: Record<string, string>;
  readiness: Record<string, ZaicodeSubscriptionReadiness>;
  last: ZaicodeSubscriptionSyncResult | null;
  lastSyncAt: number | null;
  lastReadinessAt: number | null;
  busy: boolean;
}

export const useZaicodeSubscriptions = create<ZaicodeSubscriptionState>(() => ({
  accounts: [],
  connections: [],
  providerAccount: {},
  readiness: {},
  last: null,
  lastSyncAt: null,
  lastReadinessAt: null,
  busy: false,
}));

function accountProviders(view: Awaited<ReturnType<ProviderSettingsService["getView"]>>): ZaicodeSubscriptionProviderState[] {
  return projectProviderSettingsViewToFormProviders(view).flatMap((provider) => {
    const config = provider.config as { api?: { baseUrl?: unknown }; access?: { apiKey?: unknown } };
    const baseUrl = String(config.api?.baseUrl ?? "");
    if (!zaicodeSubscriptionConnectionOf(baseUrl)) return [];
    return [
      {
        providerId: provider.providerId,
        providerName: provider.providerName ?? "",
        baseUrl,
        apiKey: typeof config.access?.apiKey === "string" ? config.access.apiKey : null,
        modelIds: provider.models.map((model) => model.modelId),
      },
    ];
  });
}

async function applyPlan(
  service: ProviderSettingsService,
  plan: ReturnType<typeof planZaicodeSubscriptionSync>,
  token: string,
): Promise<string[]> {
  const said: string[] = [];
  const api = (baseUrl: string) => ({ type: "openai-chat-completions", baseUrl }) as const;
  for (const providerId of plan.remove) {
    await service.deletePersonalProvider(providerId);
  }
  if (plan.remove.length > 0) said.push(`${plan.remove.length} account(s) gone from 9router removed`);
  for (const entry of plan.create) {
    const made = await service.createPersonalProvider({
      providerName: entry.account.label,
      initialConfig: { access: { type: "api-key", apiKey: token }, api: api(entry.baseUrl) },
    });
    for (const spec of entry.models) {
      await service.addPersonalModel(made.providerId, spec.modelId, spec.config as never, true);
    }
    said.push(`${entry.account.label}: ${entry.models.length} models`);
  }
  for (const entry of plan.update) {
    if (entry.overlay) {
      const view = await service.getView();
      const current = projectProviderSettingsViewToFormProviders(view).find((provider) => provider.providerId === entry.providerId);
      const { builtinModelIds: _builtin, personalModelIds: _models, ...fields } = (current?.personalConfig ?? {}) as Record<string, unknown>;
      await service.savePersonalProviderOverlay(
        entry.providerId,
        {
          ...structuredClone(fields),
          access: { type: "api-key", apiKey: token },
          api: { ...(fields.api as object | undefined), ...api(entry.overlay.baseUrl) },
        } as never,
        { providerName: entry.overlay.providerName },
      );
    }
    for (const spec of entry.add) {
      await service.addPersonalModel(entry.providerId, spec.modelId, spec.config as never, true);
    }
    for (const modelId of entry.remove) {
      await service.deletePersonalModel(entry.providerId, modelId);
    }
    if (entry.add.length > 0) said.push(`${entry.account.label}: +${entry.add.map((spec) => spec.modelId).join(", ")}`);
    if (entry.remove.length > 0) said.push(`${entry.account.label}: retired ${entry.remove.join(", ")}`);
  }
  return said;
}

let service: ProviderSettingsService | null = null;
let inflight: Promise<ZaicodeSubscriptionSyncResult> | null = null;
const SYNC_MIN_GAP_MS = 30_000;
const READINESS_MIN_GAP_MS = 2 * 60_000;

/** The auto sync keeps the service it was mounted with; the model menu only asks for a refresh. */
export function setZaicodeSubscriptionService(next: ProviderSettingsService | null): void {
  service = next;
}

async function runSync(target: ProviderSettingsService): Promise<ZaicodeSubscriptionSyncResult> {
  const bridge = proxyBridge();
  if (!bridge) return { status: "skipped", detail: "only in the desktop app" };
  const proxy = await bridge.getZaicodeSubscriptionProxy!().catch(() => null);
  if (!proxy) return { status: "skipped", detail: "the account proxy could not start" };
  const [connectionsRead, modelsRead] = await Promise.all([
    zaicodeRouterCall({ method: "GET", path: "/api/providers" }),
    zaicodeRouterCall({ method: "GET", path: "/api/models" }),
  ]);
  // A router that does not answer is not "every account left": nothing is removed then.
  if (!connectionsRead.ok || !modelsRead.ok) {
    return { status: "skipped", detail: `9router did not answer (${connectionsRead.message || modelsRead.message})` };
  }
  const connections = normalizeZaicodeRouterConnections(connectionsRead.data);
  const accounts = zaicodeSubscriptionAccounts(connections);
  const view = await target.getView();
  const existing = accountProviders(view);
  const plan = planZaicodeSubscriptionSync({
    accounts,
    models: normalizeZaicodeRouterModels(modelsRead.data),
    proxyUrl: proxy.url,
    existing,
    apiKey: proxy.token,
  });
  const said = isZaicodeSubscriptionPlanEmpty(plan) ? [] : await applyPlan(target, plan, proxy.token);
  const after = accountProviders(await target.getView());
  useZaicodeSubscriptions.setState({
    accounts,
    connections,
    providerAccount: Object.fromEntries(
      after.map((provider) => [provider.providerId, zaicodeSubscriptionConnectionOf(provider.baseUrl)!]),
    ),
  });
  if (plan.create.length > 0) {
    notifyZaicode("router.accounts", {
      title:
        plan.create.length === 1
          ? `${plan.create[0]!.account.label} is in the model menu`
          : `${plan.create.length} subscription accounts are in the model menu`,
      body: "Pick the account, then the model, then the effort next to it.",
      status: "Subscriptions",
      key: "router.accounts",
    });
  }
  return said.length > 0
    ? { status: "changed", detail: said.join("; ") }
    : { status: "ok", detail: `${accounts.length} subscription account(s), nothing new` };
}

/** Accounts and models from 9router into the model list. One run at a time; `force` skips the gap. */
export function syncZaicodeSubscriptionModels(options: { force?: boolean } = {}): Promise<ZaicodeSubscriptionSyncResult> {
  const target = service;
  if (!target) return Promise.resolve({ status: "skipped", detail: "not started yet" });
  if (inflight) return inflight;
  const last = useZaicodeSubscriptions.getState().lastSyncAt;
  if (!options.force && last !== null && Date.now() - last < SYNC_MIN_GAP_MS) {
    return Promise.resolve(useZaicodeSubscriptions.getState().last ?? { status: "ok", detail: "" });
  }
  useZaicodeSubscriptions.setState({ busy: true });
  inflight = runSync(target)
    .catch((error: unknown) => {
      logger.warn("[zaicode-accounts] sync failed", { error: error instanceof Error ? error.message : String(error) });
      return { status: "failed" as const, detail: error instanceof Error ? error.message : String(error) };
    })
    .then((result) => {
      useZaicodeSubscriptions.setState({ last: result, lastSyncAt: Date.now(), busy: false });
      inflight = null;
      return result;
    });
  return inflight;
}

/** How much is left on each account (9router asks the vendor), for the bars. */
export async function refreshZaicodeSubscriptionReadiness(options: { force?: boolean } = {}): Promise<void> {
  const state = useZaicodeSubscriptions.getState();
  if (!options.force && state.lastReadinessAt !== null && Date.now() - state.lastReadinessAt < READINESS_MIN_GAP_MS) return;
  useZaicodeSubscriptions.setState({ lastReadinessAt: Date.now() });
  const connectionsRead = await zaicodeRouterCall({ method: "GET", path: "/api/providers" });
  if (!connectionsRead.ok) return;
  const connections = normalizeZaicodeRouterConnections(connectionsRead.data);
  const accounts = zaicodeSubscriptionAccounts(connections);
  const entries = await Promise.all(
    accounts.map(async (account) => {
      const usage = await zaicodeRouterCall({ method: "GET", path: `/api/usage/${account.connectionId}` }).catch(() => null);
      const connection = connections.find((entry) => entry.id === account.connectionId) ?? null;
      return [account.connectionId, zaicodeSubscriptionReadiness(account, connection, usage?.ok ? usage.data : null)] as const;
    }),
  );
  useZaicodeSubscriptions.setState({ accounts, connections, readiness: Object.fromEntries(entries) });
}

/** The model menu opened: pick up new accounts or models and fresh numbers (both rate limited). */
export function requestZaicodeSubscriptionRefresh(): void {
  if (!service) return;
  void syncZaicodeSubscriptionModels().then(() => refreshZaicodeSubscriptionReadiness());
}

/** Readiness of the account behind a provider in the model list, or null for any other provider. */
export function zaicodeProviderReadiness(
  state: Pick<ZaicodeSubscriptionState, "providerAccount" | "readiness">,
  providerId: string,
): ZaicodeSubscriptionReadiness | null {
  const connectionId = state.providerAccount[providerId];
  return connectionId ? (state.readiness[connectionId] ?? null) : null;
}

const TONE_COLORS: Record<ZaicodeSubscriptionReadiness["tone"], string> = {
  good: "#4f9a2f",
  warn: "#c9a227",
  bad: "#c8502a",
  blocked: "#7a2a22",
  unknown: "#5a5647",
  offline: "#3a372e",
};

/** The model menu's provider groups with a readiness bar on every subscription account. */
export function decorateZaicodeAccountGroups<T extends { key: string; readiness?: unknown }>(
  groups: readonly T[],
  state: Pick<ZaicodeSubscriptionState, "providerAccount" | "readiness">,
): T[] {
  return groups.map((group) => {
    const providerId = group.key.startsWith("registry-provider:") ? group.key.slice("registry-provider:".length) : null;
    const readiness = providerId ? zaicodeProviderReadiness(state, providerId) : null;
    if (!readiness) return group;
    return {
      ...group,
      readiness: { percent: readiness.remaining, color: TONE_COLORS[readiness.tone], text: readiness.text, title: readiness.title },
    };
  });
}

export function useZaicodeAccountReadinessGroups<T extends { key: string; readiness?: unknown }>(groups: T[]): T[] {
  const providerAccount = useZaicodeSubscriptions((state) => state.providerAccount);
  const readiness = useZaicodeSubscriptions((state) => state.readiness);
  return useMemo(() => decorateZaicodeAccountGroups(groups, { providerAccount, readiness }), [groups, providerAccount, readiness]);
}
