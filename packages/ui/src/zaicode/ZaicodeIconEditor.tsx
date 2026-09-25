import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  ZAICODE_ICON_SLOT_IDS,
  ZaicodeIcon,
  resetZaicodeIconOverrides,
  setZaicodeIconOverride,
  useZaicodeIconOverrides,
} from "./zaicodeIconSlots.js";

/** Inline editor for every icon slot; each change applies live. */
export function ZaicodeIconEditor({ onClose }: { onClose: () => void }) {
  const { intl } = useZCodeIntl();
  const overrides = useZaicodeIconOverrides();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <span className="text-ui-xs font-medium uppercase tracking-wide text-foreground-subtle">
          {intl.formatMessage({ id: "zaicode.icons.title" })}
        </span>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={resetZaicodeIconOverrides}>
            {intl.formatMessage({ id: "zaicode.icons.reset" })}
          </Button>
          <Button size="sm" variant="outline" onClick={onClose}>
            {intl.formatMessage({ id: "zaicode.action.close" })}
          </Button>
        </div>
      </div>
      <p className="shrink-0 px-3 pt-2 text-ui-xs text-foreground-subtlest">
        {intl.formatMessage({ id: "zaicode.icons.hint" })}
      </p>
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-3">
        {ZAICODE_ICON_SLOT_IDS.map((slot) => (
          <label key={slot} className="flex items-center gap-2">
            <ZaicodeIcon slot={slot} />
            <span className="w-32 shrink-0 truncate text-ui-xs text-foreground-subtle">{slot}</span>
            <Input
              value={overrides[slot] ?? ""}
              placeholder={intl.formatMessage({ id: "zaicode.icons.placeholder" })}
              onChange={(event) => setZaicodeIconOverride(slot, event.target.value)}
            />
          </label>
        ))}
      </div>
    </div>
  );
}
