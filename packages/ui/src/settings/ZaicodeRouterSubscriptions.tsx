import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useModelProviders } from "@/hooks/useModelProviders.js";
import type { ProviderSettingsFormModel } from "@/lib/providerSettingsFormTypes.js";
import { zaicodeSubscriptionModels, type ZaicodeRouterModel } from "@zcode/shared";
import { setZaicodeDefaultModel } from "@/zaicode/zaicodeDefaultModel.js";
import { readZaicodeCurrentWorkspace } from "@/zaicode/zaicodeEngines.js";
import { getZaicodeRouterBridge, useZaicodeRouter } from "@/zaicode/zaicodeRouter.js";
import { findZaicodeRouterProvider } from "@/zaicode/zaicodeRoutingModel.js";

/**
 * Router -> Subscriptions as models. A subscription connected in 9router
 * (Codex, Antigravity, Claude Code, ...) is served by 9router over the same
 * OpenAI-compatible endpoint ZAICODE's SAIRoute provider already uses, so
 * listing `cx/gpt-...` under SAIRoute makes it an ordinary model in every
 * model menu: no terminal, no worker, ZAICODE's own tools and transcript.
 */

/** Model config for a subscription model: 9router's own caps where it knows them, the rest recommended. */
function modelConfigOf(model: ZaicodeRouterModel): ProviderSettingsFormModel["personalConfig"] {
  const properties: Record<string, unknown> = {};
  if (model.contextWindow) properties.contextWindow = model.contextWindow;
  if (model.vision) properties.inputFormat = { supportsImage: true, supportsVideo: false, supportsPdf: false };
  return {
    enabled: true,
    ...(Object.keys(properties).length > 0 ? { properties } : {}),
    ...(model.maxOutput ? { optionSpecs: { maxOutputTokens: { max: model.maxOutput } } } : {}),
  } as ProviderSettingsFormModel["personalConfig"];
}

export function ZaicodeRouterSubscriptions() {
  const router = useZaicodeRouter();
  const workspacePath = readZaicodeCurrentWorkspace()?.path ?? "";
  const { modelProviders, addPersonalModel } = useModelProviders({ workspacePath });
  const [adding, setAdding] = useState<string | null>(null);
  const groups = useMemo(() => zaicodeSubscriptionModels(router.connections, router.models), [router.connections, router.models]);
  const routerProvider = findZaicodeRouterProvider(modelProviders, router.info?.url ?? null);
  const listed = new Set(
    (modelProviders.find((provider) => provider.providerId === routerProvider?.providerId)?.models ?? []).map((model) => model.modelId),
  );

  const add = async (model: ZaicodeRouterModel, andUse: boolean) => {
    if (!routerProvider) return;
    setAdding(model.id);
    try {
      if (!listed.has(model.id)) await addPersonalModel(routerProvider.providerId, model.id, modelConfigOf(model), true);
      if (andUse) setZaicodeDefaultModel({ providerId: routerProvider.providerId, modelId: model.id });
      toast(andUse ? `${model.id} is in the model list and is the default for new sessions` : `${model.id} is in the model list`);
    } catch (error) {
      toast(`Not added: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setAdding(null);
    }
  };

  return (
    <section className="flex flex-col gap-2 border border-border bg-card p-3 text-ui-xs" data-zaicode-router-subscriptions>
      <div>
        <h2 className="text-ui-lg text-foreground">Subscriptions as models</h2>
        <p className="mt-0.5 max-w-[680px] text-foreground-subtle">
          A subscription connected in 9router becomes an ordinary model in ZAICODE: it runs inside the app (ZAICODE's tools, transcript,
          queue), not in a terminal. Its quota is the same one the vendor's CLI uses, and whether a vendor allows its subscription to be
          used through a proxy is that vendor's terms, not a ZAICODE setting.
        </p>
      </div>
      {!routerProvider ? (
        <p className="text-[#e0a040]">
          No ZAICODE provider points at 9router yet. Add one in Settings → Models: OpenAI chat completions, base URL {router.info?.url ?? ""}/v1,
          a 9router key. Then this list can add models to it.
        </p>
      ) : (
        <p className="text-foreground-subtlest">
          Adds to: <span className="text-foreground">{routerProvider.providerName || routerProvider.providerId}</span>
        </p>
      )}
      {groups.length === 0 ? (
        <p className="text-foreground-subtle">
          No subscription is connected in 9router.{" "}
          <button type="button" className="underline" onClick={() => void getZaicodeRouterBridge()?.openZaicodeRouterDashboard?.("providers")}>
            Connect one in the 9router dashboard
          </button>{" "}
          (Codex, Antigravity, Claude Code, … sign in there), then Refresh.
        </p>
      ) : null}
      {groups.map((group) => (
        <div key={group.provider} className="flex flex-col gap-0.5 border border-border p-2">
          <div className="flex items-center gap-2">
            <strong className="font-normal text-foreground">{group.label}</strong>
            <span className="text-foreground-subtlest">{group.provider}</span>
            {!group.active ? <span className="text-[#e0a040]">off in 9router</span> : null}
            <span className="ml-auto text-foreground-subtlest">{group.models.length} models</span>
          </div>
          {group.models.length === 0 ? <span className="text-foreground-subtlest">9router lists no models for it.</span> : null}
          <div className="flex max-h-[240px] flex-col overflow-y-auto">
            {group.models.map((model) => {
              const inList = listed.has(model.id);
              return (
                <div key={model.id} className="flex items-center gap-2 border-b border-border/40 px-1 last:border-b-0">
                  <span className="min-w-0 flex-1 truncate font-mono text-foreground" title={model.name}>
                    {model.id}
                  </span>
                  {model.contextWindow ? (
                    <span className="w-14 shrink-0 text-right tabular-nums text-foreground-subtlest">{Math.round(model.contextWindow / 1000)}k</span>
                  ) : null}
                  {inList ? <span className="w-16 shrink-0 text-[#7cc45a]">in list ✓</span> : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-5 px-1"
                    disabled={!routerProvider || adding === model.id || inList}
                    onClick={() => void add(model, false)}
                  >
                    Add
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-5 px-1"
                    disabled={!routerProvider || adding === model.id}
                    onClick={() => void add(model, true)}
                    title="Add it and make it the default for new sessions (START)"
                  >
                    Use
                  </Button>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );
}
