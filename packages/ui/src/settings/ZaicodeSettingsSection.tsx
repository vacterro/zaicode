import { ZaicodeDelegationSettings } from "./ZaicodeDelegationSettings.js";
import { useEffect, useState } from "react";
import { getZaicodeProductMetadata, type ZaicodeAgentTemplate } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { resolveZaicodeServices } from "@/zaicode/zaicodeServices.js";
import { Switch } from "@/components/ui/switch.js";
import { ZaicodeTypographySettings } from "./ZaicodeTypographySettings.js";
import { ZaicodeSaimailSettings } from "./ZaicodeSaimailSettings.js";
import { setZaicodeAutoSessionTitle, useZaicodeAutoSessionTitle } from "@/zaicode/zaicodeAutoTitle.js";
import { setZaicodeListLabelWidth, useZaicodeAppearance } from "@/zaicode/zaicodeAppearance.js";
import { captureZaicodeSettingsSnapshot } from "@/zaicode/zaicodeSettingsSnapshot.js";

const CAPABILITY_IDS = [
  "accountFreeWorkspace",
  "agentDefinitions",
  "jobQueue",
  "boundedOrchestration",
] as const;

/** 设置页 ZAICODE 分区：产品身份、能力边界、模板与并发配置。 */
export function ZaicodeSettingsSection() {
  const { intl } = useZCodeIntl();
  const accessor = useBaseWorkspaceServices();
  const platform = usePlatform();
  const services = resolveZaicodeServices(accessor);
  const product = getZaicodeProductMetadata();
  const [templates, setTemplates] = useState<ZaicodeAgentTemplate[]>([]);
  const [agentCount, setAgentCount] = useState(0);
  const [maxConcurrency, setMaxConcurrency] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRestartOnCrash, setAutoRestartOnCrash] = useState(true);
  const [restartBusy, setRestartBusy] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveResult, setSaveResult] = useState<string | null>(null);
  const autoSessionTitle = useZaicodeAutoSessionTitle();
  const { listLabelWidth } = useZaicodeAppearance();

  useEffect(() => {
    void platform
      .getZaicodeLauncherPreferences?.()
      .then((preferences) => {
        setAutoRestartOnCrash(preferences.autoRestartOnCrash);
      })
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : String(caught));
      });
  }, [platform]);

  useEffect(() => {
    if (!services) return;
    let disposed = false;
    void (async () => {
      try {
        const [agentList, templateList, concurrency] = await Promise.all([
          services.agents.list(),
          services.agents.listTemplates(),
          services.jobs.getMaxConcurrency(),
        ]);
        if (disposed) return;
        setAgentCount(agentList.agents.length);
        setTemplates(templateList);
        setMaxConcurrency(concurrency);
      } catch (caught) {
        if (!disposed) setError(caught instanceof Error ? caught.message : String(caught));
      }
    })();
    return () => {
      disposed = true;
    };
  }, [services]);

  if (!services) {
    return (
      <p className="text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "zaicode.unavailable" })}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="border border-border bg-card p-4" data-zaicode-save-settings>
        <h2 className="text-ui-lg text-foreground">Release defaults</h2>
        <p className="mt-1 text-ui-xs text-foreground-subtle">
          Save all ZAICODE preferences as defaults for the next build. Existing local choices keep priority.
        </p>
        <Button
          className="mt-2"
          size="sm"
          variant="outline"
          disabled={saveBusy || !platform.saveZaicodeSettingsSnapshot}
          onClick={() => {
            setSaveBusy(true);
            setSaveResult(null);
            void captureZaicodeSettingsSnapshot()
              .then((json) => platform.saveZaicodeSettingsSnapshot!(json))
              .then((result) => setSaveResult(result.message))
              .catch((caught: unknown) => setSaveResult(caught instanceof Error ? caught.message : String(caught)))
              .finally(() => setSaveBusy(false));
          }}
        >
          {saveBusy ? "Saving…" : "Save all settings"}
        </Button>
        {saveResult ? <p className="mt-2 text-ui-xs text-foreground-subtle" role="status">{saveResult}</p> : null}
      </section>
      <ZaicodeTypographySettings />
      <ZaicodeSaimailSettings />
      <section className="border border-border bg-card p-4 text-ui-xs text-foreground-subtle" data-zaicode-moved-settings>
        Sidebar layout, the home screen and window zones are in <strong className="font-normal text-foreground">Layout &amp; home</strong>;
        Ambience and Problip in <strong className="font-normal text-foreground">Sounds</strong>; the terminal font in{" "}
        <strong className="font-normal text-foreground">Workers &amp; terminal</strong>.
      </section>
      <section className="border border-border bg-card p-4">
        <label className="flex flex-col gap-2 text-ui-xs text-foreground">
          <span>{intl.formatMessage({ id: "zaicode.settings.listLabelWidth" }, { width: listLabelWidth })}</span>
          <input
            type="range"
            min="64"
            max="220"
            step="4"
            value={listLabelWidth}
            onChange={(event) => setZaicodeListLabelWidth(Number(event.target.value))}
          />
        </label>
      </section>
      <section className="border border-border bg-card p-4">
        <label className="flex items-center justify-between gap-3">
          <span className="flex flex-col gap-1">
            <span className="text-ui-base text-foreground">
              {intl.formatMessage({ id: "zaicode.settings.autoSessionTitle" })}
            </span>
            <span className="text-ui-xs text-foreground-subtle">
              {intl.formatMessage({ id: "zaicode.settings.autoSessionTitleHint" })}
            </span>
          </span>
          <Switch checked={autoSessionTitle} onCheckedChange={setZaicodeAutoSessionTitle} />
        </label>
      </section>
      <section className="rounded-xl border border-border bg-card p-4">
        <label className="flex items-center justify-between gap-3">
          <span className="flex flex-col gap-1">
            <span className="text-ui-base text-foreground">
              {intl.formatMessage({ id: "zaicode.settings.autoRestart" })}
            </span>
            <span className="text-ui-xs text-foreground-subtle">
              {intl.formatMessage({ id: "zaicode.settings.autoRestartHint" })}
            </span>
          </span>
          <Switch
            checked={autoRestartOnCrash}
            disabled={restartBusy || !platform.setZaicodeAutoRestartOnCrash}
            onCheckedChange={(enabled) => {
              setRestartBusy(true);
              void platform
                .setZaicodeAutoRestartOnCrash?.(enabled)
                .then((preferences) => setAutoRestartOnCrash(preferences.autoRestartOnCrash))
                .catch((caught: unknown) =>
                  setError(caught instanceof Error ? caught.message : String(caught)),
                )
                .finally(() => setRestartBusy(false));
            }}
          />
        </label>
      </section>

      <section className="rounded-xl border border-border bg-card p-4">
        <h2 className="text-ui-lg text-foreground">
          {intl.formatMessage({ id: "zaicode.settings.productTitle" })}
        </h2>
        <p className="mt-1 text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "zaicode.settings.productDescription" })}
        </p>
        <dl className="mt-3 grid grid-cols-2 gap-2">
          <div>
            <dt className="text-ui-xs text-foreground-subtle">
              {intl.formatMessage({ id: "zaicode.settings.productName" })}
            </dt>
            <dd className="text-ui-base text-foreground">{product.displayName}</dd>
          </div>
          <div>
            <dt className="text-ui-xs text-foreground-subtle">
              {intl.formatMessage({ id: "zaicode.settings.upstream" })}
            </dt>
            <dd className="text-ui-base text-foreground">{product.upstream.displayName}</dd>
          </div>
        </dl>
        <ul className="mt-3 flex flex-col gap-1">
          {CAPABILITY_IDS.map((capability) => (
            <li key={capability} className="text-ui-xs text-foreground-subtle">
              {intl.formatMessage(
                { id: `zaicode.settings.capability.${capability}` },
                { enabled: product.capabilities[capability] ? "✓" : "—" },
              )}
            </li>
          ))}
        </ul>
      </section>

      <ZaicodeDelegationSettings services={services} />

      <section className="rounded-xl border border-border bg-card p-4">
        <h2 className="text-ui-lg text-foreground">
          {intl.formatMessage({ id: "zaicode.settings.concurrencyTitle" })}
        </h2>
        <p className="mt-1 text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "zaicode.settings.concurrencyDescription" })}
        </p>
        <div className="mt-3 flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void services.jobs
                .setMaxConcurrency(maxConcurrency - 1)
                .then(setMaxConcurrency)
                .catch((caught: unknown) =>
                  setError(caught instanceof Error ? caught.message : String(caught)),
                )
                .finally(() => setBusy(false));
            }}
          >
            −
          </Button>
          <span className="text-ui-base text-foreground">{maxConcurrency}</span>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void services.jobs
                .setMaxConcurrency(maxConcurrency + 1)
                .then(setMaxConcurrency)
                .catch((caught: unknown) =>
                  setError(caught instanceof Error ? caught.message : String(caught)),
                )
                .finally(() => setBusy(false));
            }}
          >
            +
          </Button>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-4">
        <h2 className="text-ui-lg text-foreground">
          {intl.formatMessage({ id: "zaicode.settings.templatesTitle" })}
        </h2>
        <p className="mt-1 text-ui-base text-foreground-subtle">
          {intl.formatMessage(
            { id: "zaicode.settings.templatesDescription" },
            { count: agentCount },
          )}
        </p>
        <div className="mt-3 flex flex-col gap-2">
          {templates.map((template) => (
            <div
              key={template.id}
              className="flex items-start justify-between gap-3 rounded-lg border border-border px-3 py-2"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-ui-base text-foreground">{template.name}</span>
                  <span className="text-ui-xs text-foreground-subtle">{template.role}</span>
                </div>
                <p className="text-ui-xs text-foreground-subtle">{template.description}</p>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void services.agents
                    .createFromTemplate(template.id)
                    .then(() => setAgentCount((count) => count + 1))
                    .catch((caught: unknown) =>
                      setError(caught instanceof Error ? caught.message : String(caught)),
                    )
                    .finally(() => setBusy(false));
                }}
              >
                {intl.formatMessage({ id: "zaicode.action.create" })}
              </Button>
            </div>
          ))}
        </div>
        <p className="mt-3 text-ui-xs text-foreground-subtlest">
          {intl.formatMessage({ id: "zaicode.settings.manageHint" })}
        </p>
      </section>

      {error ? <p className="text-ui-xs text-destructive">{error}</p> : null}
    </div>
  );
}
