import { useEffect } from "react";
import { ZAICODE_FREE_POOL, ZAICODE_OWN_POOL } from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import { projectProviderSettingsViewToFormProviders } from "@/lib/providerSettingsFormProjection.js";
import { notifyZaicode } from "./zaicodeNotifications.js";
import { readZaicodeDefaultModel, setZaicodeDefaultModel } from "./zaicodeDefaultModel.js";
import { findZaicodeRouterProvider } from "./zaicodeRoutingModel.js";
import {
  ZAICODE_POOL_CONTEXT_WINDOW,
  ZAICODE_POOL_MAX_OUTPUT,
  describeZaicodeFreeModelsAdded,
  zaicodePoolModelConfig,
  zaicodePoolNeedsRaise,
  getZaicodeRouterSetupBridge,
  refreshZaicodeRouterHost,
  scanZaicodeFreeModelsFromUi,
  useZaicodeRouterSetup,
  type ZaicodeRouterBootstrapResult,
  type ZaicodeRouterSetupStep,
} from "./zaicodeRouterSetup.js";

/**
 * Zero setup, app side (SRC-035, T-46): once per start the main process makes
 * the router answer (SAIFREN filled, first token checked) and this adds the
 * one thing only the app can: a "SAIRoute" provider in the model list that
 * points at that router, with SAIFREN and SAIOPP as models and SAIFREN as the
 * default for new tasks when nothing else was chosen. Then the free-model
 * scan runs daily and says what it added.
 */

type ProviderSettingsService = ReturnType<typeof useServices>["providerSettingsService"];

const ROUTER_PROVIDER_NAME = "SAIRoute";
const POOL_LIMITS_REV_KEY = "zaicode-pool-limits-rev";
const POOL_LIMITS_REV = 1;
const SCAN_EVERY_MS = 20 * 60 * 60 * 1000;
const SCAN_CHECK_MS = 60 * 60 * 1000;

let started = false;

function portOf(url: string | null | undefined): string | null {
  return url ? (/:(\d+)(?:\/|$)/.exec(url.replace(/^[a-z]+:\/\//, ""))?.[1] ?? null) : null;
}

function baseUrlOf(provider: { config: unknown }): string {
  return String((provider.config as { api?: { baseUrl?: unknown } }).api?.baseUrl ?? "");
}

/** Once per machine: SAIFREN / SAIOPP created with 128k get 1M / 131k. */
async function raiseLegacyPoolLimits(service: ProviderSettingsService, providerId: string): Promise<void> {
  try {
    if (Number(localStorage.getItem(POOL_LIMITS_REV_KEY) ?? 0) >= POOL_LIMITS_REV) return;
  } catch {
    // no storage: try every start, the check below is idempotent
  }
  const view = await service.getView();
  const provider = projectProviderSettingsViewToFormProviders(view).find((entry) => entry.providerId === providerId);
  for (const model of provider?.models ?? []) {
    if (model.modelId !== ZAICODE_FREE_POOL && model.modelId !== ZAICODE_OWN_POOL) continue;
    if (!zaicodePoolNeedsRaise(model.personalConfig)) continue;
    const current = model.personalConfig as { properties?: object; optionSpecs?: { maxOutputTokens?: object } };
    const latest = await service.getView();
    await service.savePersonalModelDraft({
      providerId,
      originalModelId: model.modelId,
      nextModelId: model.modelId,
      personalConfig: {
        ...current,
        properties: { ...current.properties, contextWindow: ZAICODE_POOL_CONTEXT_WINDOW },
        optionSpecs: {
          ...current.optionSpecs,
          maxOutputTokens: { ...current.optionSpecs?.maxOutputTokens, max: ZAICODE_POOL_MAX_OUTPUT },
        },
      } as never,
      ...(model.useRecommendedConfig === undefined ? {} : { useRecommendedConfig: model.useRecommendedConfig }),
      basedOnRevision: latest.revision,
    });
  }
  try {
    localStorage.setItem(POOL_LIMITS_REV_KEY, String(POOL_LIMITS_REV));
  } catch {
    // preference only
  }
}

/** The app-side link: the SAIRoute provider exists, points at the router, lists both pools. */
async function ensureRouterProvider(service: ProviderSettingsService, result: ZaicodeRouterBootstrapResult): Promise<ZaicodeRouterSetupStep> {
  const url = result.host.url;
  const providers = projectProviderSettingsViewToFormProviders(await service.getView());
  let provider = findZaicodeRouterProvider(providers, url);
  const apiConfig = { type: "openai-chat-completions", baseUrl: `${url}/v1` } as const;
  let created = false;
  if (!provider) {
    if (!result.apiKey) return { id: "app", label: "Model list", status: "failed", detail: "no key from the router to create SAIRoute" };
    const made = await service.createPersonalProvider({
      providerName: ROUTER_PROVIDER_NAME,
      initialConfig: { access: { type: "api-key", apiKey: result.apiKey }, api: { ...apiConfig } },
    });
    provider = projectProviderSettingsViewToFormProviders(await service.getView()).find((entry) => entry.providerId === made.providerId) ?? null;
    created = true;
  } else if (portOf(baseUrlOf(provider)) !== portOf(url) && result.apiKey) {
    // The router moved (shared <-> isolated): same provider, new address and key.
    const { builtinModelIds: _builtin, personalModelIds: _models, ...fields } = provider.personalConfig as Record<string, unknown>;
    await service.savePersonalProviderOverlay(provider.providerId, {
      ...structuredClone(fields),
      access: { type: "api-key", apiKey: result.apiKey },
      api: { ...(fields.api as object | undefined), ...apiConfig },
    } as never);
  }
  if (!provider) return { id: "app", label: "Model list", status: "failed", detail: "SAIRoute could not be created" };
  const listed = new Set(provider.models.map((model) => model.modelId));
  for (const pool of [ZAICODE_FREE_POOL, ZAICODE_OWN_POOL]) {
    if (!listed.has(pool)) {
      await service.addPersonalModel(provider.providerId, pool, zaicodePoolModelConfig(), true);
    }
  }
  await raiseLegacyPoolLimits(service, provider.providerId);
  // A default that names no existing model (none yet, or the operator's bundled one on a fresh machine) becomes SAIFREN.
  const chosen = readZaicodeDefaultModel();
  const after = projectProviderSettingsViewToFormProviders(await service.getView());
  const resolves = chosen && after.some((entry) => entry.providerId === chosen.providerId && entry.models.some((model) => model.modelId === chosen.modelId));
  if (!resolves) setZaicodeDefaultModel({ providerId: provider.providerId, modelId: ZAICODE_FREE_POOL });
  if (created) {
    notifyZaicode("router.ready", {
      title: "SAIFREN is ready",
      body: "Free models, nothing to set up: write a task in New task and press Enter.",
      status: "Ready",
      key: "router.ready",
    });
  }
  return {
    id: "app",
    label: "Model list",
    status: created ? "fixed" : "ok",
    detail: created ? `${ROUTER_PROVIDER_NAME} added with ${ZAICODE_FREE_POOL} and ${ZAICODE_OWN_POOL}` : `${provider.providerName || ROUTER_PROVIDER_NAME} points at ${url}`,
  };
}

/** Bootstrap (start) or Autotroubleshoot (button): main process chain, then the app-side link. */
export async function runZaicodeRouterSetup(service: ProviderSettingsService, kind: "setup" | "troubleshoot"): Promise<ZaicodeRouterBootstrapResult | null> {
  const bridge = getZaicodeRouterSetupBridge();
  if (!bridge) return null;
  useZaicodeRouterSetup.setState({ busy: kind });
  try {
    const host = await refreshZaicodeRouterHost();
    const providers = projectProviderSettingsViewToFormProviders(await service.getView());
    const existing = findZaicodeRouterProvider(providers, host?.url ?? null);
    const needKey = kind === "troubleshoot" || !existing || portOf(baseUrlOf(existing)) !== portOf(host?.url);
    const result =
      kind === "troubleshoot" ? await bridge.troubleshootZaicodeRouter!() : await bridge.bootstrapZaicodeRouter!({ needKey });
    let appStep: ZaicodeRouterSetupStep;
    try {
      appStep = result.host && (result.ok || result.apiKey || existing) ? await ensureRouterProvider(service, result) : { id: "app", label: "Model list", status: "skipped", detail: "router not ready" };
    } catch (error) {
      appStep = { id: "app", label: "Model list", status: "failed", detail: error instanceof Error ? error.message : String(error) };
    }
    useZaicodeRouterSetup.setState({ last: result, lastKind: kind, appStep, host: result.host });
    return result;
  } catch (error) {
    logger.warn("[zaicode-router] setup failed", { error: error instanceof Error ? error.message : String(error) });
    return null;
  } finally {
    useZaicodeRouterSetup.setState({ busy: null });
  }
}

async function scanIfDue(): Promise<void> {
  const last = useZaicodeRouterSetup.getState().lastScanAt;
  if (last !== null && Date.now() - last < SCAN_EVERY_MS) return;
  const scan = await scanZaicodeFreeModelsFromUi().catch(() => null);
  const card = scan ? describeZaicodeFreeModelsAdded(scan.added) : null;
  if (card) notifyZaicode("router.free", { ...card, status: "New free model", key: "router.free" });
}

/** Mount once (ZAICODE runtime): setup at start, then the daily scan. */
export function useZaicodeRouterAutoSetup(): void {
  const { providerSettingsService } = useServices();
  useEffect(() => {
    if (started || !getZaicodeRouterSetupBridge()) return;
    started = true;
    let timer: number | null = null;
    void runZaicodeRouterSetup(providerSettingsService, "setup").then(() => {
      void scanIfDue();
      timer = window.setInterval(() => void scanIfDue(), SCAN_CHECK_MS);
    });
    return () => {
      if (timer !== null) window.clearInterval(timer);
    };
  }, [providerSettingsService]);
}
