import { useState } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SaiasuiSettingsPanel } from "./SaiasuiSettingsPanel.js";
import { useSaiasui } from "./saiasuiStore.js";

export function SaiasuiSettings() {
  const { intl } = useZCodeIntl();
  const { config, configure, applyPreset, resetAll, best } = useSaiasui();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  return (
    <section
      className="border border-border bg-card p-4 text-ui-base"
      data-zaicode-saiasui-settings
    >
      <h2 className="text-ui-lg">SAIASUI!</h2>
      <p className="my-2 text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "saiasui.intro" })}
      </p>
      <SaiasuiSettingsPanel
        config={config}
        onChange={configure}
        onPreset={applyPreset}
        onReset={resetAll}
        open={open}
        onToggle={(id, next) => setOpen((prev) => ({ ...prev, [id]: next }))}
      />
      <p className="mt-3 text-ui-sm">
        {intl.formatMessage(
          { id: "saiasui.records" },
          {
            mode: config.pacing,
            score: best[config.pacing].score.toLocaleString(),
            combo: best[config.pacing].combo,
          },
        )}
      </p>
    </section>
  );
}
