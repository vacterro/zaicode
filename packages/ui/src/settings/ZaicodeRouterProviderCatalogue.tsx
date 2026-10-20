import { useEffect } from "react";
import { UnifiedBrowserView } from "@/browser-use/UnifiedBrowserView.js";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { logger } from "@/logger.js";
import { getZaicodeRouterBridge, useZaicodeRouter, zaicodeRouterCatalogueUrl } from "@/zaicode/zaicodeRouter.js";
import { useZaicodeRouterSetup } from "@/zaicode/zaicodeRouterSetup.js";
import { refreshZaicodeSubscriptionReadiness, syncZaicodeSubscriptionModels } from "@/zaicode/zaicodeSubscriptionSync.js";

/** The connected router owns its complete catalogue and authentication flows. */
export function ZaicodeRouterProviderCatalogue() {
  const platform = usePlatform();
  const info = useZaicodeRouter((state) => state.info);
  const effectiveUrl = useZaicodeRouterSetup((state) => state.host?.effectiveUrl);
  const refresh = useZaicodeRouter((state) => state.refresh);
  // 首选路由故障时，目录必须使用 Host 已接管的实际端点。
  const endpoint = (effectiveUrl || info?.url || "").trim() || null;
  const url = zaicodeRouterCatalogueUrl(effectiveUrl, info?.url);

  useEffect(() => {
    if (!url) return;
    let busy = false;
    const read = async () => {
      if (busy) return;
      busy = true;
      try {
        await refresh();
        await syncZaicodeSubscriptionModels();
        await refreshZaicodeSubscriptionReadiness();
      } catch (error) {
        logger.warn("[zaicode] Router catalogue refresh failed", { error: String(error) });
      } finally { busy = false; }
    };
    const timer = window.setInterval(() => { void read(); }, 10000);
    return () => window.clearInterval(timer);
  }, [refresh, url]);

  if (!url) return <p className="text-foreground-subtle">Waiting for the connected router…</p>;
  return (
    <section className="flex min-w-0 flex-col gap-2" data-zaicode-provider-catalogue>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-ui-lg text-foreground">Connect a provider</h3>
        <Button size="sm" variant="outline" onClick={() => {
          void refresh().then(() => syncZaicodeSubscriptionModels({ force: true }))
            .then(() => refreshZaicodeSubscriptionReadiness({ force: true }))
            .catch((error) => logger.warn("[zaicode] Router catalogue refresh failed", { error: String(error) }));
        }}>Refresh connected accounts</Button>
      </div>
      <p className="text-foreground-subtle">Choose a provider below to add an API key, sign in, or edit its connections.</p>
      <div className="h-[min(70vh,800px)] min-h-[360px] min-w-0 overflow-hidden border border-border">
        {platform.browserViewAttachGuest ? (
          <UnifiedBrowserView key={url} browserKey={`zaicode-router-providers:${endpoint}`} initialUrl={url} isVisible />
        ) : (
          <div className="flex h-full w-full flex-col">
            <p className="px-2 py-1 text-foreground-subtle">
              Embedded browsing is unavailable here, so the catalogue may not render inside this frame. Use the button below for the router&apos;s own page.
            </p>
            <iframe title="9router provider catalogue" src={url} className="min-h-0 flex-1 border-0" />
            <div className="p-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void getZaicodeRouterBridge()?.openZaicodeRouterDashboard?.("providers").then((report) => {
                    if (!report || !report.ok) toast("Could not open the router page: " + (report?.message ?? "no desktop bridge"));
                  });
                }}
              >
                Open provider catalogue in browser
              </Button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
