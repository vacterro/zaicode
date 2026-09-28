import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useSaiasui } from "./saiasuiStore.js";

export function SaiasuiSettings() {
  const { intl } = useZCodeIntl();
  const { settings, configure, best } = useSaiasui();
  return (
    <section
      className="border border-border bg-card p-4 text-ui-base"
      data-zaicode-saiasui-settings
    >
      <h2 className="text-ui-lg">SAIASUI!</h2>
      <p className="my-2 text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "saiasui.intro" })}
      </p>
      <label className="my-2 flex items-center justify-between gap-3">
        <span>{intl.formatMessage({ id: "saiasui.enable" })}</span>
        <Switch checked={settings.enabled} onCheckedChange={(enabled) => configure({ enabled })} />
      </label>
      <label className="my-2 flex items-center justify-between gap-3">
        <span>{intl.formatMessage({ id: "saiasui.sound" })}</span>
        <Switch checked={settings.sound} onCheckedChange={(sound) => configure({ sound })} />
      </label>
      <label className="my-2 flex items-center justify-between gap-3">
        <span>{intl.formatMessage({ id: "saiasui.tempo" })}</span>
        <select
          className="border border-border bg-input px-2 text-ui-base"
          value={settings.pacing}
          onChange={(event) =>
            configure({ pacing: event.target.value === "step" ? "step" : "linear" })
          }
        >
          <option value="linear">{intl.formatMessage({ id: "saiasui.linear" })}</option>
          <option value="step">{intl.formatMessage({ id: "saiasui.step" })}</option>
        </select>
      </label>
      <p className="text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "saiasui.rules" })}
      </p>
      <p className="mt-2 text-ui-sm">
        {intl.formatMessage(
          { id: "saiasui.records" },
          {
            mode: settings.pacing,
            score: best[settings.pacing].score.toLocaleString(),
            combo: best[settings.pacing].combo,
          },
        )}
      </p>
    </section>
  );
}
